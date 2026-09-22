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
 *    native prompt. Decisions persist per origin ("Always allow"/"Block"
 *    are remembered; editable in Settings → Privacy & security), and
 *    permission defaults can be changed there too. FedCM
 *    (`identity-credentials-get`, Google "Sign in with" flows) is denied
 *    quietly — prompting its retries was the endless-permission-popup bug;
 *    denying lets the flow fall back to popup OAuth, which routes to a tab.
 *    WebAuthn / platform authenticators (Touch ID) are handled natively by
 *    Chromium and never route through this handler, so passkeys are never
 *    blocked here.
 * 3. Downloads — a save dialog for every guest download (no more silent
 *    drops into ~/Downloads), with progress + completion mirrored to the
 *    renderer for the downloads pill. "Save Image As…" arms its own path
 *    and skips the dialog.
 *
 * File choosers (<input type=file>) and JS dialogs (alert/confirm/prompt,
 * beforeunload) already work in webviews via Chromium defaults — no code
 * needed.
 */
import { dialog, session, shell } from 'electron';
import type { BrowserWindow, DownloadItem, WebContents } from 'electron';
import path from 'node:path';
import type { Store } from './store';
import type { DownloadUiEvent } from '../shared/ipc';
import { handleWillDownload } from './downloads';

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
  /** Persisted per-site permission decisions + defaults. */
  store: Store;
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
const inflightPermissionDialogs = new Set<string>();

async function askPermission(
  deps: WebEngineDeps,
  wc: WebContents,
  permission: string,
  origin: string,
  details: unknown,
): Promise<boolean> {
  let host = 'This site';
  try {
    const h = new URL(origin).hostname;
    if (h) host = h;
  } catch {
    /* keep the fallback */
  }
  const what = PERMISSION_LABELS[permission] ?? 'request a browser permission';
  const w = deps.getWin();
  try {
    const opts = {
      type: 'question' as const,
      buttons: ['Allow once', 'Always allow', 'Block'],
      defaultId: 0,
      cancelId: 2,
      message: `${host} wants to ${what}`,
      // The raw permission name is included so unknown future permissions
      // are diagnosable from the dialog itself.
      detail:
        `Always allow and Block are remembered for ${host} — ` +
        `change them anytime in Settings → Privacy & security.\n(${permission})`,
    };
    const { response } = w && !w.isDestroyed()
      ? await dialog.showMessageBox(w, opts)
      : await dialog.showMessageBox(opts);
    const perms = deps.store.d.privacy.permissions;
    if (response === 1) {
      // Always allow — remember for this origin.
      perms[origin] = { ...(perms[origin] ?? {}), [permission]: 'allow' };
      deps.store.saveSoon();
      return true;
    }
    if (response === 2) {
      // Block — remember for this origin.
      perms[origin] = { ...(perms[origin] ?? {}), [permission]: 'block' };
      deps.store.saveSoon();
      return false;
    }
    return true; // Allow once.
  } catch {
    return false;
  }
}

/**
 * Permissions that must never surface a prompt — they are either
 * unsupported in an embedded context or inherently noisy:
 *
 * - `identity-credentials-get` (FedCM): Google Identity Services
 *   ("Sign in with Google") calls navigator.credentials.get({identity})
 *   and retries on failure. Prompting every retry produced the endless
 *   "x.com wants to request a browser permission" loop, and the allow
 *   path can never succeed here (no native FedCM account-chooser UI in
 *   Electron). Quietly denying lets GSI fall back to its popup OAuth
 *   flow, which the popup→tab routing handles.
 * - `payment-handler`: silent background registration, never user-meaningful.
 * - `web-app-installation`: no app-install UX exists; deny quietly.
 */
const QUIET_DENY = new Set([
  'identity-credentials-get',
  'payment-handler',
  'web-app-installation',
]);

function originOf(wc: WebContents, details: unknown): string {
  try {
    const u =
      (details as { requestingUrl?: string } | null)?.requestingUrl ??
      wc.getURL();
    return new URL(u).origin;
  } catch {
    return '';
  }
}

export function setupGuestSession(deps: WebEngineDeps): void {
  const ses = session.fromPartition(GUEST_PARTITION);

  // 1 — Chrome UA on the guest session (covers every tab webview).
  ses.setUserAgent(chromeUserAgent());

  // 2 — permission requests.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const p = permission as string;
    const origin = originOf(wc, details);

    // FedCM / payment-handler / install prompts: quiet deny, never a dialog
    // (see QUIET_DENY). These APIs cannot succeed in an embedded context and
    // retry aggressively — prompting each time is the permission-loop bug.
    if (QUIET_DENY.has(p)) {
      console.log(`[permissions] ${origin || '(unknown origin)'} ${p} -> quiet-deny`);
      callback(false);
      return;
    }

    // Remembered per-site decision wins over everything.
    const remembered = origin ? deps.store.d.privacy.permissions[origin]?.[p] : undefined;
    if (remembered === 'allow' || remembered === 'block') {
      callback(remembered === 'allow');
      return;
    }
    // User-configured default for this permission type.
    const def = deps.store.d.privacy.defaults[p];
    if (def === 'allow' || def === 'block') {
      callback(def === 'allow');
      return;
    }

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
    // The popup→tab routing never triggers a permission request itself.
    //
    // Dialog stacking guard: a page that spams requests (the aggressive
    // retry pattern behind the old permission-loop bug) must not pile up
    // modal dialogs — concurrent duplicates for the same origin+permission
    // are denied while one dialog is already open.
    const inflightKey = `${origin}|${p}`;
    if (inflightPermissionDialogs.has(inflightKey)) {
      console.log(`[permissions] ${origin || '(unknown origin)'} ${p} -> denied (dialog already open)`);
      callback(false);
      return;
    }
    inflightPermissionDialogs.add(inflightKey);
    console.log(`[permissions] ${origin || '(unknown origin)'} ${p} -> ask`);
    const settle = (granted: boolean): void => {
      inflightPermissionDialogs.delete(inflightKey);
      callback(granted);
    };
    void askPermission(deps, wc, p, origin, details).then(settle, () => settle(false));
  });

  // 3 — downloads: delegated to downloads.ts (save dialog / fixed folder,
  // progress mirror, pause-cancel-retry registry, auto-open types).
  // webengine keeps its UA + permission focus; see downloads.ts.
  ses.on('will-download', (_event, item: DownloadItem) => {
    // "Save Image As…" already picked a destination — don't double-prompt.
    if (imageSaveArmed.delete(item.getURL())) return;
    handleWillDownload(deps, item);
  });
}

/** Reveal a finished download in Finder. */
export async function revealDownload(targetPath: string): Promise<void> {
  try {
    // Absolute paths only — this must never become a relative-path surprise.
    if (targetPath && path.isAbsolute(targetPath)) shell.showItemInFolder(targetPath);
  } catch {
    /* noop */
  }
}
