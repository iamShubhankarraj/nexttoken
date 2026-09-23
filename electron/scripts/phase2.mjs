/**
 * Phase 2 — password-manager Chrome-parity probes, run on macOS.
 *
 * Covers the surface added in this pass:
 *   2.1  manual add (Settings → Passwords → Add login) via nt.passwords.add
 *   2.2  CSV export: real save dialog → file written in main, passwords never
 *        crossed IPC, header + row content verified on disk
 *   2.3  CSV import: real open dialog → rows merged into the vault
 *   2.4  update-password prompt: changed password → "Update password for …"
 *        toast with an Update button; same password again → NO prompt
 *   2.5  fill-offer regression (Phase 0.4 path): revisit → Fill chip → field
 *        actually populated with the updated password
 *
 * The native save/open dialogs are driven with AppleScript System Events.
 * If the host terminal lacks Accessibility permission, 2.2/2.3 are reported
 * as "manual" (SKIP) instead of FAIL — the underlying main-side logic is
 * identical for both entry points.
 *
 * Run: PHASE0_APP="$PWD/release/mac-arm64/Next Token.app" node scripts/phase2.mjs
 */
import { _electron as electron } from 'playwright-core';
import http from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_PATH = process.env.PHASE0_APP || '/Applications/Next Token .app';
const APP_BIN = `${APP_PATH}/Contents/MacOS/Next Token`;
const INSTALLED_APP = '/Applications/Next Token .app';
const APP_BUNDLE_ID = 'com.nexttoken.app';
const APP_PROC = 'MacOS/Next Token($| )';
const PORT = 18777;
const ORIGIN = `http://127.0.0.1:${PORT}`;

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
  const server = http.createServer((req, res) => {
    serverRequests.push(`${req.method} ${req.url}`);
    const send = (body) => {
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui">${body}</body>`);
      } catch { /* client gone */ }
    };
    if (req.url === '/login') {
      return send(`
        <form method="POST" action="/do-signin">
          <input id="user" name="username" type="text" autocomplete="username" placeholder="User">
          <input id="pass" name="password" type="password" autocomplete="current-password" placeholder="Pass">
          <button type="submit" id="go">Sign in</button>
        </form>`);
    }
    if (req.url === '/do-signin') {
      req.on('data', () => {});
      req.on('end', () => send('WELCOME — signed in'));
      return;
    }
    send('phase2 fixture');
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
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
    } catch { /* ignore */ }
  }
  const t0 = Date.now();
  while (appRunning() && Date.now() - t0 < timeoutMs) await sleep(300);
  if (appRunning()) {
    try { execSync(`pkill -f '${APP_PROC}'`, { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(1500);
  }
}
async function launchApp() {
  const app = await electron.launch({ executablePath: APP_BIN, args: [] });
  const page = await app.firstWindow();
  await page.waitForSelector('aside', { timeout: 30000 });
  page.on('pageerror', (err) => log(`[pageerror] ${String(err).slice(0, 200)}`));
  return { app, page };
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
const OMNIBOX_INPUT = 'input[aria-label="Address and AI command bar"]';
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
    } catch { /* transient */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(150);
  }
}
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
  throw new Error('could not focus the omnibox');
}
async function omniboxGo(page, value) {
  await focusOmnibox(page);
  const input = page.locator(OMNIBOX_INPUT);
  await input.fill(value);
  await input.press('Enter');
}
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
  await sleep(400);
}
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
async function waitGuestBody(page, urlPart, re, timeoutMs = 15000) {
  return waitFor(async () => {
    const body = await wvExecExact(page, 'document.body ? document.body.textContent : ""', urlPart);
    const s = String(body ?? '');
    return re.test(s) ? s : null;
  }, timeoutMs);
}
function findToast(page, re) {
  return page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    return [...document.querySelectorAll('.nt-toast')].some((e) => rx.test(e.textContent || ''));
  }, re.source);
}
function clickToastButton(page, reToast, reButton) {
  return page.evaluate(
    ({ rt, rb }) => {
      const t = [...document.querySelectorAll('.nt-toast')].find((e) => new RegExp(rt, 'i').test(e.textContent || ''));
      if (!t) return false;
      const b = [...t.querySelectorAll('button')].find((x) => new RegExp(rb, 'i').test((x.textContent || '').trim()));
      if (!b) return false;
      b.click();
      return true;
    },
    { rt: reToast.source, rb: reButton.source },
  );
}
/** Delete vault entries created by this probe (origin match on our fixture ports). */
async function cleanVault(page) {
  await page.evaluate(async () => {
    try {
      const list = await window.nt.passwordsList();
      for (const e of list) {
        if (e.origin.includes(':18777') || e.origin === 'https://example.com') {
          await window.nt.passwordsDelete(e.origin, e.username);
        }
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

/* --------------------- native dialog driving (2.2/2.3) ------------------- */
const TMP = mkdtempSync(path.join(os.tmpdir(), 'nt-phase2-'));
const EXPORT_CSV = path.join(TMP, 'exported-passwords.csv');
const IMPORT_CSV = path.join(TMP, 'import.csv');

function applescriptAvailable() {
  try {
    execSync(
      `osascript -e 'tell application "System Events" to key code 0'`,
      { stdio: 'ignore', timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}
/**
 * Drive the frontmost native save/open dialog to a specific path:
 * Cmd+Shift+G (Go to folder) → type full path → Return → Return.
 */
function driveDialogToPath(filePath) {
  const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  if frontApp is not "Next Token" then error "Next Token not frontmost: " & frontApp
  keystroke "g" using {command down, shift down}
  delay 0.6
  keystroke "${filePath.replace(/"/g, '\\"')}"
  delay 0.3
  key code 36
  delay 0.8
  key code 36
end tell`;
  execSync(`osascript -e '${script.replace(/'/g, `'\\''`)}'`, { stdio: 'ignore', timeout: 15000 });
}

/* -------------------------------- checks -------------------------------- */
const USER_V2 = 'phase2user';
const PASS_A = 'First-Pass-A1!';
const PASS_B = 'Updated-Pass-B2!';

async function check21(page) {
  await cleanVault(page);
  const r = await page.evaluate(async ({ user, pass }) => {
    const api = window.nt;
    const bad = await api.passwordsAdd('not a url', user, pass);
    const ok = await api.passwordsAdd('http://127.0.0.1:18777', user, pass);
    const list = await api.passwordsList();
    const hit = list.find((e) => e.origin === 'http://127.0.0.1:18777' && e.username === user);
    // The list must never carry passwords.
    const leak = list.some((e) => 'password' in e);
    return { bad, ok, hit: !!hit, leak };
  }, { user: USER_V2, pass: PASS_A });
  if (r.ok && r.hit && !r.leak && r.bad && !r.bad.ok) {
    record('2.1', 'works', 'manual add stored + listed (no password field), invalid origin rejected');
  } else {
    record('2.1', 'broken', JSON.stringify(r));
  }
}

async function check22(page) {
  if (!applescriptAvailable()) {
    record('2.2', 'manual', 'System Events unavailable (no Accessibility permission) — verify Export CSV by hand in Settings');
    return;
  }
  rmSync(EXPORT_CSV, { force: true });
  const p = page.evaluate(() => window.nt.passwordsCsvExport()); // dialog opens
  await sleep(1200);
  let drove = false;
  try {
    driveDialogToPath(EXPORT_CSV);
    drove = true;
  } catch (e) {
    log(`  (dialog drive failed: ${String(e).slice(0, 120)})`);
  }
  const r = await p.then((x) => x).catch((e) => ({ ok: false, error: String(e) }));
  if (!drove) {
    record('2.2', 'manual', `dialog opened but could not be driven — result: ${JSON.stringify(r).slice(0, 120)}`);
    return;
  }
  if (r?.ok && existsSync(EXPORT_CSV)) {
    const text = readFileSync(EXPORT_CSV, 'utf8');
    const header = text.split(/\r?\n/)[0].trim();
    const hasRow = text.includes(USER_V2) && text.includes(PASS_A);
    if (header === 'name,url,username,password' && hasRow) {
      record('2.2', 'works', `real file written via save dialog (header + ${USER_V2} row present)`);
    } else {
      record('2.2', 'broken', `file written but wrong: header=${JSON.stringify(header)} row=${hasRow}`);
    }
  } else {
    record('2.2', 'broken', `export did not produce a file: ${JSON.stringify(r).slice(0, 160)}`);
  }
}

async function check23(page) {
  if (!applescriptAvailable()) {
    record('2.3', 'manual', 'System Events unavailable — verify Import CSV by hand in Settings');
    return;
  }
  const csv = `name,url,username,password\r\nExample,https://example.com,alice,wonder-1\r\n`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(IMPORT_CSV, csv, 'utf8');
  const before = await page.evaluate(async () => (await window.nt.passwordsList()).filter((e) => e.origin === 'https://example.com').length);
  const p = page.evaluate(() => window.nt.passwordsCsvImport()); // open dialog
  await sleep(1200);
  let drove = false;
  try {
    driveDialogToPath(IMPORT_CSV);
    drove = true;
  } catch { /* reported below */ }
  const r = await p.then((x) => x).catch((e) => ({ ok: false, error: String(e) }));
  if (!drove) {
    record('2.3', 'manual', `dialog opened but could not be driven — result: ${JSON.stringify(r).slice(0, 120)}`);
    return;
  }
  const after = await page.evaluate(async () => (await window.nt.passwordsList()).filter((e) => e.origin === 'https://example.com'));
  if (r?.ok && r.added === 1 && after.length === 1 && after[0].username === 'alice') {
    record('2.3', 'works', `CSV row imported into the vault (added=${r.added}, example.com/alice listed)`);
  } else {
    record('2.3', 'broken', `import result=${JSON.stringify(r).slice(0, 120)} before=${before} after=${JSON.stringify(after)}`);
  }
}

async function submitLogin(page, user, pass) {
  await wvExecExact(
    page,
    `(() => {
      const set = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(document.querySelector('#user'), ${JSON.stringify(user)});
      set(document.querySelector('#pass'), ${JSON.stringify(pass)});
      document.querySelector('#go').click();
    })()`,
    '/login',
  );
}

async function check24(page, tabId) {
  // The vault holds USER_V2/PASS_A (2.1). Submitting PASS_B → update prompt.
  await page.evaluate((i) => window.nt.tabsActivate(i), tabId);
  await omniboxGo(page, `${ORIGIN}/login`);
  await waitTabLoaded(page, tabId, '/login');
  await waitGuestBody(page, '/login', /Sign in/, 15000);
  await submitLogin(page, USER_V2, PASS_B);

  const sawUpdate = await waitFor(() => findToast(page, /Update password for/), 8000);
  if (!sawUpdate) {
    const saveInstead = await findToast(page, /Save password for/);
    record('2.4', 'broken', saveInstead
      ? 'changed password produced a generic "Save" prompt instead of "Update password for …"'
      : 'no prompt at all after submitting a changed password for a stored login');
    return;
  }
  const clicked = await clickToastButton(page, /Update password for/, /^Update$/);
  await sleep(700);
  if (!clicked) {
    record('2.4', 'broken', 'the toast said "Update" but no Update button was found');
    return;
  }
  // Chrome parity negative: the SAME password again → no prompt at all.
  await waitTabLoaded(page, tabId, '/do-signin').catch(() => {});
  await omniboxGo(page, `${ORIGIN}/login`);
  await waitTabLoaded(page, tabId, '/login');
  await waitGuestBody(page, '/login', /Sign in/, 15000);
  await submitLogin(page, USER_V2, PASS_B);
  // Precise regex: must match "Save password for" / "Update password for" but
  // NOT the benign "Fill saved password for" offer chip that legitimately
  // appears on every revisit of a login page with stored credentials.
  const anyToast = await waitFor(async () => ((await findToast(page, /(save|update) password for/i)) ? true : null), 4000);
  record('2.4', anyToast ? 'broken' : 'works', anyToast
    ? 're-submitting the SAME password still raised a save/update prompt (should stay silent)'
    : 'changed → Update prompt; same password again → correctly silent');
}

async function check25(page, tabId) {
  await page.evaluate((i) => window.nt.tabsActivate(i), tabId);
  await omniboxGo(page, `${ORIGIN}/login`);
  await waitTabLoaded(page, tabId, '/login');
  const chip = await waitFor(() => findToast(page, /Fill saved password for/), 8000);
  if (!chip) {
    record('2.5', 'broken', 'no "Fill saved password for …" offer on revisit after the update');
    return;
  }
  await clickToastButton(page, /Fill saved password for/, new RegExp(`^${USER_V2}$`));
  const filled = await waitFor(async () => {
    const v = await wvExecExact(page, 'document.querySelector("#pass") ? document.querySelector("#pass").value : ""', '/login');
    return v || null;
  }, 6000);
  record('2.5', filled === PASS_B ? 'works' : 'broken', filled === PASS_B
    ? 'revisit offer → Fill populated the field with the UPDATED password'
    : `Fill populated ${JSON.stringify(filled)}`);
}

/* --------------------------------- run ---------------------------------- */
const server = await startServer();
log(`fixture server on ${ORIGIN}`);
try {
  await quitAppGracefully();

  await withApp(async (page) => {
    await closeFixtureTabs(page);
    await cleanVault(page);
    const tabId = await page.evaluate((u) => window.nt.tabsCreate({ url: u }), `${ORIGIN}/login`);
    assert(typeof tabId === 'string' && tabId, 'tabsCreate did not return a tab id');
    await waitTabLoaded(page, tabId, '/login');
    const body = await waitGuestBody(page, '/login', /Sign in/, 15000);
    assert(!!body, `login fixture did not render; serverRequests=${JSON.stringify(serverRequests.slice(-8))}`);

    await check21(page);
    await check22(page);
    await check23(page);
    await check24(page, tabId);
    await check25(page, tabId);

    await cleanVault(page);
    await closeFixtureTabs(page);
  });
} catch (e) {
  record('harness', 'broken', `script error: ${e.message}`);
} finally {
  server.close();
}

log('\n=== Phase 2 report ===');
for (const id of ['2.1', '2.2', '2.3', '2.4', '2.5']) {
  const r = results[id] || { status: 'manual', detail: 'not run' };
  log(`${id}: ${r.status} — ${r.detail}`);
}
try {
  execSync(`open "${INSTALLED_APP}"`, { stdio: 'ignore' });
  log('\nRelaunched Next Token for you.');
} catch { /* user can open it */ }
rmSync(TMP, { recursive: true, force: true });
process.exit(Object.values(results).some((r) => r.status === 'broken') ? 1 : 0);
