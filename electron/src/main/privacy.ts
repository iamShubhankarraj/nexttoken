/**
 * privacy.ts — backend for Settings → Privacy & security → Advanced.
 *
 * - Per-site permission allow/block/ask decisions (read by the permission
 *   handler in webengine.ts; edited here).
 * - Cookies & site data: enumerate via session.cookies, per-site detail
 *   and deletion, per-origin storage clearing.
 * - Clear browsing data: cookies/site data, cache, history.
 *
 * All state persists in the existing store (store.d.privacy / history).
 */
import { session } from 'electron';
import { GUEST_PARTITION } from './webengine';
import type {
  PermDefaultPolicy,
  PopupPolicy,
  SitePermDecision,
  Store,
} from './store';
import type { TabManager } from './tabs';

/** Permission types manageable in the Advanced site-permissions table. */
export const MANAGED_PERMISSIONS = [
  'camera',
  'microphone',
  'location',
  'notifications',
  'popups',
  'autoplay',
  'clipboard',
  'screen-capture',
] as const;
export type ManagedPermission = (typeof MANAGED_PERMISSIONS)[number];

export function guestSession() {
  return session.fromPartition(GUEST_PARTITION);
}

export interface PrivacySnapshot {
  permissions: Record<string, Record<string, SitePermDecision>>;
  defaults: Record<string, PermDefaultPolicy>;
  popups: Record<string, PopupPolicy>;
  autoplay: Record<string, 'allow' | 'block'>;
  muted: Record<string, boolean>;
  /** origin -> auto-reader (open Reader mode automatically on article pages) */
  autoReader: Record<string, boolean>;
  historyCount: number;
  /** v0.6.3 (impl-5): Brave-style HTTPS-Strict upgrade. Off by default. */
  httpsUpgrade: boolean;
  /** v0.6.4: where popups open — 'tab' (default) or side-by-side 'split'. */
  popupTarget: 'tab' | 'split';
}

export function snapshot(store: Store): PrivacySnapshot {
  const p = store.d.privacy;
  return {
    permissions: p.permissions,
    defaults: p.defaults,
    popups: p.popups,
    autoplay: p.autoplay,
    muted: p.muted,
    autoReader: p.autoReader,
    historyCount: store.d.history.length,
    httpsUpgrade: p.httpsUpgrade === true,
    popupTarget: p.popupTarget === 'split' ? 'split' : 'tab',
  };
}

/** Set (or clear with null) a per-site permission decision. */

/** Permission names the permission-request handler can actually produce. */
const KNOWN_PERMISSIONS = new Set([
  'media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write',
  'openExternal', 'display-capture', 'midi', 'midiSysex', 'pointerLock', 'fullscreen',
  'window-management', 'speaker-selection', 'idle-detection', 'keyboardLock',
  'storage-access', 'top-level-storage-access', 'fileSystem', 'payment-handler',
  'identity-credentials-get', 'web-app-installation', 'screen-wake-lock', 'popups',
  'autoplay',
]);

/** Normalize a site origin; throws on anything that isn't an http(s) origin. */
function normalizeOrigin(origin: string): string {
  const v = String(origin ?? '').trim();
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad scheme');
    return u.origin;
  } catch {
    throw new Error(`Invalid site origin "${v}".`);
  }
}

export function setSitePermission(
  store: Store,
  rawOrigin: string,
  rawPerm: string,
  decision: SitePermDecision | null
): PrivacySnapshot {
  // Validate before touching the store: origins must be real http(s) origins
  // and the permission must be one the request handler can produce.
  const origin = normalizeOrigin(rawOrigin);
  const perm = String(rawPerm ?? '');
  if (!KNOWN_PERMISSIONS.has(perm)) throw new Error(`Unknown permission "${perm}".`);
  const p = store.d.privacy;
  if (decision === null) {
    if (p.permissions[origin]) {
      delete p.permissions[origin][perm];
      if (Object.keys(p.permissions[origin]).length === 0) delete p.permissions[origin];
    }
  } else {
    p.permissions[origin] = p.permissions[origin] || {};
    p.permissions[origin][perm] = decision;
  }
  store.saveSoon();
  return snapshot(store);
}

export function setPermissionDefault(
  store: Store,
  perm: string,
  policy: PermDefaultPolicy
): PrivacySnapshot {
  if (!KNOWN_PERMISSIONS.has(String(perm ?? ''))) throw new Error(`Unknown permission "${perm}".`);
  store.d.privacy.defaults[perm] = policy;
  store.saveSoon();
  return snapshot(store);
}

/** Set (or clear with null → 'ask') a per-site popup policy. */
export function setPopupPolicy(
  store: Store,
  rawOrigin: string,
  policy: PopupPolicy | null
): PrivacySnapshot {
  const origin = normalizeOrigin(rawOrigin);
  if (policy === null) delete store.d.privacy.popups[origin];
  else store.d.privacy.popups[origin] = policy;
  store.saveSoon();
  return snapshot(store);
}

export function setAutoplayPolicy(
  store: Store,
  tabs: TabManager,
  rawOrigin: string,
  allow: boolean
): PrivacySnapshot {
  const origin = normalizeOrigin(rawOrigin);
  if (allow) delete store.d.privacy.autoplay[origin];
  else store.d.privacy.autoplay[origin] = 'block';
  store.saveSoon();
  tabs.applySitePoliciesToAll();
  return snapshot(store);
}

export function setMuted(
  store: Store,
  tabs: TabManager,
  rawOrigin: string,
  muted: boolean
): PrivacySnapshot {
  const origin = normalizeOrigin(rawOrigin);
  if (muted) store.d.privacy.muted[origin] = true;
  else delete store.d.privacy.muted[origin];
  store.saveSoon();
  tabs.forEachWebContents((_tab, wc) => {
    let url = '';
    try {
      url = wc.getURL();
    } catch {
      return;
    }
    try {
      if (new URL(url).origin === origin) wc.setAudioMuted(muted);
    } catch {
      /* noop */
    }
  });
  return snapshot(store);
}

// -- cookies & site data -----------------------------------------------------

export interface SiteDataSummary {
  /** Registrable-ish site key (cookie domain with leading dot stripped). */
  site: string;
  origins: string[];
  cookies: number;
}

function siteKeyOf(domain: string): string {
  return (domain || '').replace(/^\./, '').toLowerCase();
}

/** Group the guest session's cookies per site. */
export async function siteDataSummaries(): Promise<SiteDataSummary[]> {
  const ses = guestSession();
  let all: Electron.Cookie[] = [];
  try {
    all = await ses.cookies.get({});
  } catch {
    return [];
  }
  const map = new Map<string, { origins: Set<string>; count: number }>();
  for (const c of all) {
    const site = siteKeyOf(c.domain ?? '');
    if (!site) continue;
    let e = map.get(site);
    if (!e) {
      e = { origins: new Set(), count: 0 };
      map.set(site, e);
    }
    e.count += 1;
    const host = (c.domain ?? '').replace(/^\./, '');
    e.origins.add(`http${c.secure ? 's' : ''}://${host}`);
  }
  return [...map.entries()]
    .map(([site, e]) => ({ site, origins: [...e.origins], cookies: e.count }))
    .sort((a, b) => b.cookies - a.cookies);
}

export interface CookieDetail {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
}

/** All cookies for one site (values redacted — names/metadata only). */
export async function siteCookieDetails(site: string): Promise<CookieDetail[]> {
  const ses = guestSession();
  let all: Electron.Cookie[] = [];
  try {
    all = await ses.cookies.get({});
  } catch {
    return [];
  }
  const key = site.toLowerCase();
  return all
    .filter((c) => siteKeyOf(c.domain ?? '') === key)
    .map((c) => ({
      name: c.name ?? '',
      domain: c.domain ?? '',
      path: c.path ?? '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      session: !!c.session,
      expirationDate: c.expirationDate,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function cookieUrl(c: { domain?: string; path?: string; secure?: boolean }): string {
  const host = (c.domain ?? '').replace(/^\./, '');
  return `http${c.secure ? 's' : ''}://${host}${c.path || '/'}`;
}

/** Delete every cookie + storage for a site. Returns cookies removed. */
export async function deleteSiteData(site: string): Promise<{ cookies: number }> {
  const ses = guestSession();
  const key = site.toLowerCase();
  let removed = 0;
  // Capture the site's storage origins BEFORE deleting cookies — the
  // summaries are derived from the cookies themselves, so reading them after
  // deletion would lose the origins needed to clear localStorage/IndexedDB.
  const summaries = await siteDataSummaries().catch(() => [] as SiteDataSummary[]);
  const origins = summaries.find((s) => s.site === key)?.origins ?? [];
  try {
    const all = await ses.cookies.get({});
    for (const c of all) {
      if (siteKeyOf(c.domain ?? '') !== key) continue;
      try {
        await ses.cookies.remove(cookieUrl(c), c.name);
        removed += 1;
      } catch {
        /* keep going */
      }
    }
  } catch {
    /* noop */
  }
  // Clear localStorage/IndexedDB/etc. for the site's origins.
  for (const origin of origins) {
    try {
      await ses.clearStorageData({ origin });
    } catch {
      /* origin may not exist as a storage partition */
    }
  }
  return { cookies: removed };
}

/** Clear browsing data by category. */
export async function clearBrowsingData(
  store: Store,
  opts: { cookies: boolean; cache: boolean; history: boolean }
): Promise<void> {
  const ses = guestSession();
  if (opts.cookies) {
    try {
      await ses.clearStorageData({ storages: ['cookies'] });
    } catch {
      /* noop */
    }
  }
  if (opts.cache) {
    try {
      await ses.clearCache();
    } catch {
      /* noop */
    }
  }
  if (opts.history) store.clearHistory();
}
