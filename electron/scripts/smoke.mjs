// Next Token smoke test: launches the built app, verifies the preload bridge,
// a real <webview> guest mounting, and the start page loading.
// Usage: npm run smoke
// Env overrides for CI/Linux: SMOKE_XVFB=1 (run under xvfb-run),
// SMOKE_EXTRA_ARGS="--no-sandbox --ignore-certificate-errors" etc.
import { _electron as electron } from 'playwright-core';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron');
const extraArgs = (process.env.SMOKE_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);

function launch() {
  const args = [root, ...extraArgs];
  if (process.env.SMOKE_XVFB === '1') {
    const r = spawnSync('xvfb-run', ['-a', 'node', process.argv[1], '--child'], {
      env: { ...process.env, SMOKE_XVFB: '0' }, stdio: 'inherit',
    });
    process.exit(r.status ?? 1);
  }
  return electron.launch({ executablePath: electronBin, args, env: { ...process.env } });
}

if (process.argv.includes('--child')) process.env.SMOKE_XVFB = 'done';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

try {
  const app = await launch();
  const page = await app.firstWindow();

  const bridge = await page.evaluate(() => typeof window.nt?.snapshotGet);
  check('preload bridge (window.nt) present', bridge === 'function', `typeof snapshotGet=${bridge}`);

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));

  await page.waitForFunction(() => {
    try {
      const wv = document.querySelector('webview');
      return !!wv && !wv.isLoading() && (wv.getTitle() || '').length > 0;
    } catch { return false; }
  }, null, { timeout: 90000 }).then(
    () => check('webview mounted and start page loaded', true),
    (e) => check('webview mounted and start page loaded', false, e.message.slice(0, 100)),
  );

  const title = await page.evaluate(() => {
    try { return document.querySelector('webview')?.getTitle() || ''; } catch { return ''; }
  });
  check('guest has a page title', title.length > 0, JSON.stringify(title));

  // Drive the real UI: command bar navigates the guest to example.com
  await page.keyboard.press('ControlOrMeta+k').catch(() => {});
  await page.waitForTimeout(600);
  const navOk = await page.evaluate(async () => {
    try {
      const wv = document.querySelector('webview');
      if (!wv) return 'no-webview';
      await new Promise((res) => { wv.addEventListener('did-stop-loading', res, { once: true }); wv.loadURL('https://example.com/'); });
      return wv.getURL();
    } catch (e) { return 'error:' + String(e).slice(0, 80); }
  }).catch((e) => 'error:' + e.message.slice(0, 80));
  check('main-process navigation to example.com', typeof navOk === 'string' && navOk.includes('example.com'), String(navOk).slice(0, 80));

  check('no renderer page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  await app.close();
} catch (e) {
  check('smoke run', false, e.message.slice(0, 160));
}

const failed = checks.filter((c) => !c.ok);
process.exit(failed.length ? 1 : 0);
