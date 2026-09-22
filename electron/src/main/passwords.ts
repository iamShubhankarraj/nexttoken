/**
 * passwords.ts — the runtime password manager (v0.6.3).
 *
 * The encrypted vault lives in main/import/logins.ts (safeStorage /
 * OS-keychain-backed, 0o600 file). This module is the runtime surface on
 * top of it: save-prompt detection, approval-gated save, and origin-bound
 * autofill. It is the "future autofill path" the vault header anticipated.
 *
 * SECURITY CONTRACT — read before touching this file:
 *
 * 1. Approval gates are mandatory. A password is never stored without the
 *    user explicitly clicking "Save" in the save prompt; autofill only ever
 *    runs after the user clicks "Fill"; reveal/copy only after the native
 *    approval dialog is confirmed. Nothing here stores or fills silently.
 * 2. Passwords never cross IPC except the reveal path (nt.passwords.reveal),
 *    which itself sits behind a native approval dialog and goes only to the
 *    trusted app shell (guarded sender allowlist). The renderer never sees a
 *    password at save time (it is read from the guest WebContents in main)
 *    or at fill time (main injects it into the guest directly).
 * 3. Every handler validates its inputs and binds them to the guest's actual
 *    current origin: a renderer can only ask about/fill the tab it names,
 *    and only when the claimed origin matches the tab's live URL. A spoofed
 *    origin or a destroyed guest is a hard rejection.
 * 4. Nothing secret is ever logged. Errors carry static text only.
 * 5. WebAuthn / passkeys are untouched — only classic password fields.
 */

import { app, clipboard, dialog, safeStorage } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { guardedHandle } from './ipcGuard';
import {
  deleteLogin,
  findLoginsForOrigin,
  getLoginPassword,
  getStoredLogins,
  normalizeOrigin,
  upsertLogin,
} from './import/logins';
import type { TabManager } from './tabs';

export interface PasswordManagerDeps {
  /** Live tab manager — the only way to reach a guest WebContents. */
  tabs: TabManager;
  /** The app window (parent for native approval dialogs). */
  getWin: () => BrowserWindow | null;
}

/** Pending save captured from a guest, awaiting the user's approval. */
interface PendingSave {
  token: string;
  origin: string; // normalized scheme://host
  username: string;
  password: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 5 * 60 * 1000;
const BLOCKLIST_FILE = 'password-never-save.json';

/* ------------------------------------------------------------------ *
 * never-save blocklist (not secret — plain JSON in userData)
 * ------------------------------------------------------------------ */

function blocklistPath(): string {
  return path.join(app.getPath('userData'), BLOCKLIST_FILE);
}

async function readBlocklist(): Promise<Set<string>> {
  try {
    const raw = await fsp.readFile(blocklistPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

async function addToBlocklist(origin: string): Promise<void> {
  const list = await readBlocklist();
  list.add(origin);
  await fsp.writeFile(blocklistPath(), JSON.stringify([...list]), { mode: 0o600 });
}

/* ------------------------------------------------------------------ *
 * guest helpers
 * ------------------------------------------------------------------ */

/** The guest for tabId, or null when the tab/guest is gone. */
function guestFor(tabs: TabManager, tabId: unknown): WebContents | null {
  if (typeof tabId !== 'string' || !tabId) return null;
  try {
    const wc = tabs.webContentsFor(tabId);
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  } catch {
    return null;
  }
}

/**
 * The guest's live origin, bound to the tab. Returns '' when the URL is
 * not an http(s) origin (or the guest is unreadable) — every caller treats
 * that as a hard rejection.
 */
function liveOriginOf(wc: WebContents): string {
  try {
    return normalizeOrigin(wc.getURL());
  } catch {
    return '';
  }
}

/**
 * Read the captured login stash the guest detection script stored on
 * window.__ntLoginCapture at submit time. Runs in main, never logged.
 */
async function readCapture(
  wc: WebContents,
): Promise<{ username: string; password: string } | null> {
  try {
    const raw = await wc.executeJavaScript(
      '(() => { const c = window.__ntLoginCapture; window.__ntLoginCapture = null; return c ? { u: c.username, p: c.password } : null; })()',
      true,
    );
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { u?: unknown }).u === 'string' &&
      typeof (raw as { p?: unknown }).p === 'string'
    ) {
      const username = String((raw as { u: string }).u).slice(0, 256);
      const password = String((raw as { p: string }).p).slice(0, 1024);
      if (!password) return null;
      return { username, password };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fill the guest's login fields. Runs in main so the password never
 * crosses IPC. Uses the native value setter + input/change events so
 * framework-bound forms (React/Vue) pick the values up; never submits.
 */
async function fillGuest(
  wc: WebContents,
  username: string,
  password: string,
): Promise<{ filled: boolean }> {
  const code =
    '(() => { ' +
    'const u = ' +
    JSON.stringify(username) +
    '; const p = ' +
    JSON.stringify(password) +
    '; ' +
    'const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; }; ' +
    'const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value"); d.set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }; ' +
    'const texts = [...document.querySelectorAll("input")].filter((el) => vis(el) && ["text", "email", "tel"].includes(el.type)); ' +
    'const nameHit = texts.find((el) => /user|email|login|account/i.test(el.name + el.id + el.placeholder)); ' +
    'const uEl = nameHit || texts[0] || null; ' +
    'const pEls = [...document.querySelectorAll(\'input[type="password"]\')].filter(vis); ' +
    'let filled = 0; ' +
    'if (uEl && u) { set(uEl, u); filled++; } ' +
    'if (pEls[0]) { set(pEls[0], p); filled++; } ' +
    'return { filled: filled > 0 }; ' +
    '})()';
  try {
    const res = (await wc.executeJavaScript(code, true)) as { filled?: boolean } | null;
    return { filled: res?.filled === true };
  } catch {
    return { filled: false };
  }
}

/* ------------------------------------------------------------------ *
 * registration
 * ------------------------------------------------------------------ */

/**
 * Register the nt.passwords.* channels. Call once from main/index.ts.
 */
export function registerPasswordManager(deps: PasswordManagerDeps): void {
  const userDataDir = () => app.getPath('userData');
  const pending = new Map<string, PendingSave>();

  const sendToShell = (channel: string, payload: unknown): void => {
    const w = deps.getWin();
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload);
      } catch {
        /* shell gone — drop */
      }
    }
  };

  /** Bind a tab to its live origin, rejecting spoofed origins. */
  const boundGuest = (tabId: unknown, claimedOrigin: unknown): WebContents | null => {
    const wc = guestFor(deps.tabs, tabId);
    if (!wc) return null;
    const live = liveOriginOf(wc);
    if (!live) return null;
    if (typeof claimedOrigin !== 'string' || normalizeOrigin(claimedOrigin) !== live) {
      return null;
    }
    return wc;
  };

  // -- list: what's stored, passwords stripped (safe for settings UI) ----
  guardedHandle('nt.passwords.list', (): Array<{ origin: string; username: string }> => {
    try {
      return getStoredLogins(userDataDir());
    } catch {
      return [];
    }
  });

  // -- lookup: does this origin have saved logins? (autofill offer) ------
  guardedHandle(
    'nt.passwords.lookup',
    (_e, tabId: unknown, origin: unknown): { has: boolean; usernames: string[] } => {
      const wc = boundGuest(tabId, origin);
      if (!wc) return { has: false, usernames: [] };
      const live = liveOriginOf(wc);
      const found = findLoginsForOrigin(userDataDir(), live);
      return { has: found.length > 0, usernames: found.map((f) => f.username) };
    },
  );

  // -- autofill: user-clicked fill into the named tab's guest ------------
  guardedHandle(
    'nt.passwords.autofill',
    async (_e, tabId: unknown, username: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (typeof username !== 'string' || !username) {
        return { ok: false, error: 'A saved username is required.' };
      }
      // claimed origin is bound implicitly: we fill the tab's LIVE origin.
      const wc = guestFor(deps.tabs, tabId);
      if (!wc) return { ok: false, error: 'That tab is no longer open.' };
      const live = liveOriginOf(wc);
      if (!live) return { ok: false, error: 'Cannot fill on this page.' };
      let password: string | null = null;
      try {
        password = getLoginPassword(userDataDir(), live, username.slice(0, 256));
      } catch {
        return { ok: false, error: 'Could not read the encrypted vault.' };
      }
      if (!password) return { ok: false, error: 'No saved password for this login.' };
      const { filled } = await fillGuest(wc, username, password);
      // Drop the reference; the string itself is left for GC (never logged).
      password = null;
      if (!filled) return { ok: false, error: 'No login fields found on this page.' };
      return { ok: true };
    },
  );

  // -- login-detected: guest reported a form submit; capture + ask -------
  guardedHandle(
    'nt.passwords.login-detected',
    async (
      _e,
      tabId: unknown,
      origin: unknown,
      username: unknown,
    ): Promise<{ token: string | null }> => {
      const wc = boundGuest(tabId, origin);
      if (!wc) return { token: null };
      const live = liveOriginOf(wc);
      const blocked = await readBlocklist();
      if (blocked.has(live)) return { token: null };
      const name = typeof username === 'string' ? username.slice(0, 256) : '';
      const captured = await readCapture(wc);
      if (!captured) return { token: null };
      const user = captured.username || name;
      // Already stored with the same password → nothing to ask.
      try {
        const existing = getLoginPassword(userDataDir(), live, user);
        if (existing !== null && existing === captured.password) return { token: null };
      } catch {
        return { token: null };
      }
      const token = randomUUID();
      pending.set(token, {
        token,
        origin: live,
        username: user,
        password: captured.password,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });
      setTimeout(() => pending.delete(token), PENDING_TTL_MS).unref?.();
      sendToShell('nt.passwords.save-prompt', { token, origin: live, username: user });
      return { token };
    },
  );

  // -- save-decision: the approval gate. Nothing stores without 'save'. ---
  guardedHandle(
    'nt.passwords.save-decision',
    async (_e, token: unknown, decision: unknown): Promise<{ ok: boolean }> => {
      if (typeof token !== 'string' || !token) return { ok: false };
      const p = pending.get(token);
      pending.delete(token);
      if (!p || p.expiresAt < Date.now()) return { ok: false };
      if (decision === 'never') {
        try {
          await addToBlocklist(p.origin);
        } catch {
          return { ok: false };
        }
        return { ok: true };
      }
      if (decision !== 'save') return { ok: true }; // dismiss
      if (!safeStorage.isEncryptionAvailable()) return { ok: false };
      try {
        await upsertLogin({ origin: p.origin, username: p.username, password: p.password }, userDataDir());
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  // -- reveal: native approval dialog, THEN the password crosses IPC ------
  guardedHandle(
    'nt.passwords.reveal',
    async (_e, origin: unknown, username: unknown): Promise<string | null> => {
      if (typeof origin !== 'string' || typeof username !== 'string' || !username) return null;
      const norm = normalizeOrigin(origin);
      if (!norm) return null;
      const win = deps.getWin();
      const options = {
        type: 'question' as const,
        title: 'Reveal saved password?',
        message: `Reveal the saved password for ${norm} (${username.slice(0, 128)})?`,
        detail: 'Make sure nobody is looking at your screen.',
        buttons: ['Reveal password', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      // Two-arg overload requires a live window; fall back to the
      // options-only overload when the shell is gone.
      const { response } =
        win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, options)
          : await dialog.showMessageBox(options);
      if (response !== 0) return null;
      try {
        return getLoginPassword(userDataDir(), norm, username.slice(0, 256));
      } catch {
        return null;
      }
    },
  );

  // -- copy: same approval gate, password never enters the renderer ------
  guardedHandle(
    'nt.passwords.copy',
    async (_e, origin: unknown, username: unknown): Promise<{ ok: boolean }> => {
      if (typeof origin !== 'string' || typeof username !== 'string' || !username) return { ok: false };
      const norm = normalizeOrigin(origin);
      if (!norm) return { ok: false };
      const win = deps.getWin();
      const options = {
        type: 'question' as const,
        title: 'Copy saved password?',
        message: `Copy the saved password for ${norm} (${username.slice(0, 128)}) to the clipboard?`,
        detail: 'It stays in your clipboard until you copy something else.',
        buttons: ['Copy password', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const { response } =
        win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, options)
          : await dialog.showMessageBox(options);
      if (response !== 0) return { ok: false };
      try {
        const pw = getLoginPassword(userDataDir(), norm, username.slice(0, 256));
        if (!pw) return { ok: false };
        clipboard.writeText(pw);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  // -- delete: renderer confirms first; main validates and removes -------
  guardedHandle(
    'nt.passwords.delete',
    (_e, origin: unknown, username: unknown): { ok: boolean } => {
      if (typeof origin !== 'string' || typeof username !== 'string' || !username) return { ok: false };
      const norm = normalizeOrigin(origin);
      if (!norm) return { ok: false };
      try {
        return { ok: deleteLogin(userDataDir(), norm, username.slice(0, 256)) };
      } catch {
        return { ok: false };
      }
    },
  );

  // -- never-save management ---------------------------------------------
  guardedHandle('nt.passwords.blocked', async (): Promise<string[]> => {
    return [...(await readBlocklist())];
  });

  guardedHandle('nt.passwords.unblock', async (_e, origin: unknown): Promise<{ ok: boolean }> => {
    if (typeof origin !== 'string') return { ok: false };
    const norm = normalizeOrigin(origin);
    if (!norm) return { ok: false };
    const list = await readBlocklist();
    if (!list.delete(norm)) return { ok: true };
    try {
      await fsp.writeFile(blocklistPath(), JSON.stringify([...list]), { mode: 0o600 });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
}
