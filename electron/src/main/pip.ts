/**
 * pip.ts — the custom Next Token Picture-in-Picture window.
 *
 * A small frameless, transparent, always-on-top window with real rounded
 * corners (~14px), warm-charcoal chrome and ember accents. It shows the
 * same live low-fps frame stream captured for the sidebar's curved media
 * viewfinder (webContents.capturePage, cropped to the video), with working
 * play/pause + close transport buttons. The body drags the window;
 * buttons are no-drag. It never steals focus: it appears with
 * showInactive() and frame updates never touch focus.
 *
 * Toggle semantics: opening while the window is already up closes it.
 * If the custom window can't attach (no video element / capture fails),
 * the native requestPictureInPicture path (with userGesture) is the
 * fallback.
 */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { TabManager } from './tabs';
import { allowIpcSender, revokeIpcSender } from './ipcGuard';
import { captureMediaThumb, enterNativePictureInPicture, hasPlayableVideo, toggleMedia } from './media';

let pipWin: BrowserWindow | null = null;
let pipTabId: string | null = null;
let frameTimer: NodeJS.Timeout | null = null;
let emptyFrames = 0;

function stopFrames(): void {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
}

/** Close and destroy the custom PiP window (safe to call when absent). */
export function closePipWindow(): void {
  stopFrames();
  pipTabId = null;
  emptyFrames = 0;
  const w = pipWin;
  pipWin = null;
  if (w) {
    try {
      revokeIpcSender(w.webContents.id);
    } catch {
      /* already gone */
    }
  }
  try {
    if (w && !w.isDestroyed()) w.close();
  } catch {
    /* noop */
  }
}

export function isPipOpen(): boolean {
  return !!pipWin && !pipWin.isDestroyed();
}

/** Stream fresh frames into the PiP window; close it when the video dies. */
function startFrames(tabs: TabManager, onRetire: () => void): void {
  stopFrames();
  frameTimer = setInterval(() => {
    void (async () => {
      const w = pipWin;
      const tabId = pipTabId;
      if (!w || w.isDestroyed() || !tabId) {
        closePipWindow();
        return;
      }
      // The tab closed or navigated away — retire the window.
      if (!tabs.webContentsFor(tabId)) {
        closePipWindow();
        return;
      }
      try {
        const dataUrl = await captureMediaThumb(tabs, tabId);
        if (!dataUrl) {
          emptyFrames += 1;
          // ~3s with no capturable video: retire to the native path so the
          // user still gets PiP instead of a silently-closed window.
          if (emptyFrames >= 8) {
            closePipWindow();
            onRetire();
          }
          return;
        }
        emptyFrames = 0;
        if (!w.isDestroyed()) w.webContents.send('nt-pip-frame', dataUrl);
      } catch {
        /* transient capture failure — keep the window, retry next tick */
      }
    })();
  }, 350);
}

/**
 * Toggle the custom PiP window for a tab (defaults to the active tab).
 * Returns {ok:false, error} when nothing could be shown — the renderer
 * surfaces the error in a toast.
 */
export async function togglePipWindow(
  tabs: TabManager,
  tabId?: string,
  /** Called with a toast message when an async fallback also fails (e.g. the custom window retires to native PiP and that fails too). */
  onAsyncError?: (message: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const targetId = tabId ?? tabs.activeTabId ?? undefined;
  // Toggle off when it's already up (same tab), or switch tabs.
  if (isPipOpen()) {
    if (pipTabId === targetId) {
      closePipWindow();
      return { ok: true };
    }
    closePipWindow();
  }
  const wc = targetId ? tabs.webContentsFor(targetId) : tabs.activeWebContents();
  if (!wc) return { ok: false, error: 'No video tab open.' };
  let playable = false;
  try {
    playable = await hasPlayableVideo(wc);
  } catch {
    playable = false;
  }
  if (!playable) {
    // No video element to attach to — the native path can't help either.
    return { ok: false, error: 'No playable video found on this page.' };
  }

  try {
    const mainBounds = (() => {
      try {
        const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        return d.workArea;
      } catch {
        return { x: 0, y: 0, width: 1440, height: 900 };
      }
    })();
    const w = 400;
    const h = 248;
    pipWin = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 240,
      minHeight: 160,
      x: Math.round(mainBounds.x + mainBounds.width - w - 28),
      y: Math.round(mainBounds.y + mainBounds.height - h - 28),
      frame: false,
      transparent: true,
      hasShadow: true,
      alwaysOnTop: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/pip.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true, // the PiP page needs no Node; the preload bridge is enough
      },
    });
    pipTabId = targetId ?? null;
    const pipWcId = pipWin.webContents.id;
    allowIpcSender(pipWcId);
    pipWin.on('closed', () => {
      revokeIpcSender(pipWcId);
      if (pipWin) {
        pipWin = null;
      }
      stopFrames();
      pipTabId = null;
    });
    await pipWin.loadFile(path.join(__dirname, '../renderer/pip.html'));
    // Never steal focus on appear.
    try {
      pipWin.showInactive();
    } catch {
      try {
        pipWin.show();
      } catch {
        /* noop */
      }
    }
    startFrames(tabs, () => {
      // Async retire: frame capture never produced a video, so hand off to
      // the native path instead of leaving the user with nothing.
      enterNativePictureInPicture(tabs, targetId).then(
        (r) => {
          if (!r.ok) onAsyncError?.(r.error ?? 'Picture in Picture failed.');
        },
        (e) => {
          onAsyncError?.(e instanceof Error ? e.message : 'Picture in Picture failed.');
        }
      );
    });
    return { ok: true };
  } catch (e) {
    closePipWindow();
    // Fallback: the page's own native PiP (userGesture grants activation).
    try {
      return await enterNativePictureInPicture(tabs, targetId);
    } catch {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'Picture in Picture failed.',
      };
    }
  }
}

/** Play/pause from the custom PiP window's transport button. */
export async function pipToggleTransport(
  tabs: TabManager
): Promise<{ paused: boolean }> {
  if (!pipTabId) return { paused: true };
  return toggleMedia(tabs, pipTabId);
}
