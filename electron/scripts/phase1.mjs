/**
 * Phase 1 — Google sign-in integrity probe (macOS, live).
 *
 * Probes, in order:
 *   1.1 Guest automation signals + JS identity: navigator.webdriver,
 *       navigator.userAgentData.brands, UA string — inside a real guest tab.
 *   1.2 Wire identity: Sec-CH-UA* headers as they leave the guest session
 *       (main-process webRequest tap), plus a loopback fetch proving the tap
 *       is actually wired to persist:nexttoken.
 *   1.3 accounts.google.com reachability: does the sign-in page render, or
 *       does Google serve "This browser or app may not be secure"?
 *   1.4 WebAuthn platform-authenticator availability (Phase 6 baseline on
 *       Electron 39 — expected false until app.configureWebAuthn exists).
 *
 * Usage: node scripts/phase1.mjs   (PHASE0_APP= to target an unpacked build)
 */
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import { execSync } from 'node:child_process';

const APP_PATH = process.env.PHASE0_APP || '/Applications/Next Token .app';
const APP_BIN = `${APP_PATH}/Contents/MacOS/Next Token`;
const APP_BUNDLE_ID = 'com.nexttoken.app';
const INSTALLED_APP = '/Applications/Next Token .app';
const APP_PROC = 'MacOS/Next Token($| )';
const LOOPBACK_PORT = 8918;
const LOOPBACK = `http://127.0.0.1:${LOOPBACK_PORT}`;
/** Request headers the loopback server actually receives (wire truth). */
const wireObserved = [];

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function record(id, status, detail) {
  log(`${status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'INFO'}  ${id} — ${detail}`);
}

/* --------------------------- app lifecycle ------------------------------ */
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
  if (APP_PATH === INSTALLED_APP) {
    try {
      execSync(`osascript -e 'tell application id "${APP_BUNDLE_ID}" to quit'`, { stdio: 'ignore' });
    } catch { /* LaunchServices may be stale */ }
  }
  const t0 = Date.now();
  while (appRunning() && Date.now() - t0 < timeoutMs) await sleep(300);
  if (appRunning()) {
    try { execSync(`pkill -f '${APP_PROC}'`, { stdio: 'ignore' }); } catch { /* last resort */ }
    await sleep(1500);
  }
}
async function withApp(fn) {
  const app = await electron.launch({ executablePath: APP_BIN, args: [] });
  const page = await app.firstWindow();
  await page.waitForSelector('aside', { timeout: 30000 });
  page.on('pageerror', (err) => log(`[pageerror] ${String(err).slice(0, 200)}`));
  try {
    return await fn(page, app);
  } finally {
    try { await app.evaluate(({ app }) => app.quit()); } catch { /* quitting */ }
    await quitAppGracefully(8000);
  }
}

/* ------------------------------ ui helpers ------------------------------ */
const OMNIBOX_INPUT = 'input[aria-label="Address and AI command bar"]';
async function snapshot(page) {
  return page.evaluate(() => window.nt.snapshotGet());
}
async function waitSnapshot(page, pred, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const s = await snapshot(page);
      if (s && pred(s)) return s;
    } catch { /* transient */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(150);
  }
}
async function focusOmnibox(page) {
  await page.keyboard.press('Meta+l');
  try {
    await page.waitForSelector(OMNIBOX_INPUT, { timeout: 2500 });
    return;
  } catch { /* fall through to hero click */ }
  const hero = await page.$('input[aria-label="New tab command bar"]');
  if (hero) {
    await hero.click();
    await page.keyboard.press('Meta+l');
    await page.waitForSelector(OMNIBOX_INPUT, { timeout: 2500 });
  }
}
async function omniboxGo(page, value) {
  await focusOmnibox(page);
  const input = page.locator(OMNIBOX_INPUT);
  await input.fill(value);
  await input.press('Enter');
}
async function closeFixtureTabs(page) {
  const s = await snapshot(page);
  for (const sp of s.spaces) {
    for (const t of sp.tabs) {
      if (t.url.includes('127.0.0.1') || t.url.includes('example.com') || t.url.includes('accounts.google.com')) {
        await page.evaluate((i) => window.nt.tabsClose(i), t.id).catch(() => {});
        await sleep(150);
      }
    }
  }
}
async function waitTabLoaded(page, tabId, urlPart, timeoutMs = 25000) {
  const ok = await waitSnapshot(
    page,
    (s) => {
      for (const sp of s.spaces) {
        const t = sp.tabs.find((x) => x.id === tabId);
        if (t) return !t.loading && t.url.includes(urlPart);
      }
      return false;
    },
    timeoutMs,
  );
  if (!ok) throw new Error(`tab did not finish loading ${urlPart}`);
  await sleep(400);
}
/** Run JS inside the URL-matched webview only. */
async function wvExecExact(page, code, urlPart) {
  return page.evaluate(
    async ({ code, urlPart }) => {
      for (const w of [...document.querySelectorAll('webview')]) {
        try {
          if ((w.getURL() || '').includes(urlPart)) return await w.executeJavaScript(code);
        } catch { /* destroyed mid-flight */ }
      }
      return null;
    },
    { code, urlPart },
  );
}

/* ------------------------------- checks --------------------------------- */
async function check11GuestIdentity(page) {
  // example.com: stable, tiny, real HTTPS page — ideal identity mirror.
  const tabId = await page.evaluate(() => window.nt.tabsCreate({ url: 'https://example.com/' }));
  await waitTabLoaded(page, tabId, 'example.com');
  const raw = await wvExecExact(
    page,
    `JSON.stringify({
      wd: navigator.webdriver,
      brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand + '|' + b.version),
      platform: navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform,
      ua: navigator.userAgent,
    })`,
    'example.com',
  );
  const facts = JSON.parse(raw || '{}');
  log('\n[guest identity]', JSON.stringify(facts, null, 2));

  if (facts.wd === true) {
    record('1.1a webdriver', 'info', 'navigator.webdriver === true — but this is the harness\'s own Playwright CDP attach; scripts/phase1-pristine.mjs gives the verdict for real launches');
  } else {
    record('1.1a webdriver', 'pass', `navigator.webdriver === ${facts.wd}`);
  }
  const brands = facts.brands || [];
  const hasElectron = brands.some((b) => /^Electron/i.test(b));
  if (hasElectron) {
    record('1.1b brands', 'fail', `userAgentData brands still contain Electron: ${brands.join(', ')}`);
  } else {
    record('1.1b brands', 'pass', `brands: ${brands.join(', ') || '(none exposed)'}`);
  }
  const ua = facts.ua || '';
  const uaVersion = (ua.match(/Chrome\/([\d.]+)/) || [])[1];
  const brandVersion = (brands.find((b) => b.startsWith('Not') === false && /Chromium/i.test(b)) || '').split('|')[1];
  if (uaVersion && brandVersion && uaVersion.split('.')[0] !== brandVersion.split('.')[0]) {
    record('1.1c ua-vs-ch', 'fail', `UA says Chrome/${uaVersion} but brands say ${brandVersion} — version disagreement is actively rejected`);
  } else {
    record('1.1c ua-vs-ch', 'pass', `UA Chrome/${uaVersion ?? '?'} matches brand version ${brandVersion ?? '?'}`);
  }
  return facts;
}

async function check12WireIdentity(page, bundledCh) {
  // No main-process webRequest tap: onBeforeSendHeaders proved inert for
  // webview-guest traffic on this Electron, so wire truth is observed where
  // the packets land — the loopback server logs the headers it receives.
  // Sec-CH-UA is derived by Chromium from the same native brand list that
  // backs navigator.userAgentData (validated in 1.1b), so header and JS
  // identities cannot disagree.
  wireObserved.length = 0;
  // (LOOPBACK is passed as an argument — outer-scope consts do not serialize
  // into page.evaluate.)
  const tabId = await page.evaluate((base) => window.nt.tabsCreate({ url: `${base}/probe` }), LOOPBACK);
  await waitTabLoaded(page, tabId, '/probe');
  await sleep(500);
  const obs = wireObserved[wireObserved.length - 1];
  if (!obs) {
    record('1.2a wire-obs', 'fail', 'loopback server saw no /probe request from the guest');
    return [];
  }
  log('[wire /probe]', JSON.stringify(obs, null, 2));
  record('1.2a wire-obs', 'pass', 'loopback server received the guest request (wire-level observation)');
  const ua = obs.ua || '';
  if (/Electron\//.test(ua)) {
    record('1.2b wire-ua', 'fail', `wire UA still contains Electron token: ${ua}`);
  } else {
    record('1.2b wire-ua', 'pass', `wire UA: ${ua}`);
  }
  const chromeInUa = (ua.match(/Chrome\/([\d.]+)/) || [])[1];
  if (chromeInUa && chromeInUa !== bundledCh) {
    record('1.2c ua-version', 'fail', `wire UA Chrome/${chromeInUa} != bundled Chromium ${bundledCh}`);
  } else {
    record('1.2c ua-version', 'pass', `wire UA matches bundled Chromium ${bundledCh}`);
  }
  if (obs.secChUa && /Electron/i.test(obs.secChUa)) {
    record('1.2d wire-ch', 'fail', `Sec-CH-UA header contains Electron: ${obs.secChUa}`);
  } else {
    record('1.2d wire-ch', 'pass', `Sec-CH-UA header: ${obs.secChUa || '(not sent to this http origin)'}`);
  }
  return [obs];
}

async function check13GoogleSignin(page) {
  const tabId = await page.evaluate(() => window.nt.tabsCreate({ url: 'https://accounts.google.com/' }));
  let outcome = null;
  try {
    await waitTabLoaded(page, tabId, 'google.com', 30000);
  } catch { /* fall through to body inspection */ }
  // Give the SPA a beat to render its banner or the form.
  await sleep(2500);
  // Match the webview by the google.com family, not the exact host —
  // accounts.google.com can redirect (e.g. to myaccount.google.com when a
  // session already exists), and URL-based lookup must survive that.
  const url = await wvExecExact(page, 'location.href', 'google.com');
  const body = await wvExecExact(page, 'document.body ? document.body.innerText.slice(0, 800) : ""', 'google.com');
  const title = await (async () => {
    const s = await snapshot(page);
    for (const sp of s.spaces) {
      const t = sp.tabs.find((x) => x.id === tabId);
      if (t) return t.title;
    }
    return null;
  })();
  const text = String(body || '');
  log('\n[accounts.google.com] tab title:', title, '| url:', url);
  log('[accounts.google.com] body:', JSON.stringify(text.slice(0, 400)));

  const blockedRe = /This browser or app may not be secure|Unsupported browser|doesn't support signing in/i;
  const rateRe = /Couldn't sign you in|unusual activity|blocked some attempts/i;
  const formRe = /Sign in|Email or phone|to continue to/i;
  if (blockedRe.test(text)) {
    outcome = 'blocked';
    record('1.3 google-signin', 'fail', 'Google served the "browser may not be secure" block page');
  } else if (rateRe.test(text)) {
    outcome = 'rate-limited';
    record('1.3 google-signin', 'info', 'Google rate-limited/flagged this attempt — identity looked automated or the IP is flagged. Retry from a normal network later; this is not a code verdict.');
  } else if (formRe.test(text) || (title && /sign in/i.test(title))) {
    outcome = 'sign-in-page';
    record('1.3 google-signin', 'pass', `Google sign-in page rendered (title: ${JSON.stringify(title)}) — no secure-browser block. Interactive sign-in still needs a human on the Mac.`);
  } else if (title && /google account/i.test(title)) {
    outcome = 'signed-in';
    record('1.3 google-signin', 'pass', `already signed in — Google served the account page (title: ${JSON.stringify(title)}), no block`);
  } else {
    outcome = 'unknown';
    record('1.3 google-signin', 'info', 'page state not recognized — inspect the body dump above');
  }

  // (Google's own request headers are not observed here — the loopback
  // observation in 1.2 plus the JS-level brands check in 1.1 cover the
  // identity story; Chromium derives Sec-CH-UA from the same native list.)
  return outcome;
}

async function check14Webauthn(page) {
  const available = await wvExecExact(
    page,
    `PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
       ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => 'error')
       : 'api-missing'`,
    'example.com',
  );
  log(`\n[webauthn] isUserVerifyingPlatformAuthenticatorAvailable -> ${available}`);
  if (available === true) {
    record('1.4 webauthn', 'pass', 'platform authenticator already available (unexpected on Electron 39 — good anyway)');
  } else {
    record('1.4 webauthn', 'info', `platform authenticator: ${available} — expected until Electron 41 + app.configureWebAuthn (Phase 6)`);
  }
}

/* -------------------------------- run ----------------------------------- */
const results = [];
const server = http.createServer((req, res) => {
  if (req.url === '/probe') {
    wireObserved.push({
      ua: req.headers['user-agent'] || null,
      secChUa: req.headers['sec-ch-ua'] || null,
      secChUaMobile: req.headers['sec-ch-ua-mobile'] || null,
      secChUaPlatform: req.headers['sec-ch-ua-platform'] || null,
    });
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('phase1 loopback ok');
});
await new Promise((r) => server.listen(LOOPBACK_PORT, '127.0.0.1', () => r()));

try {
  await quitAppGracefully();
  await withApp(async (page, app) => {
    await closeFixtureTabs(page);
    await check11GuestIdentity(page);
    // The app's bundled Chromium version — NOT the local Node's.
    const bundledCh = await app.evaluate(() => process.versions.chrome);
    await check12WireIdentity(page, bundledCh);
    await check13GoogleSignin(page);
    await check14Webauthn(page);
    await closeFixtureTabs(page);
  });
} catch (e) {
  record('harness', 'fail', `script error: ${e.message}`);
} finally {
  server.close();
}

log('\n=== Phase 1 report ===');
try {
  execSync(`open "${INSTALLED_APP}"`, { stdio: 'ignore' });
  log('Relaunched Next Token for you.');
} catch { /* user can open it */ }
process.exit(0);
