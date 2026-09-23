/**
 * Pristine navigator.webdriver test — NO Playwright, NO CDP.
 * Boots the app with startup.pages pointed at a loopback page that POSTs its
 * JS identity back, waits for the report, then quits. Settings are backed up
 * and restored around the run; the fixture tab never touches disk.
 */
import http from 'node:http';
import fs from 'node:fs';
import { execSync, exec } from 'node:child_process';

const STORE = process.env.HOME + '/Library/Application Support/Next Token/next-token.json';
const BAK = '/tmp/next-token.json.phase1-bak';
const REPORT = '/tmp/nt-wd-report.json';
const APP = process.env.WD_APP || '/Applications/Next Token .app';
const PORT = 8919;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. quit any running copy
try { execSync(`osascript -e 'tell application id "com.nexttoken.app" to quit'`, { stdio: 'ignore' }); } catch {}
const t0 = Date.now();
while (Date.now() - t0 < 15000) {
  try { execSync(`pgrep -f 'MacOS/Next Token($| )'`, { stdio: 'ignore' }); await sleep(400); } catch { break; }
}
try { execSync(`pkill -f 'MacOS/Next Token($| )'`, { stdio: 'ignore' }); await sleep(1200); } catch {}

// 2. backup + patch startup.pages
fs.copyFileSync(STORE, BAK);
const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
store.startup = { mode: 'pages', pages: [`http://127.0.0.1:${PORT}/wd-report`], defaultBrowserNudged: true };
fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
fs.rmSync(REPORT, { force: true });

// 3. loopback reporter server
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/wd-post') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      fs.writeFileSync(REPORT, b);
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.url === '/wd-report') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<script>
      const send = () => fetch('/wd-post', { method: 'POST', keepalive: true, body: JSON.stringify({
        wd: navigator.webdriver,
        ua: navigator.userAgent,
        brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand + '|' + b.version),
      })});
      send(); setTimeout(send, 1500);
    </script>reporting…`);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', () => r()));

// 4. pristine launch via LaunchServices
exec(`open "${APP}"`);
let report = null;
const t1 = Date.now();
while (Date.now() - t1 < 30000) {
  await sleep(500);
  if (fs.existsSync(REPORT)) { await sleep(1500); report = JSON.parse(fs.readFileSync(REPORT, 'utf8')); break; }
}

// 5. quit + restore store (fixture tab record vanishes with the backup)
try { execSync(`osascript -e 'tell application id "com.nexttoken.app" to quit'`, { stdio: 'ignore' }); } catch {}
const t2 = Date.now();
while (Date.now() - t2 < 15000) {
  try { execSync(`pgrep -f 'MacOS/Next Token($| )'`, { stdio: 'ignore' }); await sleep(400); } catch { break; }
}
server.close();
fs.copyFileSync(BAK, STORE);
fs.rmSync(BAK, { force: true });

if (!report) {
  log('FAIL  pristine-wd — no report received (app did not reach the startup page in 30s)');
  process.exit(1);
}
log('=== pristine launch (no Playwright, no CDP) ===');
log(JSON.stringify(report, null, 2));
log(report.wd === false
  ? 'PASS  pristine-wd — navigator.webdriver === false outside Playwright (the true===true earlier was the harness\'s CDP attach)'
  : 'FAIL  pristine-wd — navigator.webdriver === ' + report.wd + ' in a plain launch: a real app-side automation flag');
process.exit(report.wd === false ? 0 : 1);
