/**
 * pip.ts — Picture-in-Picture.
 *
 * NATIVE FIRST. `togglePipWindow` hands the video to the page's own
 * requestPictureInPicture() so it goes to the OS compositor and plays at
 * display refresh rate — behaving exactly like PiP in Safari or Chrome.
 *
 * The custom window below is the FALLBACK, for pages that refuse native PiP
 * (DRM-gated players, sites that gate it behind an account). It is a small
 * frameless, transparent, always-on-top window with real rounded corners
 * (~14px), warm-charcoal chrome and ember accents, showing a live low-fps
 * frame stream (webContents.capturePage, cropped to the video) with working
 * play/pause + close transport buttons; the body drags the window and the
 * buttons are no-drag. It appears with showInactive() so it never steals
 * focus.
 *
 * WHY IT IS ONLY A FALLBACK: a screenshot stream is not video. It is capped
 * at ~3fps, and `capturePage()` on a tab that isn't painting (a background
 * tab's <webview> is `display: none`) returns an empty image entirely — so
 * the window looks jittery, then stutters, then appears frozen. No amount of
 * tuning the capture rate fixes that; only the native path is real video.
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
        // 640px frames: crisp in the PiP window incl. Retina (the old 160px thumbs were
        // visibly blurry when upscaled).
        const dataUrl = await captureMediaThumb(tabs, tabId, 640);
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
 * Toggle Picture-in-Picture for a tab (defaults to the active tab): native
 * PiP first, the custom branded window as the fallback. Returns
 * {ok:false, error} when neither could show anything — the renderer surfaces
 * the error in a toast.
 */
export async function togglePipWindow(
  tabs: TabManager,
  tabId?: string,
  /** Called with a toast message when an async fallback also fails (e.g. the custom window retires to native PiP and that fails too). */
  onAsyncError?: (message: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const targetId = tabId ?? tabs.activeTabId ?? undefined;
  // Toggle off when it's already up (same tab), or switch tabs. Must be read
  // before closePipWindow(), which clears pipTabId.
  if (isPipOpen()) {
    const wasTab = pipTabId;
    closePipWindow();
    if (wasTab === targetId) return { ok: true };
  }
  const wc = targetId ? tabs.webContentsFor(targetId) : tabs.activeWebContents();
  if (!wc) return { ok: false, error: 'No video tab open.' };

  // 1) NATIVE PiP. Real video on the OS compositor: display refresh rate,
  //    smooth window drag/resize, correct behaviour on full-screen apps and
  //    Spaces. It also self-toggles (exits when a PiP element already
  //    exists), which is what makes the button a true toggle here too.
  const native = await enterNativePictureInPicture(tabs, targetId);
  if (native.ok) return native;

  // 2) Fallback: the branded Next Token window (screenshot stream). Only
  //    worth building when the page really has a video element — otherwise
  //    native already told us there is nothing here, and it reuses the same
  //    "best video" heuristic.
  let playable = false;
  try {
    playable = await hasPlayableVideo(wc);
  } catch {
    playable = false;
  }
  if (!playable) {
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
    // Native PiP was already attempted above and refused, so there is no
    // second fallback left — report why the custom window couldn't attach.
    closePipWindow();
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Picture in Picture failed.',
    };
  }
}

/** Play/pause from the custom PiP window's transport button. */
export async function pipToggleTransport(
  tabs: TabManager
): Promise<{ paused: boolean }> {
  if (!pipTabId) return { paused: true };
  return toggleMedia(tabs, pipTabId);
}
