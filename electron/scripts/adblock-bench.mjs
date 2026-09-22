/**
 * adblock-bench.mjs — engine-level performance benchmark for the native ad blocker.
 *
 * Measures, on this Linux box (no display needed):
 *  - filter-list download + parse time, rule counts, engine memory
 *  - per-request `match()` latency over a synthetic but realistic request
 *    set (a YouTube watch page + a news article page), blocker ON vs OFF
 *  - cosmetic/scriptlet assembly time for a YouTube page (document_start cost)
 *  - old 2-list set (EasyList + uBO filters) vs new fullLists set
 *
 * What this does NOT measure: the Electron webRequest IPC hop between the
 * network service and the main process — that needs a real Electron run
 * (user's Mac). The numbers below are the engine decision cost, which is
 * the part this phase changed.
 *
 * Run: node scripts/adblock-bench.mjs   (from electron/; needs network)
 */

import { fullLists } from '@ghostery/adblocker';
import { FiltersEngine, Request } from '@ghostery/adblocker';

const ASSETS = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';
const OLD_LISTS = [`${ASSETS}/easylist/easylist.txt`, `${ASSETS}/ublock-origin/filters.txt`];
const RESOURCES_URL = `${ASSETS}/ublock-origin/resources.json`;

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.text();
}

const fmt = (n, d = 2) => n.toFixed(d);
const memMB = () => (process.memoryUsage().heapUsed / 1048576).toFixed(1);

// --- synthetic request sets -------------------------------------------------
// A YouTube watch page: video chunks, thumbnails, player API, ads, trackers.
function youtubeRequests() {
  const reqs = [];
  const push = (url, type, sourceUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') =>
    reqs.push({ url, type, sourceUrl });
  for (let i = 0; i < 40; i++)
    push(`https://rr${i % 5}.---sn-abc123.googlevideo.com/videoplayback?expire=1&id=${i}&itag=22`, 'xhr');
  for (let i = 0; i < 15; i++) push(`https://i.ytimg.com/vi/vid${i}/hqdefault.jpg`, 'image');
  for (let i = 0; i < 10; i++) push(`https://www.youtube.com/youtubei/v1/player?key=k${i}`, 'xhr');
  for (let i = 0; i < 8; i++) push(`https://www.youtube.com/s/player/abcd${i}/player-plasma-ias-phone-en_US.vflset/base.js`, 'script');
  push('https://www.youtube.com/pagead/adview', 'script');
  push('https://googleads.g.doubleclick.net/pagead/id', 'script');
  push('https://static.doubleclick.net/instream/ad_status.js', 'script');
  push('https://www.youtube.com/ptracking', 'ping');
  push('https://www.youtube.com/api/stats/ads', 'ping');
  push('https://www.google-analytics.com/analytics.js', 'script');
  push('https://fonts.googleapis.com/css2?family=Roboto', 'stylesheet');
  push('https://www.youtube.com/generate_204', 'other');
  push('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'main_frame', '');
  return reqs;
}

// A news article page: CDN, ads, trackers, social widgets.
function newsRequests() {
  const reqs = [];
  const src = 'https://news.example.org/world/election-results';
  const push = (url, type, sourceUrl = src) => reqs.push({ url, type, sourceUrl });
  push(src, 'main_frame', '');
  for (let i = 0; i < 20; i++) push(`https://cdn.example.org/img/photo${i}.jpg`, 'image');
  for (let i = 0; i < 6; i++) push(`https://cdn.example.org/static/app${i}.js`, 'script');
  push('https://cdn.example.org/static/main.css', 'stylesheet');
  push('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script');
  push('https://tpc.googlesyndication.com/sodar/sodar2.js', 'script');
  push('https://www.googletagmanager.com/gtag/js?id=G-X', 'script');
  push('https://www.google-analytics.com/g/collect', 'ping');
  push('https://connect.facebook.net/en_US/sdk.js', 'script');
  push('https://platform.twitter.com/widgets.js', 'script');
  push('https://c.amazon-adsystem.com/aax2/apstag.js', 'script');
  push('https://sb.scorecardresearch.com/beacon.js', 'script');
  push('https://news.example.org/api/comments', 'xhr');
  return reqs;
}

function benchMatch(engine, reqs, label) {
  // warmup
  for (let w = 0; w < 3; w++)
    for (const r of reqs)
      engine.match(Request.fromRawDetails({ ...r, requestId: 'w', tabId: 1 }));
  const N = 20;
  const t0 = process.hrtime.bigint();
  let blocked = 0;
  for (let i = 0; i < N; i++)
    for (const r of reqs) {
      if (engine.match(Request.fromRawDetails({ ...r, requestId: `${i}`, tabId: 1 })).match) blocked++;
    }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const perReqUs = (totalMs * 1000) / (N * reqs.length);
  console.log(
    `  ${label}: ${reqs.length} req/page, ${fmt(perReqUs, 3)} µs/req, ` +
      `${fmt((totalMs / N), 2)} ms/page-load, blocked ${blocked / N}/page`,
  );
  return perReqUs;
}

function benchOff(reqs) {
  // "blocker off": same loop, no engine call — measures loop overhead only.
  const N = 20;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++)
    for (const r of reqs) {
      void r.url.length;
    }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const perReqUs = (totalMs * 1000) / (N * reqs.length);
  console.log(`  blocker OFF (no-op loop): ${fmt(perReqUs, 3)} µs/req`);
  return perReqUs;
}

function benchCosmetics(engine, label, url, hostname, domain) {
  const t0 = process.hrtime.bigint();
  const N = 50;
  for (let i = 0; i < N; i++)
    engine.getCosmeticsFilters({
      url, hostname, domain,
      getBaseRules: true, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: true,
    });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  const cos = engine.getCosmeticsFilters({
    url, hostname, domain,
    getBaseRules: true, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: true,
  });
  console.log(
    `  ${label}: ${fmt(ms, 2)} ms/page (styles ${cos.styles.length} chars, ${cos.scripts.length} scriptlets)`,
  );
}

// --- main -------------------------------------------------------------------
console.log('== Next Token adblock benchmark (engine-level, Linux) ==\n');

console.log('-- download --');
let t0 = process.hrtime.bigint();
const fullTexts = await Promise.all(fullLists.map(get));
const oldTexts = await Promise.all(OLD_LISTS.map(get));
const resourcesText = await get(RESOURCES_URL);
console.log(`  fetched ${fullLists.length} lists (${(fullTexts.join('').length / 1048576).toFixed(1)} MB) in ${fmt(Number(process.hrtime.bigint() - t0) / 1e9, 1)}s`);

console.log('\n-- parse --');
t0 = process.hrtime.bigint();
const full = FiltersEngine.parse(fullTexts.join('\n'), {});
const fullParseMs = Number(process.hrtime.bigint() - t0) / 1e6;
full.updateResources(resourcesText, `${resourcesText.length}`);
t0 = process.hrtime.bigint();
const old = FiltersEngine.parse(oldTexts.join('\n'), {});
const oldParseMs = Number(process.hrtime.bigint() - t0) / 1e6;
const ff = full.getFilters();
const of = old.getFilters();
console.log(`  fullLists: ${fmt(fullParseMs, 0)} ms, network ${ff.networkFilters.length.toLocaleString('en-US')}, cosmetic ${ff.cosmeticFilters.length.toLocaleString('en-US')}, heap +${memMB()} MB`);
console.log(`  old 2-list: ${fmt(oldParseMs, 0)} ms, network ${of.networkFilters.length.toLocaleString('en-US')}, cosmetic ${of.cosmeticFilters.length.toLocaleString('en-US')}`);

const yt = youtubeRequests();
const news = newsRequests();

console.log('\n-- match() latency: blocker ON (fullLists) --');
benchMatch(full, yt, 'YouTube watch page');
benchMatch(full, news, 'news article page');

console.log('\n-- match() latency: blocker ON (old 2-list set, for comparison) --');
benchMatch(old, yt, 'YouTube watch page');
benchMatch(old, news, 'news article page');

console.log('\n-- blocker OFF baseline --');
benchOff(yt);

console.log('\n-- cosmetic + scriptlet assembly (document_start cost) --');
benchCosmetics(full, 'youtube.com', 'https://www.youtube.com/watch?v=x', 'www.youtube.com', 'youtube.com');
benchCosmetics(old, 'youtube.com [old 2-list]', 'https://www.youtube.com/watch?v=x', 'www.youtube.com', 'youtube.com');

console.log('\nDone. Note: engine decision cost only; the Electron webRequest');
console.log('IPC hop on top is unchanged by this phase and needs a real run.');
