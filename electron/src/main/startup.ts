/**
 * startup.ts — on-launch behavior + default-browser plumbing (v0.6.3, impl-5).
 *
 * Startup modes: 'restore' (today's always-behavior — pinned + last session),
 * 'newtab' (a single fresh tab), 'pages' (a fixed set of URLs). Pinned tabs
 * always restore — they're the user's explicit keep-list, not session state.
 */
import { app } from 'electron';
import type { Store, StartupPersist } from './store';

export interface LaunchDeps {
  store: Store;
  /** The TabManager (structural — tabs.ts stays untouched). */
  tabs: {
    restorePinned: () => void;
    restoreSessions: () => void;
    create: (spaceId: string, rawUrl?: string) => { title: string };
  };
  ensureSpaceTab: (spaceId: string) => void;
}

/** Run the configured on-launch behavior. Called once at startup from index.ts. */
export function applyLaunchBehavior(deps: LaunchDeps): void {
  const { store, tabs } = deps;
  const mode: StartupPersist['mode'] = store.d.startup.mode ?? 'restore';
  tabs.restorePinned();
  if (mode === 'restore') {
    tabs.restoreSessions();
  } else if (mode === 'pages') {
    const spaceId = store.d.activeSpaceId;
    for (const raw of store.d.startup.pages.slice(0, 10)) {
      const url = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        const t = tabs.create(spaceId, url);
        t.title = url;
      } catch {
        /* one bad page must not break launch */
      }
    }
  }
  // 'newtab' intentionally restores nothing — ensureSpaceTab opens the fresh tab.
  deps.ensureSpaceTab(store.d.activeSpaceId);
}

/** Validate + persist the startup settings from Settings → On startup. */
export function setStartupSettings(
  store: Store,
  input: { mode?: unknown; pages?: unknown }
): StartupPersist {
  if (typeof input.mode === 'string' && ['restore', 'newtab', 'pages'].includes(input.mode)) {
    store.d.startup.mode = input.mode as StartupPersist['mode'];
  }
  if (Array.isArray(input.pages)) {
    store.d.startup.pages = input.pages
      .map((p) => String(p ?? '').trim())
      .filter((p) => /^https?:\/\//i.test(p))
      .slice(0, 10);
  }
  store.saveSoon();
  return { ...store.d.startup };
}

// -- default browser --------------------------------------------------------

/** Best-effort check via the http/https protocol handlers. */
export function isDefaultBrowser(): boolean {
  try {
    return app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
  } catch {
    return false;
  }
}

/**
 * Register for http/https. The click on "Make default" IS the approval —
 * Chrome-style destructive/privileged actions always need the explicit
 * gesture, and this handler only runs from one. On macOS the OS-level
 * default-browser setting lives in System Settings, so the UI also shows
 * the manual step when this reports false afterwards.
 */
export function makeDefaultBrowser(): { ok: boolean; isDefault: boolean } {
  try {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
  } catch {
    /* best effort */
  }
  return { ok: true, isDefault: isDefaultBrowser() };
}

/**
 * First-run nudge state. Returns { show: true } exactly once per install
 * (and never when we're already the default) — the caller marks it shown
 * so the toast doesn't nag every launch.
 */
export function nudgeState(store: Store): { show: boolean } {
  if (store.d.startup.defaultBrowserNudged) return { show: false };
  if (isDefaultBrowser()) {
    store.d.startup.defaultBrowserNudged = true;
    store.saveSoon();
    return { show: false };
  }
  store.d.startup.defaultBrowserNudged = true;
  store.saveSoon();
  return { show: true };
}
