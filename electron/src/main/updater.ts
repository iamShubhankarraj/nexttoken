/**
 * In-app update plumbing — a purpose-built feed checker, NOT electron-updater.
 *
 * Why custom: Next Token ships UNSIGNED on macOS, and Squirrel.Mac (which
 * electron-updater delegates to) requires a valid Developer ID signature on
 * both the running app and the update to install anything — unsigned, the
 * native path errors out and nothing relaunches. So this module does the
 * honest version of "update like other browsers":
 *
 *   1. Poll a static `latest-mac.yml` feed (the same file electron-builder
 *      already emits next to the zip — zero packaging changes).
 *   2. Download the new zip with progress + sha512 verification.
 *   3. On "Restart to update": run a detached script that waits for the app
 *      to quit, renames the old .app to a .bak (rollback safety), moves the
 *      new .app into place, re-applies `xattr -cr` (the Gatekeeper ritual,
 *      automated), and relaunches.
 *
 * What it is NOT: silent background updates like Chrome. Unsigned, the best
 * achievable is one click to download + one click to restart (~10s scripted
 * swap). The Settings UI says exactly that — no fake seamlessness.
 *
 * Feed hosting: any static HTTPS host serving `latest-mac.yml` + the zip
 * (Cloudflare R2 is the recommendation: free, zero egress, proper HTTP
 * semantics). Google Drive is explicitly NOT viable for the feed
 * (quota 403s, virus-scan interstitials, no range requests). The feed URL
 * is configurable in Settings → Updates; empty = feature dormant.
 *
 * Security honesty: sha512 proves the bytes match the feed, not who authored
 * them. HTTPS-only, feed-URL changes require explicit user action. The real
 * fix remains Developer ID signing + notarization.
 */

import { app, dialog, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import { get as httpsGet, type RequestOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type { Store } from './store';

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'no-feed';

export interface UpdateStatus {
  /** This build's version. */
  version: string;
  feedUrl: string;
  autoCheck: boolean;
  lastCheckedAt: number | null;
  state: UpdateState;
  /** Set when state is 'available' | 'downloading' | 'downloaded'. */
  availableVersion?: string;
  availableSize?: number;
  /** 0–100 while downloading. */
  progressPct?: number;
  /** Human-readable detail for 'error' / 'no-feed' states. */
  detail?: string;
  /** Absolute path of the staged new .app (state 'downloaded'). */
  stagedAppPath?: string;
}

export type UpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; size: number }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; pct: number; bytesPerSec: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'no-feed' };

interface Deps {
  store: Store;
  /** Push an event to the renderer (win?.webContents.send). */
  send: (channel: string, payload: unknown) => void;
}

let deps: Deps | null = null;
let wired = false;
let state: UpdateState = 'idle';
let detail = '';
let availableVersion = '';
let availableSize = 0;
let progressPct = 0;
let stagedAppPath = '';
let stagedVersion = '';
let checkTimer: NodeJS.Timeout | null = null;

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LAUNCH_DELAY_MS = 30_000;
const FEED_FILE = 'latest-mac.yml';

function emit(e: UpdateEvent): void {
  try {
    deps?.send('nt.update-event', e);
  } catch {
    /* renderer gone — harmless */
  }
}

function feedBase(): string {
  const raw = (deps?.store.d.updates.feedUrl ?? '').trim().replace(/\/+$/, '');
  return raw;
}

/** Minimal extractor for the fixed electron-builder latest-mac.yml schema. */
function parseFeed(yml: string): { version: string; url: string; sha512: string; size: number } | null {
  const version = /^version:\s*['"]?([^\s'"]+)['"]?\s*$/m.exec(yml)?.[1];
  // First file entry under `files:` — url/sha512/size of the mac zip.
  const filesBlock = /files:\s*\n((?:[ \t]+-\s+[^\n]*\n(?:[ \t]+[^\n]*\n)*))/m.exec(yml)?.[1];
  let url = '';
  let sha512 = '';
  let size = 0;
  if (filesBlock) {
    url = /^[ \t]+url:\s*['"]?([^\s'"]+)['"]?/m.exec(filesBlock)?.[1] ?? '';
    sha512 = /^[ \t]+sha512:\s*['"]?([^\s'"]+)['"]?/m.exec(filesBlock)?.[1] ?? '';
    size = parseInt(/^[ \t]+size:\s*(\d+)/m.exec(filesBlock)?.[1] ?? '0', 10);
  }
  if (!version || !url) return null;
  return { version, url, sha512, size };
}

/** Compare dotted versions: >0 when a > b. */
function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function httpsGetFollow(url: string, maxRedirects = 5): Promise<import('node:http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const go = (u: string, left: number) => {
      const req = httpsGet(u, (res) => {
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && left > 0) {
          res.resume();
          go(new URL(loc, u).toString(), left - 1);
        } else {
          resolve(res);
        }
      });
      req.on('error', reject);
      req.setTimeout(30_000, () => req.destroy(new Error('request timed out')));
    };
    go(url, maxRedirects);
  });
}

async function fetchText(url: string): Promise<string> {
  const res = await httpsGetFollow(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`feed returned HTTP ${res.statusCode}`);
  }
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      body += c;
      if (body.length > 1024 * 1024) {
        res.destroy();
        reject(new Error('feed file unexpectedly large'));
      }
    });
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

export function updateStatus(): UpdateStatus {
  const s: UpdateStatus = {
    version: app.getVersion(),
    feedUrl: deps?.store.d.updates.feedUrl ?? '',
    autoCheck: deps?.store.d.updates.autoCheck ?? true,
    lastCheckedAt: deps?.store.d.updates.lastCheckedAt ?? null,
    state,
  };
  if (detail) s.detail = detail;
  if (availableVersion) {
    s.availableVersion = availableVersion;
    s.availableSize = availableSize;
  }
  if (state === 'downloading') s.progressPct = progressPct;
  if (state === 'downloaded' && stagedAppPath) s.stagedAppPath = stagedAppPath;
  return s;
}

function setState(next: UpdateState, nextDetail = ''): void {
  state = next;
  detail = nextDetail;
}

/** Check the feed for a newer version. Manual checks surface 'no-feed'. */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!deps || !app.isPackaged) return;
  if (state === 'checking' || state === 'downloading') return;
  const base = feedBase();
  if (!base) {
    setState('no-feed', 'No update feed configured yet — set one in Settings → Updates.');
    if (manual) emit({ type: 'no-feed' });
    return;
  }
  setState('checking');
  if (manual) emit({ type: 'checking' });
  try {
    const yml = await fetchText(`${base}/${FEED_FILE}`);
    const feed = parseFeed(yml);
    if (!feed) throw new Error('could not parse latest-mac.yml from the feed');
    deps.store.d.updates.lastCheckedAt = Date.now();
    deps.store.saveSoon();
    const current = app.getVersion();
    if (cmpVer(feed.version, current) > 0) {
      availableVersion = feed.version;
      availableSize = feed.size;
      setState('available');
      emit({ type: 'available', version: feed.version, size: feed.size });
    } else {
      availableVersion = '';
      setState('idle');
      if (manual) emit({ type: 'not-available', version: current });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setState('error', `Update check failed: ${msg}`);
    emit({ type: 'error', message: `Update check failed: ${msg}` });
  }
}

/**
 * Zip-slip guard for the update bundle: list the archive's entries before
 * extracting and refuse any absolute path or `..` segment. ditto would
 * otherwise happily write such entries outside the staging directory.
 */
async function assertArchiveContained(zipPath: string): Promise<void> {
  const out: string = await new Promise((resolve, reject) => {
    execFile('/usr/bin/unzip', ['-l', zipPath], { timeout: 60_000 }, (err, stdout) => {
      if (err) reject(new Error(`could not list update archive: ${err.message}`));
      else resolve(String(stdout));
    });
  });
  const bad: string[] = [];
  for (const line of out.split('\n')) {
    // unzip -l rows look like: "   1234  2026-01-01 00:00   path/to/entry"
    const m = /^\s*\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (
      name.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(name) ||
      /(^|[\\/])\.\.([\\/]|$)/.test(name)
    ) {
      bad.push(name);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `update archive contains unsafe paths (${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}) — discarded`
    );
  }
}

/** Download the staged update zip with progress + sha512 verification. */
export async function downloadUpdate(): Promise<void> {
  if (!deps || !app.isPackaged) return;
  if (state !== 'available' || !availableVersion) return;
  const base = feedBase();
  if (!base) {
    setState('no-feed', 'No update feed configured.');
    emit({ type: 'no-feed' });
    return;
  }
  setState('downloading');
  progressPct = 0;
  const stageDir = join(tmpdir(), `next-token-update-${availableVersion}`);
  try {
    const yml = await fetchText(`${base}/${FEED_FILE}`);
    const feed = parseFeed(yml);
    if (!feed || feed.version !== availableVersion) {
      throw new Error('feed changed during download — re-check for updates');
    }
    const fileUrl = new URL(feed.url, `${base}/`).toString();
    await fsp.rm(stageDir, { recursive: true, force: true });
    await fsp.mkdir(stageDir, { recursive: true });
    const zipPath = join(stageDir, basename(feed.url));

    const res = await httpsGetFollow(fileUrl);
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`download returned HTTP ${res.statusCode}`);
    }
    const total = parseInt(res.headers['content-length'] ?? String(feed.size || 0), 10) || 0;
    const hash = createHash('sha512');
    let received = 0;
    const t0 = Date.now();
    let lastEmit = 0;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(zipPath);
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        if (total > 0) {
          progressPct = Math.min(99, Math.round((received / total) * 100));
          const now = Date.now();
          if (now - lastEmit > 500) {
            lastEmit = now;
            const bps = received / Math.max(1, (now - t0) / 1000);
            emit({ type: 'progress', pct: progressPct, bytesPerSec: Math.round(bps) });
          }
        }
      });
      res.on('end', () => {
        out.end(() => resolve());
      });
      res.on('error', (e) => {
        out.destroy();
        reject(e);
      });
      out.on('error', reject);
      res.pipe(out);
    });

    // Verify before trusting a single byte.
    const digest = hash.digest('base64');
    if (feed.sha512 && digest !== feed.sha512) {
      await fsp.rm(zipPath, { force: true });
      throw new Error('checksum mismatch — the download was discarded, nothing was installed');
    }

    // Unzip (ditto preserves macOS metadata); the zip's top level is Next Token.app.
    // Zip-slip guard first: refuse archives with absolute or `..` entries.
    await assertArchiveContained(zipPath);
    const extractDir = join(stageDir, 'extracted');
    await fsp.mkdir(extractDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir], { timeout: 120_000 }, (err) => {
        if (err) reject(new Error(`failed to unzip the update: ${err.message}`));
        else resolve();
      });
    });
    const entries = await fsp.readdir(extractDir);
    const appBundle = entries.find((e) => e.endsWith('.app'));
    if (!appBundle) throw new Error('the update zip did not contain an .app bundle');
    stagedAppPath = join(extractDir, appBundle);
    stagedVersion = feed.version;
    await fsp.rm(zipPath, { force: true }); // zip no longer needed
    progressPct = 100;
    setState('downloaded');
    emit({ type: 'downloaded', version: feed.version });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setState('error', msg);
    emit({ type: 'error', message: msg });
    // Never leave a half-staged update on disk — the next attempt starts clean.
    try {
      await fsp.rm(stageDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    stagedAppPath = '';
    stagedVersion = '';
  }
}

function exeAppPath(): string {
  // .../Next Token.app/Contents/MacOS/Next Token → .../Next Token.app
  return dirname(dirname(dirname(app.getPath('exe'))));
}

/**
 * Install the staged update and restart. Writes a detached script that:
 * waits for this app to quit → renames the old .app to .bak → moves the new
 * .app into place → xattr -cr (Gatekeeper ritual, automated) → relaunches.
 *
 * Guards: App Translocation (read-only copy) and non-writable bundle dirs
 * fall back to a guided manual install instead of failing silently.
 */

/** Single-quote a string for POSIX shell (JSON.stringify is NOT shell-safe). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function installUpdate(): Promise<void> {
  if (!deps || state !== 'downloaded' || !stagedAppPath) return;
  const oldApp = exeAppPath();
  const exePath = app.getPath('exe');

  if (exePath.includes('AppTranslocation')) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Manual install needed',
      message: 'Next Token is running from a translocated copy.',
      detail:
        'Move Next Token.app to /Applications (or ~/Applications) first, then check for updates again. ' +
        'In-place update cannot work from a read-only translocated copy.',
      buttons: ['OK'],
    });
    return;
  }

  const bundleDir = dirname(oldApp);
  let writable = false;
  try {
    await fsp.access(bundleDir, 0o2 /* W_OK */);
    writable = true;
  } catch {
    writable = false;
  }

  if (!writable) {
    // Graceful degradation: hand the user the new .app in Downloads.
    const dest = join(app.getPath('downloads'), `${basename(stagedAppPath, '.app')} ${stagedVersion}.app`);
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(stagedAppPath, dest);
    shell.showItemInFolder(dest);
    setState('idle');
    await dialog.showMessageBox({
      type: 'info',
      title: 'Almost there — one manual step',
      message: `Next Token ${stagedVersion} is downloaded.`,
      detail:
        `The new app is in your Downloads folder (just revealed in Finder).\n\n` +
        `1. Drag it to Applications and choose Replace.\n` +
        `2. In Terminal, run: xattr -cr "/Applications/Next Token.app"\n` +
        `3. Relaunch Next Token.\n\n` +
        `In-place update needs write access to ${bundleDir}.`,
      buttons: ['OK'],
    });
    return;
  }

  const backupApp = oldApp.replace(/\.app$/, '.bak.app');
  const scriptPath = join(tmpdir(), `nt-update-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -u
OLD_APP=${shQuote(oldApp)}
NEW_APP=${shQuote(stagedAppPath)}
BACKUP_APP=${shQuote(backupApp)}
APP_NAME=${shQuote(app.getName())}
# Wait for the running app to fully quit (up to 60s).
for i in $(seq 1 60); do
  pgrep -x "$APP_NAME" >/dev/null || break
  sleep 1
done
rm -rf "$BACKUP_APP"
mv "$OLD_APP" "$BACKUP_APP" || exit 1
mv "$NEW_APP" "$OLD_APP" || { mv "$BACKUP_APP" "$OLD_APP"; exit 1; }
xattr -cr "$OLD_APP" || true
open "$OLD_APP"
rm -rf "$BACKUP_APP"
rm -f ${shQuote(scriptPath)}
`;
  await fsp.writeFile(scriptPath, script, { mode: 0o755 });
  // Detach: the script outlives us; then quit so it can do the swap.
  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
  child.unref();
  app.quit();
}

/** Wire up launch + interval checks. Call once from app ready. */
export function setupUpdater(d: Deps): void {
  deps = d;
  if (wired) return;
  wired = true;
  if (!app.isPackaged) return;

  const schedule = () => {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => {
      if (deps?.store.d.updates.autoCheck !== false) void checkForUpdates(false);
    }, CHECK_INTERVAL_MS);
    checkTimer.unref?.();
  };

  // Launch check (delayed so it never slows startup) + 12h interval.
  setTimeout(() => {
    if (deps?.store.d.updates.autoCheck !== false) void checkForUpdates(false);
    schedule();
  }, LAUNCH_DELAY_MS);
  schedule();
}

/** Manual "Check for updates" entry point (menu item / IPC). */
export async function checkForUpdatesManually(): Promise<void> {
  if (!feedBase()) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Updates not configured',
      message: 'Automatic updates are not set up for this build yet.',
      detail: 'Set an update feed URL in Settings → Updates, then check again.',
      buttons: ['OK'],
    });
    return;
  }
  await checkForUpdates(true);
  // checkForUpdates emits events; the Settings UI surfaces them. For the
  // menu path with nothing to show, the state stays quiet by design.
}

export function setFeedUrl(url: string): void {
  if (!deps) return;
  const v = url.trim().replace(/\/+$/, '');
  // The feed is fetched and its bytes become a new app bundle — plain http
  // (or file:/etc. schemes) would let a network attacker or a pasted typo
  // serve a malicious update. Empty clears the feed (feature dormant).
  if (v && !/^https:\/\//i.test(v)) {
    throw new Error('Update feed URL must be an https:// URL.');
  }
  deps.store.d.updates.feedUrl = v;
  deps.store.saveSoon();
}

export function setAutoCheck(on: boolean): void {
  if (!deps) return;
  deps.store.d.updates.autoCheck = on;
  deps.store.saveSoon();
}
