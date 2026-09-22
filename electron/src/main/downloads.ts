/**
 * downloads.ts — guest download manager (v0.6.3, impl-5).
 *
 * Owns the guest session's `will-download` handling (delegated from
 * webengine.ts so webengine keeps its UA/permission focus), the live
 * DownloadItem registry that powers pause/resume/cancel/retry, the
 * download-location + auto-open settings, and an in-memory record list
 * (last 120) for the Downloads page. Progress/completion events keep
 * flowing on 'nt.downloads.event' so the DownloadPill is untouched.
 */
import { app, dialog, shell } from 'electron';
import type { DownloadItem } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { WebEngineDeps } from './webengine';
import type { Store } from './store';
import type { DownloadRecord, DownloadUiEvent } from '../shared/ipc';

/** Live items keyed by the UI id we hand to the renderer. */
const liveItems = new Map<string, DownloadItem>();
/** Recent records, newest first, capped. In-memory only (not persisted). */
const records = new Map<string, DownloadRecord>();

const MAX_RECORDS = 120;

let dlSeq = 0;

function defaultDir(store: Store): string {
  const configured = store.d.downloads.dir;
  if (configured && typeof configured === 'string') {
    try {
      if (fs.statSync(configured).isDirectory()) return configured;
    } catch {
      /* configured dir vanished — fall through to the dialog */
    }
  }
  return app.getPath('downloads');
}

/** Pick a non-colliding path inside `dir` for `filename`. */
function uniquePath(dir: string, filename: string): string {
  const safe = path.basename(filename).replace(/^\.+/, '') || 'download';
  let candidate = path.join(dir, safe);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  for (let i = 2; i < 1000; i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return candidate;
}

/** Send one event to the renderer (the pill + the downloads page listen). */
function makeSend(deps: WebEngineDeps) {
  return (payload: DownloadUiEvent): void => {
    try {
      deps.send('nt.downloads.event', payload);
    } catch {
      /* renderer gone */
    }
  };
}

function pruneRecords() {
  if (records.size <= MAX_RECORDS) return;
  const keys = [...records.keys()];
  for (let i = MAX_RECORDS; i < keys.length; i++) records.delete(keys[i]);
}

/**
 * The guest session's will-download handler. Mirrors the original
 * webengine.ts behavior (pause immediately, save dialog, progress mirror)
 * plus: an optional fixed download folder (skips the dialog), auto-open
 * file types, and the live registry behind pause/resume/cancel/retry.
 */
export function handleWillDownload(deps: WebEngineDeps, item: DownloadItem): void {
  const store = deps.store;
  const send = makeSend(deps);
  const id = `dl-${Date.now().toString(36)}-${dlSeq++}`;
  // Never let a crafted Content-Disposition filename smuggle path
  // separators into the suggested save path.
  const filename = path.basename(item.getFilename() || 'download') || 'download';
  let url = '';
  try {
    url = item.getURL() || '';
  } catch {
    /* noop */
  }
  const record: DownloadRecord = {
    id,
    filename,
    url,
    received: 0,
    total: -1,
    state: 'active',
    startedAt: Date.now(),
  };
  records.set(id, record);
  pruneRecords();
  liveItems.set(id, item);

  // Pause immediately so nothing lands in the default folder before the
  // user picks a destination (or before we set the configured one).
  try {
    item.pause();
  } catch {
    /* best effort */
  }

  void (async () => {
    const fixedDir = store.d.downloads.dir;
    let filePath: string | null = null;
    if (fixedDir) {
      const dir = defaultDir(store);
      if (dir === fixedDir) {
        // Configured folder exists — skip the dialog, dedupe the name.
        filePath = uniquePath(dir, filename);
      }
    }
    if (!filePath) {
      const w = deps.getWin();
      const saveOpts = {
        title: 'Save file',
        defaultPath: path.join(defaultDir(store), filename),
      };
      const { canceled, filePath: picked } =
        w && !w.isDestroyed()
          ? await dialog.showSaveDialog(w, saveOpts)
          : await dialog.showSaveDialog(saveOpts);
      if (canceled || !picked) {
        try {
          item.cancel();
        } catch {
          /* noop */
        }
        record.state = 'cancelled';
        record.endedAt = Date.now();
        record.reason = 'cancelled';
        liveItems.delete(id);
        send({ kind: 'failed', id, filename, reason: 'cancelled' });
        return;
      }
      filePath = picked;
    }
    try {
      item.setSavePath(filePath);
    } catch {
      try {
        item.cancel();
      } catch {
        /* noop */
      }
      record.state = 'failed';
      record.endedAt = Date.now();
      record.reason = 'save-path';
      liveItems.delete(id);
      send({ kind: 'failed', id, filename, reason: 'save-path' });
      return;
    }
    try {
      item.resume();
    } catch {
      /* noop */
    }
    send({ kind: 'started', id, filename });
    let lastPct = -1;
    item.on('updated', () => {
      const received = item.getReceivedBytes();
      const total = item.getTotalBytes();
      record.received = received;
      record.total = total;
      const percent = total > 0 ? Math.round((received / total) * 100) : -1;
      if (percent !== lastPct) {
        lastPct = percent;
        send({ kind: 'progress', id, filename, received, total, percent });
      }
    });
    item.on('done', (_e, state) => {
      liveItems.delete(id);
      record.endedAt = Date.now();
      if (state === 'completed') {
        let saved = '';
        try {
          saved = item.getSavePath();
        } catch {
          /* noop */
        }
        record.state = 'done';
        record.path = saved || undefined;
        record.received = record.total > 0 ? record.total : record.received;
        send({ kind: 'done', id, filename, path: saved });
        // Auto-open file types the user explicitly opted into (Settings →
        // Downloads). The click-less open is exactly what they asked for.
        const ext = path.extname(saved).slice(1).toLowerCase();
        if (ext && store.d.downloads.autoOpenTypes.includes(ext)) {
          void shell.openPath(saved).catch(() => {});
        }
      } else {
        record.state = state === 'cancelled' ? 'cancelled' : 'failed';
        record.reason = state;
        send({ kind: 'failed', id, filename, reason: state });
      }
    });
  })();
}

/** Newest-first records for the Downloads page. */
export function listRecords(): DownloadRecord[] {
  return [...records.values()];
}

function liveItem(id: string): DownloadItem | null {
  const item = liveItems.get(id);
  if (!item) return null;
  try {
    if ((item as { isDestroyed?: () => boolean }).isDestroyed?.()) {
      liveItems.delete(id);
      return null;
    }
  } catch {
    /* noop */
  }
  return item;
}

export function pauseDownload(id: string): boolean {
  const item = liveItem(id);
  const record = records.get(id);
  if (!item || !record) return false;
  try {
    item.pause();
  } catch {
    return false;
  }
  record.state = 'paused';
  emitEvent({ kind: 'paused', id, filename: record.filename });
  return true;
}

export function resumeDownload(id: string): boolean {
  const item = liveItem(id);
  const record = records.get(id);
  if (!item || !record) return false;
  try {
    item.resume();
  } catch {
    return false;
  }
  record.state = 'active';
  emitEvent({ kind: 'resumed', id, filename: record.filename });
  return true;
}

export function cancelDownload(id: string): boolean {
  const item = liveItem(id);
  if (!item) return false;
  try {
    item.cancel(); // the 'done' handler marks the record + sends the event
  } catch {
    return false;
  }
  return true;
}

/** Re-download via the given webContents (guest session, so auth travels). */
export function retryDownload(
  id: string,
  wc: { downloadURL: (url: string) => void } | null
): boolean {
  const record = records.get(id);
  if (!record || !record.url || !wc) return false;
  if (record.state !== 'failed' && record.state !== 'cancelled') return false;
  try {
    wc.downloadURL(record.url);
  } catch {
    return false;
  }
  return true;
}

/** Drop finished records (done/failed/cancelled) from the list. */
export function clearFinished(): void {
  for (const [id, r] of records) {
    if (r.state !== 'active' && r.state !== 'paused') records.delete(id);
  }
}

/** Event emitter for pause/resume (no live webContents needed). Bound once at startup. */
let emit: ((payload: DownloadUiEvent) => void) | null = null;
function emitEvent(payload: DownloadUiEvent): void {
  try {
    emit?.(payload);
  } catch {
    /* noop */
  }
}

/** Called once from index.ts so pause/resume events reach the renderer. */
export function bindSend(send: (payload: DownloadUiEvent) => void): void {
  emit = send;
}

/** Reveal a finished download in Finder (unchanged behavior). */
export async function revealDownload(targetPath: string): Promise<void> {
  try {
    // Absolute paths only — this must never become a relative-path surprise.
    if (targetPath && path.isAbsolute(targetPath)) shell.showItemInFolder(targetPath);
  } catch {
    /* noop */
  }
}

/** Open a finished download with its default app (absolute path only). */
export async function openDownload(targetPath: string): Promise<void> {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return;
  try {
    if (targetPath) await shell.openPath(targetPath);
  } catch {
    /* noop */
  }
}

/** Clean settings getter: { dir: null } = "ask where to save each time". */
export function getDownloadSettings(store: Store): {
  dir: string | null;
  defaultDir: string;
} {
  return { dir: store.d.downloads.dir, defaultDir: defaultDir(store) };
}

/** Ask the user to pick a download folder (persists when picked). */
export async function pickDownloadDir(store: Store): Promise<string | null> {
  const res = await dialog
    .showOpenDialog({
      title: 'Choose download folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    .catch(() => null);
  if (!res || res.canceled || res.filePaths.length === 0) return store.d.downloads.dir;
  store.d.downloads.dir = res.filePaths[0] ?? null;
  store.saveSoon();
  return store.d.downloads.dir;
}

/** Clean + persist the auto-open extension list (lowercase, no dots). */
export function setAutoOpenTypes(store: Store, exts: string[]): string[] {
  const clean = [
    ...new Set(
      (exts ?? [])
        .map((e) => String(e ?? '').trim().toLowerCase().replace(/^\./, ''))
        .filter((e) => /^[a-z0-9]{1,10}$/.test(e))
    ),
  ].slice(0, 20);
  store.d.downloads.autoOpenTypes = clean;
  store.saveSoon();
  return clean;
}
