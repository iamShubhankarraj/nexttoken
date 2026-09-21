/**
 * webengine.ts — makes the <webview> guest session behave like a real
 * browser engine. Covers the gaps users hit in the wild:
 *
 * 1. Chrome UA spoof — guests send a genuine Chrome-macOS user agent.
 *    The raw Electron token ("… Electron/39 …") makes Google distrust
 *    sign-in ("This browser or app may not be secure") and degrades other
 *    sites. The version tracks the bundled Chromium.
 * 2. Permission requests — explicit handler on the guest session. Benign
 *    capabilities auto-allow, sensitive ones (camera/mic, location,
 *    notifications, screen share, external apps…) ask the user with a
 *    native prompt. WebAuthn / platform authenticators (Touch ID) are
 *    handled natively by Chromium and never route through this handler,
 *    so passkeys are never blocked here.
 * 3. Downloads — a save dialog for every guest download (no more silent
 *    drops into ~/Downloads), with progress + completion mirrored to the
 *    renderer for the downloads pill. "Save Image As…" arms its own path
 *    and skips the dialog.
 *
 * File choosers (<input type=file>) and JS dialogs (alert/confirm/prompt,
 * beforeunload) already work in webviews via Chromium defaults — no code
 * needed.
 */
import { app, dialog, session, shell } from 'electron';
import type { BrowserWindow, DownloadItem, WebContents } from 'electron';
import path from 'node:path';
import type { DownloadUiEvent } from '../shared/ipc';

/** The partition every tab webview declares. */
export const GUEST_PARTITION = 'persist:nexttoken';

/**
 * Genuine Chrome-macOS user agent with the bundled Chromium's version.
 * No Electron token anywhere in the string.
 */
export function chromeUserAgent(): string {
  const chrome = process.versions.chrome || '140.0.0.0';
  return (
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
  );
}

export interface WebEngineDeps {
  /** The app window (for modal dialogs); may be null during teardown. */
  getWin: () => BrowserWindow | null;
  /** Guarded win.webContents.send. */
  send: (channel: 'nt.downloads.event', payload: DownloadUiEvent) => void;
}

/** URLs armed by "Save Image As…" — that flow already chose its own path. */
const imageSaveArmed = new Set<string>();
export function noteImageSave(url: string): void {
  imageSaveArmed.add(url);
  if (imageSaveArmed.size > 32) {
    const first = imageSaveArmed.values().next();
    if (!first.done) imageSaveArmed.delete(first.value);
  }
}

const PERMISSION_LABELS: Record<string, string> = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'send you notifications',
  'clipboard-read': 'read your clipboard',
  openExternal: 'open an external application',
  'display-capture': 'share your screen',
  fileSystem: 'access files on your device',
  'window-management': 'manage windows on your displays',
  'speaker-selection': 'choose audio output devices',
  'idle-detection': 'detect when you are idle',
  keyboardLock: 'capture keyboard shortcuts',
  midi: 'use MIDI devices',
  fullscreen: 'use fullscreen',
  pointerLock: 'hide the cursor for pointer lock',
  'clipboard-sanitized-write': 'write to your clipboard',
  'storage-access': 'access third-party storage',
  'top-level-storage-access': 'access third-party storage',
};

/** Native allow/block prompt for a sensitive permission request. */
async function askPermission(
  deps: WebEngineDeps,
  wc: WebContents,
  permission: string,
  details: unknown,
): Promise<boolean> {
  let host = 'This site';
  try {
    const u = (details as { requestingUrl?: string } | null)?.requestingUrl
      ?? wc.getURL();
    const h = new URL(u).hostname;
    if (h) host = h;
  } catch {
    /* keep the fallback */
  }
  const what = PERMISSION_LABELS[permission] ?? 'request a browser permission';
  const w = deps.getWin();
  try {
    const opts = {
      type: 'question' as const,
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      message: `${host} wants to ${what}`,
      detail: 'You can change this later in Settings → Privacy.',
    };
    const { response } = w && !w.isDestroyed()
      ? await dialog.showMessageBox(w, opts)
      : await dialog.showMessageBox(opts);
    return response === 0;
  } catch {
    return false;
  }
}

export function setupGuestSession(deps: WebEngineDeps): void {
  const ses = session.fromPartition(GUEST_PARTITION);

  // 1 — Chrome UA on the guest session (covers every tab webview).
  ses.setUserAgent(chromeUserAgent());

  // 2 — permission requests.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const p = permission as string;
    // Benign capabilities: always allow.
    if (
      p === 'fullscreen' ||
      p === 'pointerLock' ||
      p === 'clipboard-sanitized-write' ||
      p === 'window-management' ||
      p === 'keyboardLock' ||
      p === 'idle-detection' ||
      p === 'speaker-selection' ||
      p === 'storage-access' ||
      p === 'top-level-storage-access'
    ) {
      callback(true);
      return;
    }
    // MIDI sysex: never useful for browsing; deny quietly.
    if (p === 'midi' || p === 'midiSysex') {
      callback(false);
      return;
    }
    // Sensitive (camera/mic, location, notifications, screen share,
    // external apps, …): ask the user. WebAuthn never reaches this
    // handler — Chromium drives the authenticator UI natively.
    void askPermission(deps, wc, p, details).then(callback, () => callback(false));
  });

  // 3 — downloads: save dialog + progress mirrored to the renderer.
  let dlSeq = 0;
  ses.on('will-download', (_event, item: DownloadItem) => {
    // "Save Image As…" already picked a destination — don't double-prompt.
    if (imageSaveArmed.delete(item.getURL())) return;
    const id = `dl-${Date.now().toString(36)}-${dlSeq++}`;
    const filename = item.getFilename() || 'download';
    const send = (payload: DownloadUiEvent): void => {
      try {
        deps.send('nt.downloads.event', payload);
      } catch {
        /* renderer gone */
      }
    };
    // Pause immediately so nothing lands in the default folder before the
    // user picks a destination.
    try {
      item.pause();
    } catch {
      /* best effort */
    }
    void (async () => {
      const w = deps.getWin();
      const saveOpts = {
        title: 'Save file',
        defaultPath: path.join(app.getPath('downloads'), filename),
      };
      const { canceled, filePath } =
        w && !w.isDestroyed()
          ? await dialog.showSaveDialog(w, saveOpts)
          : await dialog.showSaveDialog(saveOpts);
      if (canceled || !filePath) {
        try {
          item.cancel();
        } catch {
          /* noop */
        }
        send({ kind: 'failed', id, filename, reason: 'cancelled' });
        return;
      }
      try {
        item.setSavePath(filePath);
      } catch {
        try {
          item.cancel();
        } catch {
          /* noop */
        }
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
        const percent = total > 0 ? Math.round((received / total) * 100) : -1;
        if (percent !== lastPct) {
          lastPct = percent;
          send({ kind: 'progress', id, filename, received, total, percent });
        }
      });
      item.on('done', (_e, state) => {
        if (state === 'completed') {
          let saved = '';
          try {
            saved = item.getSavePath();
          } catch {
            /* noop */
          }
          send({ kind: 'done', id, filename, path: saved });
        } else {
          send({ kind: 'failed', id, filename, reason: state });
        }
      });
    })();
  });
}

/** Reveal a finished download in Finder. */
export async function revealDownload(targetPath: string): Promise<void> {
  try {
    if (targetPath) shell.showItemInFolder(targetPath);
  } catch {
    /* noop */
  }
}
