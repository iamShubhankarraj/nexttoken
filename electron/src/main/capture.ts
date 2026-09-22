/**
 * capture.ts — page output: system print dialog, Save-as-PDF, screenshots.
 *
 * - `nt.print.dialog`: `webContents.print()` → the native system print
 *   dialog for the active tab's page. (Chromium's own ⌘P print preview is
 *   left untouched in guests — this is the explicit Print action.)
 * - `nt.print.pdf`: `webContents.printToPDF()` → a save dialog → the file
 *   is written by main and announced through the SAME download IPC the
 *   guest download flow uses (`nt.downloads.event`), so the existing
 *   DownloadPill shows progress/completion with "Reveal in Finder".
 *   webengine.ts itself is read-only here — this module only emits the
 *   same event shapes.
 * - `nt.capture.screenshot`: `webContents.capturePage()` → copy the image
 *   to the clipboard, save it as a PNG through the downloads pill, or
 *   both. All three are explicit user actions from the reader toolbar /
 *   reader menu — nothing is captured silently.
 */
import { app, clipboard, dialog } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { guardedHandle } from './ipcGuard';
import type { Store } from './store';
import type { TabManager } from './tabs';
import type { DownloadUiEvent } from '../shared/ipc';

export interface CaptureDeps {
  store: Store;
  tabs: TabManager;
  /** The app window (for modal dialogs); may be null during teardown. */
  getWin: () => BrowserWindow | null;
  /** Emit a download-pill event (same channel webengine.ts uses). */
  sendDownload: (payload: DownloadUiEvent) => void;
}

export interface OpResult {
  ok: boolean;
  error?: string;
  /** Where the file landed (pdf / screenshot-file). */
  path?: string;
  /** Screenshot only: whether the image reached the clipboard. */
  copied?: boolean;
}

function targetTab(
  deps: CaptureDeps,
  tabId?: string
): { id: string; wc: WebContents } | null {
  const id = tabId || deps.tabs.activeTabId || '';
  if (!id) return null;
  const wc = deps.tabs.webContentsFor(id);
  if (!wc) return null;
  return { id, wc };
}

function pageTitle(wc: WebContents): string {
  try {
    return wc.getTitle() || 'page';
  } catch {
    return 'page';
  }
}

/** Filesystem-safe basename, capped — never trust a page title verbatim. */
function safeFilename(base: string, ext: string): string {
  const clean =
    (base || 'page')
      .replace(/[\\/:*?"<>|#%\s]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'page';
  return `${clean}.${ext}`;
}

async function pickSavePath(
  deps: CaptureDeps,
  title: string,
  defaultName: string,
  ext: string
): Promise<string | null> {
  const w = deps.getWin();
  const opts = {
    title,
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  };
  const res =
    w && !w.isDestroyed()
      ? await dialog.showSaveDialog(w, opts)
      : await dialog.showSaveDialog(opts);
  return res.canceled || !res.filePath ? null : res.filePath;
}

/** System print dialog for the tab's page. */
async function printDialog(
  deps: CaptureDeps,
  tabId?: string
): Promise<OpResult> {
  const t = targetTab(deps, tabId);
  if (!t) return { ok: false, error: 'no-tab' };
  try {
    await new Promise<void>((resolve, reject) => {
      try {
        // Callback form: print() itself returns void on WebContents.
        t.wc.print({}, (success, failureReason) => {
          if (success) resolve();
          else reject(new Error(failureReason || 'print-failed'));
        });
      } catch (e) {
        reject(e);
      }
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Cancelling the system dialog is not an error worth surfacing.
    if (/cancel/i.test(msg)) return { ok: false, error: 'cancelled' };
    return { ok: false, error: msg };
  }
}

/** Render the page to PDF and route it through the downloads pill. */
async function printPdf(deps: CaptureDeps, tabId?: string): Promise<OpResult> {
  const t = targetTab(deps, tabId);
  if (!t) return { ok: false, error: 'no-tab' };
  const id = `pdf-${Date.now().toString(36)}`;
  const filename = safeFilename(pageTitle(t.wc), 'pdf');
  const fail = (reason: string, error?: string): OpResult => {
    deps.sendDownload({ kind: 'failed', id, filename, reason });
    return { ok: false, error: error ?? reason };
  };
  let data: Buffer;
  try {
    data = await t.wc.printToPDF({});
  } catch (e) {
    return fail('pdf-failed', e instanceof Error ? e.message : String(e));
  }
  deps.sendDownload({ kind: 'started', id, filename });
  const filePath = await pickSavePath(deps, 'Save as PDF', filename, 'pdf');
  if (!filePath) return fail('cancelled');
  try {
    await fs.promises.writeFile(filePath, data);
  } catch (e) {
    return fail('write-failed', e instanceof Error ? e.message : String(e));
  }
  deps.sendDownload({ kind: 'done', id, filename, path: filePath });
  return { ok: true, path: filePath };
}

export type ScreenshotDest = 'clipboard' | 'file' | 'both';

/** Screenshot the tab: clipboard and/or a PNG via the downloads pill. */
async function screenshot(
  deps: CaptureDeps,
  opts?: { dest?: ScreenshotDest; tabId?: string }
): Promise<OpResult> {
  const dest: ScreenshotDest = opts?.dest ?? 'clipboard';
  const t = targetTab(deps, opts?.tabId);
  if (!t) return { ok: false, error: 'no-tab' };
  let img: Electron.NativeImage;
  try {
    img = await t.wc.capturePage();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'capture-failed' };
  }
  if (img.isEmpty()) return { ok: false, error: 'empty-capture' };
  const out: OpResult = { ok: true };
  if (dest === 'clipboard' || dest === 'both') {
    try {
      clipboard.writeImage(img);
      out.copied = true;
    } catch {
      out.copied = false;
    }
  }
  if (dest === 'file' || dest === 'both') {
    const id = `shot-${Date.now().toString(36)}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `screenshot-${stamp}.png`;
    const fail = (reason: string): void => {
      deps.sendDownload({ kind: 'failed', id, filename, reason });
    };
    deps.sendDownload({ kind: 'started', id, filename });
    const filePath = await pickSavePath(deps, 'Save screenshot', filename, 'png');
    if (!filePath) {
      fail('cancelled');
    } else {
      try {
        await fs.promises.writeFile(filePath, img.toPNG());
        deps.sendDownload({ kind: 'done', id, filename, path: filePath });
        out.path = filePath;
      } catch {
        fail('write-failed');
        out.ok = false;
        out.error = 'write-failed';
      }
    }
  }
  return out;
}

export function registerCaptureIpc(deps: CaptureDeps): void {
  guardedHandle('nt.print.dialog', async (_e, tabId?: string) =>
    printDialog(deps, tabId)
  );
  guardedHandle('nt.print.pdf', async (_e, tabId?: string) =>
    printPdf(deps, tabId)
  );
  guardedHandle(
    'nt.capture.screenshot',
    async (_e, opts?: { dest?: ScreenshotDest; tabId?: string }) =>
      screenshot(deps, opts)
  );
}
