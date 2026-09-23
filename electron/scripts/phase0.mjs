/**
 * Phase 0 — verify-before-build probes, run against the INSTALLED app on macOS.
 *
 * Checks (parity with the builder prompt):
 *   0.1 omnibox search suggestions: dropdown appears, suggest requests leave
 *       the machine (observed on the shell renderer's network).
 *   0.2 tab loading indicator: the exact tab's sidebar row shows the
 *       favicon-slot shimmer while a deliberately slow page loads, and
 *       clears once the page finishes.
 *   0.3 session persistence: cookie + localStorage set in the guest
 *       (persist:nexttoken) survive a full quit + relaunch.
 *   0.4 password save prompt → Save → revisit → Fill chip → field filled.
 *
 * Targeting rules (the v1 harness got these wrong):
 *   - The omnibox input only exists while focused; it is matched by
 *     aria-label, NOT placeholder ("Ask anything" also matches the
 *     new-tab hero and the agent panel inputs).
 *   - The loading shimmer is asserted on the specific tab's row
 *     ([data-tab-row="<id>"]), never "any shimmer anywhere" — restored
 *     background tabs can legitimately still be loading.
 *   - Guest-page code runs inside the URL-matched <webview> only.
 *
 * Runs a local HTTP fixture server (127.0.0.1:8917). Leaves no test tab or
 * test password behind (only when 0.3 passes — otherwise the evidence is
 * kept for debugging). Usage: node scripts/phase0.mjs
 */
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import { execSync } from 'node:child_process';

/**
 * App under test: the installed app by default. Set PHASE0_APP to point at
 * an unpacked build (e.g. release/mac-arm64/Next Token.app) to verify a fix
 * before replacing /Applications. Both share com.nexttoken.app, hence the
 * same persist:nexttoken profile — same as a real update.
 */
const APP_PATH = process.env.PHASE0_APP || '/Applications/Next Token .app';
const APP_BIN = `${APP_PATH}/Contents/MacOS/Next Token`;
const APP_BUNDLE_ID = 'com.nexttoken.app';
/** Always relaunched at the end — the user's daily browser. */
const INSTALLED_APP = '/Applications/Next Token .app';
const PORT = 8917;
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** The omnibox SmartInput — exists only while focused (⌘L). */
const OMNIBOX_INPUT = 'input[aria-label="Address and AI command bar"]';
const NEW_TAB_BTN = 'button[title="New tab (⌘T)"]';
const SUGGEST_RE = /suggestqueries\.google|duckduckgo\.com\/ac\/|search\.brave\.com\/api\/suggest|startpage\.com\/suggestions/;

const results = {};
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function record(id, status, detail) {
  results[id] = { status, detail };
  log(`${status === 'works' ? 'PASS' : status === 'broken' ? 'FAIL' : 'SKIP'}  ${id} — ${detail}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* --------------------------- fixture server ----------------------------- */
const serverRequests = [];
function startServer() {
  const html = (body) =>
    `<!doctype html><meta charset="utf-8"><title>${body.includes('SLOW') ? 'SLOW OK' : 'phase0'}</title><body style="font:14px system-ui">${body}</body>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, ORIGIN);
    serverRequests.push(`${new Date().toISOString().slice(11, 23)} ${req.method} ${req.url}`);
    const send = (body, delay = 0) =>
      setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html(body));
          serverRequests.push(`${new Date().toISOString().slice(11, 23)} RESP ${req.url} ok`);
        } catch (e) {
          serverRequests.push(`${new Date().toISOString().slice(11, 23)} RESP ${req.url} threw ${e}`);
        }
      }, delay);
    res.on('close', () => {
      if (!res.writableEnded) {
        serverRequests.push(`${new Date().toISOString().slice(11, 23)} SOCK ${req.url} closed-early`);
      }
    });
    if (url.pathname === '/slow') return send('SLOW OK — loaded', 3000);
    if (url.pathname === '/login') {
      return send(`
        <form method="POST" action="/do-signin">
          <input id="user" name="username" type="text" autocomplete="username" placeholder="User">
          <input id="pass" name="password" type="password" autocomplete="current-password" placeholder="Pass">
          <button type="submit" id="go">Sign in</button>
        </form>`);
    }
    if (url.pathname === '/do-signin') {
      // Drain the POST body (not read by the page otherwise).
      req.on('data', () => {});
      req.on('end', () => send('WELCOME — signed in'));
      return;
    }
    if (url.pathname === '/persist/set') {
      return send(`<script>
        document.cookie = 'nt_p0=alive; path=/; max-age=86400';
        try { localStorage.setItem('nt_p0','alive'); } catch (e) {}
        document.body.textContent = 'SET OK';
      </script>`);
    }
    if (url.pathname === '/persist/check') {
      return send(`<script>
        const c = /(?:^|;\\s*)nt_p0=alive/.test(document.cookie) ? 'alive' : 'MISSING';
        let l = 'MISSING';
        try { l = localStorage.getItem('nt_p0') || 'MISSING'; } catch (e) {}
        document.body.textContent = 'COOKIE=' + c + ' LOCAL=' + l;
      </script>`);
    }
    send('phase0 fixture');
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/* --------------------------- app lifecycle ------------------------------ */
/**
 * Match ANY copy of the app (installed or unpacked build): both end in
 * ".../Contents/MacOS/Next Token" (possibly with args, so no $ anchor), and
 * both share the single-instance lock, so a leftover copy must be quit
 * before launching the one under test or the new instance exits instantly.
 * NOTE: the installed path is "Next Token .app" — a space before .app —
 * so the pattern must not assume "Token.app".
 */
const APP_PROC = 'MacOS/Next Token($| )';
function appRunning() {
  try {
    execSync(`pgrep -f '${APP_PROC}'`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
async function quitAppGracefully(timeoutMs = 20000) {
  if (!appRunning()) return;
  // Graceful quit via AppleScript only for the installed app — LaunchServices
  // can't reliably resolve an unsigned unpacked build by bundle id (and the
  // playwright-driven app.quit() in withApp() is the graceful path anyway).
  if (APP_PATH === INSTALLED_APP) {
    try {
      execSync(`osascript -e 'tell application id "${APP_BUNDLE_ID}" to quit'`, { stdio: 'ignore' });
    } catch {
      /* bundle-id quit can fail if LaunchServices is out of date */
    }
  }
  const t0 = Date.now();
  while (appRunning() && Date.now() - t0 < timeoutMs) await sleep(300);
  if (appRunning()) {
    try {
      execSync(`pkill -f '${APP_PROC}'`, { stdio: 'ignore' });
    } catch { /* last resort */ }
    await sleep(1500);
  }
}
async function launchApp() {
  const app = await electron.launch({ executablePath: APP_BIN, args: [] });
  const page = await app.firstWindow();
  await page.waitForSelector('aside', { timeout: 30000 });
  // Surface renderer errors — silent CSP/fetch failures show up here.
  page.on('console', (msg) => {
    if (msg.type() === 'error') log(`[console.error] ${msg.text().slice(0, 220)}`);
  });
  page.on('pageerror', (err) => log(`[pageerror] ${String(err).slice(0, 220)}`));
  return { app, page };
}
/**
 * Install a main-process WebContents lifecycle logger into a global buffer
 * (the evaluate sandbox has no fs/require), read back later by readWcLog().
 * Ground truth for "which guest loaded, did its did-stop-loading fire, was
 * it destroyed".
 */
async function installWcLogger(app) {
  await app.evaluate(({ app }) => {
    if (globalThis.__ntWcLog) return; // idempotent
    const buf = [];
    globalThis.__ntWcLog = buf;
    const line = (s) => {
      try { buf.push(`${new Date().toISOString().slice(11, 23)} ${s}`); } catch { /* noop */ }
    };
    app.on('web-contents-created', (_e, wc) => {
      const safeUrl = () => { try { return wc.getURL(); } catch { return '?'; } };
      line(`created wc=${wc.id} type=${wc.type}`);
      wc.on('did-start-loading', () => line(`wc=${wc.id} START ${safeUrl()}`));
      wc.on('did-stop-loading', () => line(`wc=${wc.id} STOP ${safeUrl()}`));
      wc.on('did-navigate', (_e2, url) => line(`wc=${wc.id} NAV ${url}`));
      wc.on('did-fail-load', (_e2, code, desc, u, main) =>
        line(`wc=${wc.id} FAIL code=${code} ${desc} url=${u} mainFrame=${main}`));
      wc.on('destroyed', () => line(`wc=${wc.id} DESTROYED`));
    });
    line('logger installed');
  });
}
async function readWcLog(app) {
  try {
    const buf = await app.evaluate(() => globalThis.__ntWcLog ?? []);
    return buf.slice(-25);
  } catch {
    return ['no wc log'];
  }
}
async function withApp(fn) {
  const { app, page } = await launchApp();
  try {
    return await fn(page, app);
  } finally {
    try {
      await app.evaluate(({ app }) => app.quit());
    } catch { /* quitting */ }
    await quitAppGracefully(8000);
  }
}

/* ------------------------------ ui helpers ------------------------------ */
async function snapshot(page) {
  return page.evaluate(() => window.nt.snapshotGet());
}
function tabById(s, id) {
  for (const sp of s.spaces) {
    const t = sp.tabs.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}
async function waitSnapshot(page, pred, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const s = await snapshot(page);
      if (s) {
        const v = pred(s);
        if (v) return v;
      }
    } catch { /* transient evaluate failure */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(150);
  }
}
async function findTabByUrlPart(page, urlPart, timeoutMs = 10000) {
  return waitSnapshot(
    page,
    (s) => {
      for (const sp of s.spaces) {
        const t = sp.tabs.find((x) => x.url.includes(urlPart));
        if (t) return t.id;
      }
      return null;
    },
    timeoutMs,
  );
}
/**
 * Focus the real omnibox. ⌘L is the primary path; when the new-tab hero
 * input holds focus it swallows the shortcut (pre-fix builds), so fall
 * back to clicking the hero input first, then the unfocused omnibox pill
 * (the TopStrip button that carries a .nt-mono span).
 */
async function focusOmnibox(page) {
  const tryShortcut = async (timeoutMs) => {
    await page.keyboard.press('Meta+l');
    try {
      await page.waitForSelector(OMNIBOX_INPUT, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  };
  if (await tryShortcut(2500)) return;
  const hero = await page.$('input[aria-label="New tab command bar"]');
  if (hero) {
    await hero.click();
    if (await tryShortcut(2500)) return;
  }
  const pill = await page.$('button:has(span.nt-mono)');
  if (pill) {
    await pill.click();
    try {
      await page.waitForSelector(OMNIBOX_INPUT, { timeout: 2500 });
      return;
    } catch { /* fall through */ }
  }
  throw new Error('could not focus the omnibox (⌘L, hero click, and pill click all failed)');
}
async function omniboxGo(page, value) {
  await focusOmnibox(page);
  // Locators, not cached handles: React re-renders the omnibox when its
  // value changes and replaces the input node, which detaches any cached
  // elementHandle mid-sequence.
  const input = page.locator(OMNIBOX_INPUT);
  await input.fill(value);
  await input.press('Enter');
}
async function openNewTab(page) {
  const btn = await page.$(NEW_TAB_BTN);
  assert(btn, 'New tab button not found');
  await btn.click();
  await sleep(500);
}
/**
 * Wait until the tab's URL matches urlPart AND its loading flag cleared,
 * so a not-yet-started navigation can't pass as "loaded".
 */
async function waitTabLoaded(page, tabId, urlPart, timeoutMs = 20000) {
  const ok = await waitSnapshot(
    page,
    (s) => {
      const t = tabById(s, tabId);
      return !!t && !t.loading && t.url.includes(urlPart);
    },
    timeoutMs,
  );
  if (!ok) throw new Error(`tab did not finish loading ${urlPart} within ${timeoutMs}ms`);
  await sleep(400); // let did-stop-loading UI settle
}
/** Poll until fn() returns truthy; returns the value or null on timeout. */
async function waitFor(fn, timeoutMs, stepMs = 200) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = await fn();
    } catch { /* transient */ }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(stepMs);
  }
}
/**
 * Run JS inside the URL-matched webview only. Returns null when no
 * matching webview exists (yet).
 */
async function wvExecExact(page, code, urlPart) {
  return page.evaluate(
    async ({ code, urlPart }) => {
      const wvs = [...document.querySelectorAll('webview')];
      for (const w of wvs) {
        try {
          const u = w.getURL() || '';
          if (u.includes(urlPart)) return await w.executeJavaScript(code);
        } catch { /* destroyed mid-flight */ }
      }
      return null;
    },
    { code, urlPart },
  );
}
/** Poll a webview expression until it matches re (guest mounts lazily). */
async function waitGuestBody(page, urlPart, re, timeoutMs = 15000) {
  return waitFor(async () => {
    const body = await wvExecExact(page, 'document.body ? document.body.textContent : ""', urlPart);
    const s = String(body ?? '');
    return re.test(s) ? s : null;
  }, timeoutMs);
}
async function deleteTestPassword(page) {
  await page.evaluate(async () => {
    try {
      const list = await window.nt.passwordsList();
      for (const e of list) {
        if (e.username === 'phase0user') await window.nt.passwordsDelete(e.origin, e.username);
      }
    } catch { /* best effort */ }
  });
}
async function closeFixtureTabs(page) {
  const s = await snapshot(page);
  const ids = [];
  for (const sp of s.spaces) for (const t of sp.tabs) if (t.url.includes('127.0.0.1')) ids.push(t.id);
  for (const id of ids) {
    await page.evaluate((i) => window.nt.tabsClose(i), id).catch(() => {});
    await sleep(200);
  }
}

/* ------------------------------- checks --------------------------------- */
async function check01(page) {
  const seen = [];
  const onReq = (r) => {
    const u = r.url();
    if (SUGGEST_RE.test(u)) seen.push(u);
  };
  const onFail = (r) => {
    const u = r.url();
    if (SUGGEST_RE.test(u)) seen.push(`${u} [request failed]`);
  };
  page.on('request', onReq);
  page.on('requestfailed', onFail);
  try {
    await page.keyboard.press('Escape');
    await sleep(200);
    await focusOmnibox(page);
    // Locator (never a cached handle): React replaces the input node when
    // its value state changes, which detaches elementHandles mid-sequence.
    const input = page.locator(OMNIBOX_INPUT);
    // No Enter: the dropdown must appear from typing alone. A multi-word
    // query routes to AI on commit, but suggestions fire while typing.
    await input.fill('weather in mumbai');
    // 200ms debounce + network + render.
    let listbox = await waitFor(() => page.$('[role="listbox"]'), 6000, 150);
    if (!listbox) {
      // Re-arm once in case a dismissal raced the first fill.
      await input.fill('weather in mumb');
      listbox = await waitFor(() => page.$('[role="listbox"]'), 4000, 150);
    }
    const rows = listbox ? await listbox.$$('[role="option"]') : [];
    const headers = listbox
      ? await listbox.$$eval('p.nt-micro', (els) => els.map((e) => e.textContent || ''))
      : [];
    const webSection = headers.some((h) => /Suggestions/i.test(h));
    await page.keyboard.press('Escape');
    await sleep(200);

    const detail =
      `dropdown=${rows.length} rows, headers=[${headers.join(' | ')}], ` +
      `web-section=${webSection}, suggest-requests=${seen.length}` +
      (seen.length ? ` → ${seen[0].slice(0, 90)}…` : '');
    if (rows.length > 0 && (webSection || seen.length > 0)) {
      record('0.1', 'works', detail);
    } else if (rows.length > 0) {
      record('0.1', 'broken', `dropdown renders local matches only — no web suggestions reached the UI. ${detail}`);
    } else if (seen.length > 0) {
      record('0.1', 'broken', `suggest requests fired but the dropdown never rendered. ${detail}`);
    } else {
      record('0.1', 'broken', `no dropdown and no suggest requests (if a build without the main suggest proxy is installed, the shell CSP blocks the old renderer fetch silently). ${detail}`);
    }
  } finally {
    page.off('request', onReq);
    page.off('requestfailed', onFail);
  }
}

async function check02(page, app) {
  const wcLog = await installWcLogger(app);
  // Create the tab directly with the URL: main sets url + loading:true at
  // creation, so the first snapshot that shows the tab shows it loading —
  // no race with an omnibox navigation commit (a 3s-delayed response makes
  // the URL visible only AFTER loading has finished). tabsCreate returns
  // the real tab id, immune to stale/restored look-alike tabs.
  const tabId = await page.evaluate((u) => window.nt.tabsCreate({ url: u }), `${ORIGIN}/slow`);
  assert(typeof tabId === 'string' && tabId, 'tabsCreate did not return a tab id');
  const rowSel = `[data-tab-row="${tabId}"]`;
  const shimmerInRow = () =>
    page.evaluate((sel) => !!document.querySelector(sel + ' .nt-shimmer'), rowSel).catch(() => false);

  // Poll the tab's own row while the 3s-delay fixture loads.
  let shimmerSeen = false;
  let lastState = 'no-tab';
  const t0 = Date.now();
  for (;;) {
    const s = await snapshot(page);
    const t = tabById(s, tabId);
    if (await shimmerInRow()) shimmerSeen = true;
    if (t) lastState = `loading=${t.loading} url=${t.url}`;
    if (t && !t.loading && t.url.includes('/slow')) break;
    if (Date.now() - t0 > 20000) {
      const guest = await page.evaluate(async () => {
        const out = [];
        for (const w of document.querySelectorAll('webview')) {
          try {
            out.push({
              wcId: w.getWebContentsId(),
              url: w.getURL(),
              isLoading: w.isLoading(),
              body: await w.executeJavaScript('document.body ? document.body.textContent.slice(0, 60) : null').catch(() => 'EXEC-FAIL'),
            });
          } catch (e) {
            out.push({ error: String(e).slice(0, 80) });
          }
        }
        return out;
      }).catch(() => 'evaluate-failed');
      const wcLines = await readWcLog(app);
      throw new Error(`/slow page never finished loading. tab: ${lastState}. ` +
        `guests=${JSON.stringify(guest)} serverRequests=${JSON.stringify(serverRequests.slice(-12))} ` +
        `wcLog=${JSON.stringify(wcLines)}`);
    }
    await sleep(120);
  }
  // Give the indicator a moment to clear, then re-check.
  let stillShimmer = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) {
    if (await shimmerInRow()) {
      stillShimmer = true;
      break;
    }
    await sleep(150);
  }
  const body = await waitGuestBody(page, '/slow', /SLOW OK/, 8000);

  const detail =
    `shimmer-seen-during-load=${shimmerSeen}, shimmer-cleared=${!stillShimmer}, ` +
    `page=${JSON.stringify((body || '').slice(0, 40))}`;
  if (shimmerSeen && !stillShimmer && /SLOW OK/.test(String(body || ''))) {
    record('0.2', 'works', detail);
  } else if (!shimmerSeen) {
    record('0.2', 'broken', `the loading tab's row never showed the favicon-slot indicator. ${detail}`);
  } else if (stillShimmer) {
    record('0.2', 'broken', `indicator did not clear after the page finished. ${detail}`);
  } else {
    record('0.2', 'broken', `page did not render its content. ${detail}`);
  }
}

async function check03Set(page) {
  const tabId = await page.evaluate((u) => window.nt.tabsCreate({ url: u }), `${ORIGIN}/persist/set`);
  assert(typeof tabId === 'string' && tabId, 'tabsCreate did not return a tab id');
  await waitTabLoaded(page, tabId, '/persist/set');
  const body = await waitGuestBody(page, '/persist/set', /SET OK/, 10000);
  assert(!!body, `persist/set did not run: ${JSON.stringify(body)}`);
  // No close, no cleanup: this tab must still be open at quit so the
  // session write captures it for run 2.
}

async function check03Verify(page) {
  // Preferred path: the fixture tab was restored from the previous session
  // (proves session restore too). Fallback: navigate a fresh tab — the
  // persist:nexttoken partition evidence is identical either way.
  let tabId = await findTabByUrlPart(page, '/persist/set', 8000);
  let viaRestore = !!tabId;
  if (!tabId) {
    await openNewTab(page);
    await omniboxGo(page, `${ORIGIN}/persist/set`);
    tabId = await findTabByUrlPart(page, '/persist/set', 8000);
    if (!tabId) {
      record('0.3', 'broken', 'could not open or find the persist fixture tab at all');
      return false;
    }
    await waitTabLoaded(page, tabId, '/persist/set');
    const setBody = await waitGuestBody(page, '/persist/set', /SET OK/, 10000);
    if (!setBody) {
      record('0.3', 'broken', 'fallback /persist/set did not run');
      return false;
    }
  }
  await page.evaluate((i) => window.nt.tabsActivate(i), tabId);
  // Restored tabs mount their webview lazily on activation.
  const setBody2 = await waitGuestBody(page, '/persist/set', /SET OK/, 20000);
  if (!setBody2) {
    record('0.3', 'broken', 'fixture tab never rendered (webview did not load)');
    return false;
  }
  // Navigate the same tab to /persist/check via the omnibox.
  await omniboxGo(page, `${ORIGIN}/persist/check`);
  await waitTabLoaded(page, tabId, '/persist/check');
  const body = String(await wvExecExact(page, 'document.body.textContent', '/persist/check') || '');
  const cookieOk = /COOKIE=alive/.test(body);
  const localOk = /LOCAL=alive/.test(body);
  const detail = `${viaRestore ? 'restored tab' : 'fresh navigation'}, after full quit+relaunch: ${body.trim() || 'no page content'}`;
  if (cookieOk && localOk) {
    record('0.3', 'works', detail);
    return true;
  }
  record('0.3', 'broken', `persist:nexttoken did not survive relaunch (cookie=${cookieOk}, localStorage=${localOk}). ${detail}`);
  return false;
}

async function check04(page) {
  // A previous probe/run may have left phase0user in the vault with the
  // same password — main then correctly stays silent ("already stored →
  // nothing to ask"), which would read as a broken save prompt. Start clean.
  await deleteTestPassword(page);
  const tabId = await page.evaluate((u) => window.nt.tabsCreate({ url: u }), `${ORIGIN}/login`);
  assert(typeof tabId === 'string' && tabId, 'tabsCreate did not return a tab id');
  await waitTabLoaded(page, tabId, '/login');
  const formReady = await waitGuestBody(page, '/login', /Sign in/, 15000);
  if (!formReady) {
    // Dump everything needed to see which side failed.
    const guestState = await page.evaluate(async () => {
      const wvs = [...document.querySelectorAll('webview')];
      const out = [];
      for (const w of wvs) {
        try {
          out.push({
            url: w.getURL(),
            isLoading: w.isLoading(),
            title: w.getTitle(),
            body: (await w.executeJavaScript('document.body ? document.body.textContent.slice(0, 120) : null').catch(() => 'EXEC-FAIL')),
          });
        } catch (e) {
          out.push({ error: String(e).slice(0, 120) });
        }
      }
      return out;
    });
    assert(false, `login fixture did not render. guests=${JSON.stringify(guestState)} serverRequests=${JSON.stringify(serverRequests.slice(-12))}`);
  }

  // Fill + submit INSIDE the guest (the shell page cannot see the form).
  await wvExecExact(
    page,
    `(() => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('#user'), 'phase0user');
      set(document.querySelector('#pass'), 'S3cret-Phase0!');
      document.querySelector('#go').click();
    })()`,
    '/login',
  );
  const findToast = (re) =>
    page.evaluate((src) => {
      const rx = new RegExp(src, 'i');
      return [...document.querySelectorAll('.nt-toast')].some((e) => rx.test(e.textContent || ''));
    }, re.source);

  const saveChip = await waitFor(() => findToast(/Save password for/), 8000);
  if (!saveChip) {
    record('0.4', 'broken', 'no "Save password for …" prompt after submitting a login form');
    return;
  }
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.nt-toast')].find((e) => /Save password for/i.test(e.textContent || ''));
    [...t.querySelectorAll('button')].find((b) => /^Save$/.test((b.textContent || '').trim()))?.click();
  });
  await sleep(700);

  // Fill flow: revisit the SAME tab (activate first — the omnibox
  // navigates the active tab) → offer chip → click the username button.
  await page.evaluate((i) => window.nt.tabsActivate(i), tabId);
  await omniboxGo(page, `${ORIGIN}/login`);
  await waitTabLoaded(page, tabId, '/login');
  const fillChip = await waitFor(() => findToast(/Fill saved password for/), 8000);
  if (!fillChip) {
    record('0.4', 'broken', 'save prompt worked, but no "Fill saved password for …" offer on revisit');
    return;
  }
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.nt-toast')].find((e) => /Fill saved password for/i.test(e.textContent || ''));
    [...t.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'phase0user')?.click();
  });
  const filled = await waitFor(async () => {
    const v = await wvExecExact(
      page,
      'document.querySelector("#pass") ? document.querySelector("#pass").value : ""',
      '/login',
    );
    return v || null;
  }, 6000);
  if (filled === 'S3cret-Phase0!') {
    record('0.4', 'works', 'save prompt → Save → revisit offer → Fill put the password in the field');
  } else {
    record('0.4', 'broken', `Fill did not populate the password field (got ${JSON.stringify(filled)})`);
  }
}

/* -------------------------------- run ----------------------------------- */
const server = await startServer();
log(`fixture server on ${ORIGIN}`);
try {
  await quitAppGracefully();

  // Run 1 — 0.1 + 0.2 + 0.3(set) in one session. Fixture tabs stay open so
  // the quit-time session write captures them. First: clear fixture tabs
  // left by earlier runs (they get session-restored and would poison every
  // URL-based lookup with stale look-alikes).
  await withApp(async (page, app) => {
    await closeFixtureTabs(page);
    await check01(page);
    await check02(page, app);
    await check03Set(page);
  });

  // Run 2 — fresh process: 0.3 verify + 0.4, then cleanup (only when the
  // session evidence is no longer needed).
  await withApp(async (page) => {
    const persisted = await check03Verify(page);
    await check04(page);
    await deleteTestPassword(page);
    if (persisted) await closeFixtureTabs(page);
  });
} catch (e) {
  record('harness', 'broken', `script error: ${e.message}`);
} finally {
  server.close();
}

log('\n=== Phase 0 report ===');
for (const id of ['0.1', '0.2', '0.3', '0.4']) {
  const r = results[id] || { status: 'not installed', detail: 'not run' };
  log(`${id}: ${r.status} — ${r.detail}`);
}
// Relaunch the user's browser (the installed app, not the test build).
try {
  execSync(`open "${INSTALLED_APP}"`, { stdio: 'ignore' });
  log('\nRelaunched Next Token for you.');
} catch { /* user can open it */ }
process.exit(Object.values(results).some((r) => r.status === 'broken') ? 1 : 0);
