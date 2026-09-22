/**
 * adblock-test.mjs — regression tests for the native ad blocker.
 *
 * Covers the Electron-free core (src/main/adblock/filtering.ts, bundled
 * with esbuild) plus engine-level behavior of @ghostery/adblocker using
 * small inline fixtures. Fully offline — safe for CI / Linux, no Mac,
 * no browser, no network.
 *
 * Run: node scripts/adblock-test.mjs   (from electron/)
 */

import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(here, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-adblock-test-'));
const bundle = path.join(tmpDir, 'filtering.mjs');

execFileSync(
  path.join(electronDir, 'node_modules', '.bin', 'esbuild'),
  [
    path.join('src', 'main', 'adblock', 'filtering.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${bundle}`,
  ],
  { cwd: electronDir, stdio: 'pipe' },
);

const filtering = await import(pathToFileURL(bundle).href);
const { FiltersEngine, Request } = await import('@ghostery/adblocker');
const { fromElectronDetails } = await import('@ghostery/adblocker-electron');

const {
  FILTER_LIST_URLS,
  EMPTY_RESOURCES_JSON,
  FilterListsUnavailableError,
  hostOf,
  isPageProtected,
  makeResilientFetch,
  describeEngineStatus,
} = filtering;

// ---------------------------------------------------------------------------
// 1. Filter list set — the YouTube-critical lists must be present
// ---------------------------------------------------------------------------

test('list set: uBO-parity coverage (quick-fixes, privacy, unbreak, peter-lowe)', () => {
  const names = FILTER_LIST_URLS.map((u) => u.split('/').pop());
  assert.ok(FILTER_LIST_URLS.length >= 15, `expected >=15 lists, got ${FILTER_LIST_URLS.length}`);
  for (const need of [
    'quick-fixes.txt', // YouTube rapid-response counter-measures
    'easyprivacy.txt',
    'unbreak.txt',
    'serverlist.txt', // Peter Lowe's
    'privacy.txt',
    'easylist.txt',
    'filters.txt',
  ]) {
    assert.ok(names.includes(need), `missing required list: ${need}`);
  }
  const prefixes = new Set(FILTER_LIST_URLS.map((u) => u.split('/assets/')[0]));
  assert.equal(prefixes.size, 1, 'all lists should come from one asset mirror');
});

test('list set: empty resources fallback is a valid (empty) distribution', () => {
  const j = JSON.parse(EMPTY_RESOURCES_JSON);
  assert.ok(Array.isArray(j.scriptlets) && Array.isArray(j.redirects));
});

// ---------------------------------------------------------------------------
// 2. hostOf / isPageProtected
// ---------------------------------------------------------------------------

test('hostOf: normalization and garbage', () => {
  assert.equal(hostOf('https://WWW.Example.com:443/x?q=1'), 'www.example.com');
  assert.equal(hostOf('http://user:pass@sub.example.co.uk/'), 'sub.example.co.uk');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(''), '');
});

test('isPageProtected: global + per-site matrix', () => {
  const allow = ['example.com'];
  assert.equal(isPageProtected('https://news.example.org/a', true, allow), true);
  assert.equal(isPageProtected('https://example.com/a', true, allow), false);
  // Exact-host match: subdomains of an allowlisted host stay protected.
  assert.equal(isPageProtected('https://ads.example.com/a', true, allow), true);
  assert.equal(isPageProtected('https://news.example.org/a', false, allow), false);
  assert.equal(isPageProtected(undefined, true, allow), true);
  assert.equal(isPageProtected('not a url', true, allow), true);
});

test('describeEngineStatus: readable summary', () => {
  const s = describeEngineStatus(190685, 17, 17, Date.now() - 30 * 60000);
  assert.match(s, /190,685 filter rules/);
  assert.match(s, /17\/17 lists/);
  assert.match(s, /30m ago/);
  assert.equal(describeEngineStatus(0, 0, 17, null), 'filter lists not loaded yet');
});

// ---------------------------------------------------------------------------
// 3. Resilient fetch — one dead list must not kill the engine build
// ---------------------------------------------------------------------------

const okResp = (text) => new Response(text, { status: 200 });
const failResp = (status) => new Response('nope', { status });

test('makeResilientFetch: single list failure degrades to empty list', async () => {
  const urls = ['https://x.test/a.txt', 'https://x.test/b.txt'];
  const seen = [];
  const wrapped = makeResilientFetch(
    async (u) => (u.endsWith('a.txt') ? okResp('||ads.example^') : failResp(404)),
    urls,
    { onListFailed: (u) => seen.push(u) },
  );
  assert.equal(await (await wrapped(urls[0])).text(), '||ads.example^');
  assert.equal(await (await wrapped(urls[1])).text(), '');
  assert.deepEqual(seen, ['https://x.test/b.txt']);
});

test('makeResilientFetch: all lists failing throws (fail-open, not zero-rule)', async () => {
  const urls = ['https://x.test/a.txt', 'https://x.test/b.txt'];
  const wrapped = makeResilientFetch(async () => failResp(500), urls);
  // fetchLists() calls the wrapper once per URL; the LAST failure throws.
  await assert.rejects(
    Promise.all(urls.map((u) => wrapped(u).then((r) => r.text()))),
    FilterListsUnavailableError,
  );
});

test('makeResilientFetch: resources.json failure degrades to empty distribution', async () => {
  const wrapped = makeResilientFetch(async () => {
    throw new Error('boom');
  }, []);
  const res = await wrapped('https://m.test/ublock-origin/resources.json');
  const j = JSON.parse(await res.text());
  assert.ok(Array.isArray(j.scriptlets) && Array.isArray(j.redirects));
});

test('makeResilientFetch: network throw on a list degrades too', async () => {
  const urls = ['https://x.test/only.txt'];
  let failed = 0;
  const wrapped = makeResilientFetch(
    async () => {
      throw new Error('dns');
    },
    urls,
    { onListFailed: () => failed++ },
  );
  await assert.rejects(() => wrapped(urls[0]), FilterListsUnavailableError);
  assert.equal(failed, 1);
});

// ---------------------------------------------------------------------------
// 4. Engine behavior on inline fixtures (offline, deterministic)
// ---------------------------------------------------------------------------

const NETWORK_FIXTURE = [
  '||pagead2.googlesyndication.com^$third-party',
  '||google-analytics.com^',
  '||youtube.com/pagead/*',
  '||evil.example^$websocket',
  '@@||cdn.example.com^$script', // exception: never block this CDN
].join('\n');

const COSMETIC_FIXTURE = [
  'youtube.com##.yt-ad-slot-to-hide',
  '##div[data-ad-slot]',
].join('\n');

const SCRIPTLET_FIXTURE = 'youtube.com##+js(set, playerConfig.adsEnabled, false)';

const STUB_RESOURCES = JSON.stringify({
  scriptlets: [
    {
      // resources.json convention: scriptlet names end with `.js`
      // (getRawScriptlet looks up `${name}.js`).
      name: 'set.js',
      aliases: [],
      body: 'function set(a1, a2) { /* stub: would set window prop */ }',
      dependencies: [],
    },
  ],
  redirects: [],
});

function engineFrom(text, resources) {
  const e = FiltersEngine.parse(text, {});
  if (resources) e.updateResources(resources, 'test');
  return e;
}

function match(engine, url, type = 'script', sourceUrl = 'https://news.example.org/') {
  const req = Request.fromRawDetails({ url, type, sourceUrl, requestId: 't1', tabId: 7 });
  return engine.match(req).match;
}

test('engine: known ad/tracker URLs blocked, first-party allowed', () => {
  const e = engineFrom(NETWORK_FIXTURE);
  assert.equal(match(e, 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'), true);
  assert.equal(match(e, 'https://www.google-analytics.com/analytics.js'), true);
  assert.equal(match(e, 'https://www.youtube.com/pagead/adview'), true);
  assert.equal(match(e, 'https://news.example.org/article.js'), false);
  assert.equal(match(e, 'https://i.ytimg.com/vi/abc/hqdefault.jpg', 'image'), false);
  assert.equal(match(e, 'https://cdn.example.com/lib.js'), false, 'exception rule must win');
});

test('engine: websocket request type is handled', () => {
  const e = engineFrom(NETWORK_FIXTURE);
  assert.equal(match(e, 'wss://evil.example/socket', 'websocket'), true);
  assert.equal(match(e, 'wss://chat.example.org/socket', 'websocket'), false);
});

test('engine: cosmetic filters hide YouTube ad slots only where they apply', () => {
  const e = engineFrom(COSMETIC_FIXTURE);
  const yt = e.getCosmeticsFilters({
    url: 'https://www.youtube.com/watch?v=x',
    hostname: 'www.youtube.com',
    domain: 'youtube.com',
    getBaseRules: true,
    getInjectionRules: false,
    getExtendedRules: false,
    getRulesFromHostname: true,
  });
  assert.ok(yt.styles.includes('.yt-ad-slot-to-hide'), 'youtube-specific selector present');
  assert.ok(yt.styles.includes('div[data-ad-slot]'), 'generic selector present via base stylesheet');
  const other = e.getCosmeticsFilters({
    url: 'https://news.example.org/',
    hostname: 'news.example.org',
    domain: 'example.org',
    getBaseRules: true,
    getInjectionRules: false,
    getExtendedRules: false,
    getRulesFromHostname: true,
  });
  assert.ok(!other.styles.includes('.yt-ad-slot-to-hide'), 'youtube selector must not leak');
});

test('engine: scriptlet injection rules resolve against resources', () => {
  const e = engineFrom(SCRIPTLET_FIXTURE, STUB_RESOURCES);
  const cos = e.getCosmeticsFilters({
    url: 'https://www.youtube.com/watch?v=x',
    hostname: 'www.youtube.com',
    domain: 'youtube.com',
    getBaseRules: true,
    getInjectionRules: true,
    getExtendedRules: false,
    getRulesFromHostname: true,
  });
  assert.equal(cos.scripts.length, 1, 'scriptlet should assemble exactly one script');
  // The engine escapes arg dots (decoded at runtime via decodeURIComponent).
  assert.ok(cos.scripts[0].includes('playerConfig'), 'scriptlet args must be injected');
});

test('fromElectronDetails: websocket resourceType maps to engine websocket type', () => {
  const req = fromElectronDetails({
    id: 1,
    url: 'wss://evil.example/socket',
    resourceType: 'websocket',
    referrer: 'https://evil.example/',
    webContentsId: 42,
  });
  assert.equal(req.type, 'websocket');
  assert.equal(req.tabId, 42);
  const e = engineFrom(NETWORK_FIXTURE);
  assert.equal(e.match(req).match, true);
});

test('fromElectronDetails: missing resourceType falls back to other', () => {
  const req = fromElectronDetails({
    id: 2,
    url: 'https://news.example.org/pixel',
    referrer: 'https://news.example.org/',
    webContentsId: 42,
  });
  assert.equal(req.type, 'other');
});
