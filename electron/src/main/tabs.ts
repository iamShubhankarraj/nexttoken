import { app, webContents } from 'electron';
import type { ContextMenuParams, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import path from 'node:path';
import type { ArchivedTab, TabDelta, TabState } from '../shared/ipc';
import type { Store } from './store';

/** Optional hooks the app wires into tab guest webContents. */
export interface TabHooks {
  /** Fired when a guest page shows a context menu (e.g. right-click on video). */
  onContextMenu?: (wc: WebContents, params: ContextMenuParams) => void;
  /**
   * Fired when a ⌘-shortcut the shell owns is pressed while a guest
   * <webview> has focus (before-input-event bridge). Main already called
   * preventDefault so the page never sees the key; index.ts replays it to
   * the shell window so ⌘T/⌘W/⌘K/… work with page focus.
   */
  onGuestShortcut?: (tabId: string, key: GuestKeyInfo) => void;
  /**
   * Fired when the guest asks to open a URL in a new window/tab
   * (target=_blank, window.open, cmd/middle-click). Main decides what to
   * do with it (open a real tab); tabs.ts just routes the request.
   */
  onPopup?: (sourceTab: TabRec, url: string, disposition: string) => void;
  /**
   * Fired when a popup is denied (e.g. an opener-scripted about:blank
   * window we can't host). Main shows a blocked-popup indicator with an
   * "open anyway" action — nothing is ever silently dropped.
   */
  onPopupBlocked?: (sourceTab: TabRec, url: string) => void;
  /**
   * Fired when find-in-page reports match counts for a guest. Main
   * forwards it to the renderer only when it's the active tab.
   */
  onFindResult?: (
    wc: WebContents,
    result: { matches: number; activeMatchOrdinal: number },
  ) => void;
}

export interface TabRec {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  loading: boolean;
  pinned: boolean;
  /** Folder this tab is filed into; null = ungrouped. */
  folderId: string | null;
  /** data: URL favicon captured from the page. */
  favicon?: string;
  lastActive: number;
  wc: WebContents | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Tab-level mute (sidebar speaker toggle / context menu). */
  muted: boolean;
  /** Currently producing sound (media-started-playing / media-paused). */
  audible: boolean;
}

/** Key info forwarded from a guest's before-input-event (⌘-only). */
export interface GuestKeyInfo {
  /** Lowercased key, e.g. 't' (shift state carried separately). */
  key: string;
  shift: boolean;
  alt: boolean;
}

/**
 * ⌘-shortcuts the shell owns. Guest <webview>s swallow keys, so these are
 * intercepted in before-input-event and replayed to the shell window.
 * Only ⌘ (meta) combos are ever intercepted — web apps keep every other
 * key (⌘C/⌘V/⌘A etc. are NOT in this set and stay with the page).
 */
const SHELL_SHORTCUT_KEYS = new Set([
  't', 'w', 'l', 'k', 'e', 'f', 'd', 'b',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '=', '+', '-', '_', '0',
]);

/** Fresh tabs open a blank titled page — the renderer draws the large
 * centered command bar over it (Dia pattern: no tile page). A data: URL
 * keeps this offline and gives the guest a real title for the smoke test. */
const START_URL =
  'data:text/html,<html><head><title>New Tab</title></head><body></body></html>';

/** Decide whether raw input is a URL or a search query. */
export function resolveInput(raw: string, searchEngine: string): string {
  const t = raw.trim();
  if (!t) return START_URL;
  // Script schemes can never be a navigation target — even the `scheme://`
  // form below would otherwise pass them through to loadURL.
  if (/^(javascript|vbscript):/i.test(t)) return searchEngine + encodeURIComponent(t);
  // Already a full URL or an internal page — pass through untouched.
  if (/^(data|about|file):/i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t; // has a scheme
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(t)) return 'http://' + t;
  // domain-like: no spaces, has a dot, plausible TLD-ish shape
  if (/^[^\s]+\.[^\s]{2,}(\/\S*)?$/.test(t) && !/\s/.test(t)) return 'https://' + t;
  // Search query: %s templates get a substitution, bare templates an append
  // (the Settings UI documents %s, so both styles must work).
  return searchEngine.includes('%s')
    ? searchEngine.replace('%s', encodeURIComponent(t))
    : searchEngine + encodeURIComponent(t);
}

export class TabManager {
  tabs = new Map<string, TabRec>();
  activeTabId: string | null = null;

  /** Last-active tab id per Bit — drives per-Bit sessionActiveUrl. */
  private lastActiveBySpace = new Map<string, string>();

  /** Most recently active tab in a Bit (falls back to any tab). */
  lastActiveTabId(spaceId: string): string | null {
    const id = this.lastActiveBySpace.get(spaceId);
    const t = id ? this.tabs.get(id) : undefined;
    if (t && t.spaceId === spaceId) return id as string;
    return this.orderedTabs(spaceId)[0]?.id ?? null;
  }
  /** Sidebar order of tab ids (per space, filtered at read time). */
  private order: string[] = [];
  /** host -> data: URL favicon, persisted to disk. */
  private faviconCache = new Map<string, string>();
  private faviconSaveTimer: NodeJS.Timeout | null = null;
  private sessionSaveTimer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private onChange: () => void,
    private onDelta: (d: TabDelta) => void,
    private hooks?: TabHooks
  ) {
    this.loadFaviconCache();
  }

  // -- lifecycle -------------------------------------------------------------
  create(spaceId: string, rawUrl?: string, pinned = false): TabRec {
    // Don't re-resolve the default: START_URL is a data: URL and must be
    // passed through untouched, never search-routed.
    const url = rawUrl ? resolveInput(rawUrl, this.store.d.searchEngine) : START_URL;
    const tab: TabRec = {
      id: randomUUID(), spaceId, url,
      title: 'New Tab', loading: true, pinned,
      folderId: null,
      favicon: this.faviconFor(url),
      lastActive: Date.now(), wc: null,
      canGoBack: false, canGoForward: false,
      muted: false, audible: false
    };
    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);
    this.persistSessionSoon();
    this.onChange();
    return tab;
  }

  /**
   * The renderer's <webview> calls this once its guest webContents exists.
   * Main then owns the WebContents for events, navigation, and the agent.
   */
  attach(tabId: string, wcId: number): TabRec | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return null;
    tab.wc = wc;
    this.wire(wc, tab);
    // Sync anything that happened before attach won the race.
    try {
      const url = wc.getURL();
      if (url && url !== 'about:blank') {
        tab.url = url;
        tab.title = wc.getTitle() || tab.title;
      }
    } catch { /* guest may be gone */ }
    this.onChange();
    return tab;
  }

  private wire(wc: WebContents, tab: TabRec) {
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.onDelta({ tabId: tab.id, type: 'loading', value: true });
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
      this.onDelta({
        tabId: tab.id, type: 'loading', value: false,
        canGoBack: tab.canGoBack, canGoForward: tab.canGoForward
      });
      // If the page never reported a favicon, try its own /favicon.ico.
      if (!this.faviconFor(tab.url)) this.fetchOriginIcon(tab);
      this.maybeInjectBoost(wc, tab);
    });
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title || tab.url;
      this.onDelta({ tabId: tab.id, type: 'title', value: tab.title });
      this.persistSessionSoon(); // keep restored titles current
    });
    const onNav = (url: string) => {
      const prevHost = this.hostOf(tab.url);
      tab.url = url;
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
      this.onDelta({
        tabId: tab.id, type: 'url', value: url,
        canGoBack: tab.canGoBack, canGoForward: tab.canGoForward
      });
      // Per-site engine policies (Settings → Privacy & security).
      this.applySitePolicies(wc, url, tab);
      // Browsing history for per-site settings + clear-browsing-data.
      try {
        this.store.pushHistoryEntry(url, tab.title);
      } catch {
        /* never break navigation on a history write */
      }
      // The tab icon must track the CURRENT site: when the host changes
      // (link click, redirect, typed navigation), drop the previous site's
      // icon immediately and show the new host's cached icon (or nothing)
      // until page-favicon-updated reports the real one. In-page SPA route
      // changes keep the host, so the icon correctly stays put.
      const nextHost = this.hostOf(url);
      if (nextHost && nextHost !== prevHost) {
        const cached = this.faviconFor(url);
        if (tab.favicon !== cached) {
          tab.favicon = cached;
          this.onDelta({ tabId: tab.id, type: 'favicon', value: cached ?? '' });
        }
        if (!cached) this.fetchOriginIcon(tab);
      }
    };
    wc.on('did-navigate', (_e, url) => onNav(url));
    wc.on('did-navigate-in-page', (_e, url) => onNav(url));
    // target=_blank / window.open / cmd+click: the legacy webview
    // `new-window` DOM event is unreliable on modern Electron, so route
    // opens through the supported setWindowOpenHandler API instead.
    // Same-tab link clicks never reach here — the guest navigates natively.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      // Downloads (<a download>) must flow through, not become tabs. The
      // disposition is cast because this Electron's typings omit it.
      if ((disposition as string) === 'save-to-disk') return { action: 'allow' };
      // Per-site popup policy (Settings → Privacy & security). 'ask' is the
      // default: popups open as real tabs; 'allow' opens silently as a
      // background tab; 'block' denies but surfaces the blocked-popup
      // indicator with "open anyway" — a clicked link is never silently
      // dropped in any policy path.
      const policy = this.popupPolicyFor(tab.url);
      if (!url || url === 'about:blank') {
        // Opener-scripted popups (OAuth, payments, previews): window.open()
        // with no URL yet. Hard-denying these broke the opener's flow with
        // zero feedback, so they now become a real tab like any other popup
        // (Arc-style) — except under 'block', which stays silent.
        // Tradeoff: window.opener scripting can't bridge into the tab, so
        // exotic opener-driven flows may still need a manual step.
        if (policy === 'block') return { action: 'deny' };
        try {
          this.hooks?.onPopup?.(tab, url || 'about:blank', disposition);
        } catch {
          /* never break the guest on a hook failure */
        }
        return { action: 'deny' };
      }
      if (policy === 'block') {
        // The popup policy says no — but a clicked link must never be
        // silently dropped: surface the blocked-popup indicator (with its
        // "open anyway" action) instead of vanishing the click.
        try {
          this.hooks?.onPopupBlocked?.(tab, url);
        } catch {
          /* never break the guest on a hook failure */
        }
        return { action: 'deny' };
      }
      try {
        if (policy === 'allow') {
          this.hooks?.onPopup?.(tab, url, 'background-tab');
        } else {
          this.hooks?.onPopup?.(tab, url, disposition);
        }
      } catch {
        /* never break the guest on a hook failure */
      }
      return { action: 'deny' };
    });
    // find-in-page match counts, forwarded to the renderer for the find bar.
    wc.on('found-in-page', (_e, result) => {
      try {
        this.hooks?.onFindResult?.(wc, {
          matches: result.matches ?? 0,
          activeMatchOrdinal: result.activeMatchOrdinal ?? 0,
        });
      } catch {
        /* noop */
      }
    });
    // Site favicon for the sidebar — the page's own icon, cached per host.
    // No extra network requests: Electron hands us the resolved favicon.
    wc.on('page-favicon-updated', (_e, favicons) => this.onFavicon(tab, favicons));
    // Custom context menu for guest content — the app adds video actions
    // (copy address, open in new tab) when right-clicking a video element.
    wc.on('context-menu', (_e, params) => {
      try { this.hooks?.onContextMenu?.(wc, params); } catch { /* noop */ }
    });
    // Shell shortcuts with page focus: guest <webview>s swallow keys, so
    // intercept the ⌘-combos the shell owns here and replay them to the
    // shell window via the onGuestShortcut hook. preventDefault stops the
    // page from also acting on the key. Only ⌘ (meta) combos in
    // SHELL_SHORTCUT_KEYS are intercepted — web apps keep their own keys.
    wc.on('before-input-event', (event, input) => {
      if (!input.meta || input.type !== 'keyDown' || typeof input.key !== 'string') return;
      const key = input.key.toLowerCase();
      if (!SHELL_SHORTCUT_KEYS.has(key)) return;
      try { event.preventDefault(); } catch { /* noop */ }
      try {
        this.hooks?.onGuestShortcut?.(tab.id, { key, shift: !!input.shift, alt: !!input.alt });
      } catch { /* noop */ }
    });
    // Per-tab audio state for the sidebar speaker indicator.
    wc.on('media-started-playing', () => {
      if (!tab.audible) {
        tab.audible = true;
        this.onDelta({ tabId: tab.id, type: 'audible', value: true });
      }
    });
    wc.on('media-paused', () => {
      if (tab.audible) {
        tab.audible = false;
        this.onDelta({ tabId: tab.id, type: 'audible', value: false });
      }
    });
    wc.once('destroyed', () => { tab.wc = null; });
  }

  // -- favicons ---------------------------------------------------------------
  private faviconFile(): string {
    return path.join(app.getPath('userData'), 'favicons.json');
  }

  private loadFaviconCache() {
    try {
      const raw = fs.readFileSync(this.faviconFile(), 'utf8');
      const obj = JSON.parse(raw) as Record<string, string>;
      for (const [host, icon] of Object.entries(obj)) {
        if (typeof icon === 'string' && icon.startsWith('data:image')) {
          this.faviconCache.set(host, icon);
        }
      }
    } catch { /* no cache yet */ }
  }

  private saveFaviconCacheSoon() {
    if (this.faviconSaveTimer) return;
    this.faviconSaveTimer = setTimeout(() => {
      this.faviconSaveTimer = null;
      this.saveFaviconCacheNow();
    }, 2000);
  }

  /** Synchronous favicon-cache write — call on quit so fresh icons survive. */
  saveFaviconCacheNow() {
    if (this.faviconSaveTimer) {
      clearTimeout(this.faviconSaveTimer);
      this.faviconSaveTimer = null;
    }
    try {
      // Cap the cache so one bad actor can't bloat the file.
      const entries = [...this.faviconCache.entries()].slice(-500);
      fs.writeFileSync(this.faviconFile(), JSON.stringify(Object.fromEntries(entries)));
    } catch { /* best effort */ }
  }

  private hostOf(url: string): string {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  }

  /** Cached favicon for any URL (tabs, bookmarks, App Store), or undefined. */
  faviconFor(url: string): string | undefined {
    const host = this.hostOf(url);
    return host ? this.faviconCache.get(host) : undefined;
  }

  /** Fired when a host's cached favicon changes — lets the UI refresh snapshot-backed icons. */
  onFaviconCacheChange: (() => void) | null = null;

  /**
   * Warm the favicon cache for an arbitrary URL (App Store adds, bookmarks).
   * Tries the site's own /favicon.ico first; on failure falls back to
   * Google's public s2 service so tiles never show a bare placeholder.
   */
  ensureFavicon(url: string): void {
    const host = this.hostOf(url);
    if (!host || this.faviconCache.has(host) || this.faviconFetching.has(host)) return;
    let origin: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      origin = u.origin;
    } catch { return; }
    this.downloadFavicon(host, `${origin}/favicon.ico`, () => this.fetchGoogleIcon(host));
  }

  private onFavicon(tab: TabRec, favicons: string[]) {
    const dataUrl = favicons.find((f) => f.startsWith('data:image'));
    if (dataUrl) {
      if (dataUrl.length > 150_000) return; // sanity cap — skip giant icons
      if (tab.favicon === dataUrl) return;
      tab.favicon = dataUrl;
      const host = this.hostOf(tab.url);
      if (host) {
        this.faviconCache.set(host, dataUrl);
        this.saveFaviconCacheSoon();
        this.onFaviconCacheChange?.();
      }
      this.onDelta({ tabId: tab.id, type: 'favicon', value: dataUrl });
      return;
    }
    // Sites often hand us an http(s) favicon URL. Download it ourselves
    // (first-party preferred; Google s2 as quiet fallback) and cache it.
    const remote = favicons.find((f) => /^https?:\/\//i.test(f));
    const host = this.hostOf(tab.url);
    if (remote) this.downloadFavicon(host, remote, () => this.fetchGoogleIcon(host));
    else this.fetchOriginIcon(tab);
  }

  /** Hosts with an in-flight favicon download — one attempt per host. */
  private faviconFetching = new Set<string>();

  /** Download a first-party favicon URL (no cookies); on failure try Google s2. */
  private downloadFavicon(host: string, iconUrl: string, onFail?: () => void) {
    if (!host) return;
    if (this.faviconCache.has(host) || this.faviconFetching.has(host)) return;
    let target: URL;
    try {
      target = new URL(iconUrl);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') { onFail?.(); return; }
      // Prefer the site's own origin; anything else falls through to s2.
      if (target.hostname.toLowerCase() !== host) { onFail?.(); return; }
    } catch { onFail?.(); return; }
    this.faviconFetching.add(host);
    const fail = () => { this.faviconFetching.delete(host); onFail?.(); };
    const get = target.protocol === 'https:' ? httpsGet : httpGet;
    const req = get(target, { timeout: 8000 }, (res) => {
      const type = String(res.headers['content-type'] ?? '');
      if (res.statusCode !== 200 || !type.startsWith('image/')) {
        res.resume();
        fail();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 200_000) { res.destroy(); this.faviconFetching.delete(host); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        this.faviconFetching.delete(host);
        if (size === 0 || size > 200_000) return;
        const dataUrl = `data:${type.split(';')[0]};base64,${Buffer.concat(chunks).toString('base64')}`;
        this.applyFavicon(host, dataUrl);
      });
      res.on('error', fail);
    });
    req.on('timeout', () => { req.destroy(); fail(); });
    req.on('error', fail);
  }

  /**
   * Quiet last resort: Google's public s2 favicon service. Used only when
   * the site's own icon could not be fetched, so App Store tiles and sidebar
   * rows still show a real icon instead of a generic glyph.
   */
  private fetchGoogleIcon(host: string): void {
    if (!host || this.faviconCache.has(host) || this.faviconFetching.has(host)) return;
    this.faviconFetching.add(host);
    let target: URL;
    try {
      target = new URL(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`);
    } catch { this.faviconFetching.delete(host); return; }
    const done = (dataUrl: string | null) => {
      this.faviconFetching.delete(host);
      if (dataUrl) this.applyFavicon(host, dataUrl);
    };
    const req = httpsGet(target, { timeout: 8000 }, (res) => {
      const type = String(res.headers['content-type'] ?? 'image/png');
      if (res.statusCode !== 200) { res.resume(); done(null); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 200_000) { res.destroy(); done(null); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (size === 0) { done(null); return; }
        const mime = type.startsWith('image/') ? type.split(';')[0] : 'image/png';
        done(`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`);
      });
      res.on('error', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  }

  /** Last-resort first-party: the site origin's own /favicon.ico. */
  private fetchOriginIcon(tab: TabRec) {
    this.ensureFavicon(tab.url);
  }

  /** Cache a fetched icon and push it to every tab currently on that host. */
  private applyFavicon(host: string, dataUrl: string) {
    this.faviconCache.set(host, dataUrl);
    this.saveFaviconCacheSoon();
    this.onFaviconCacheChange?.();
    for (const tab of this.tabs.values()) {
      if (this.hostOf(tab.url) === host && tab.favicon !== dataUrl) {
        tab.favicon = dataUrl;
        this.onDelta({ tabId: tab.id, type: 'favicon', value: dataUrl });
      }
    }
  }

  // -- folders & ordering ------------------------------------------------------
  /** File a tab into a folder (null = ungrouped). Validates the folder belongs to the tab's Bit. */
  setFolder(tabId: string, folderId: string | null): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (folderId !== null) {
      const space = this.store.d.spaces.find((s) => s.id === tab.spaceId);
      if (!space?.folders.some((f) => f.id === folderId)) return;
    }
    if (tab.folderId === folderId) return;
    tab.folderId = folderId;
    this.persistSessionSoon();
    this.onDelta({ tabId, type: 'folder', value: folderId });
  }

  /** Clear a deleted folder's id from every tab in that Bit. */
  clearFolder(spaceId: string, folderId: string): void {
    let changed = false;
    for (const tab of this.tabs.values()) {
      if (tab.spaceId === spaceId && tab.folderId === folderId) {
        tab.folderId = null;
        changed = true;
        this.onDelta({ tabId: tab.id, type: 'folder', value: null });
      }
    }
    if (changed) this.persistSessionSoon();
  }

  /**
   * Drag-to-reorder: move `tabId` before `beforeTabId` (null = end of the
   * target folder/section). Both tabs must be in the same Bit and share the
   * same pinned/folder grouping; the caller passes the drop target's folder.
   */
  reorder(tabId: string, beforeTabId: string | null, folderId: string | null): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (beforeTabId) {
      const before = this.tabs.get(beforeTabId);
      if (!before || before.spaceId !== tab.spaceId || before.id === tabId) return;
      if (!!before.pinned !== !!tab.pinned) return;
    }
    // Keep the folder assignment consistent with the drop target.
    if (!tab.pinned) this.setFolder(tabId, folderId);
    const idx = this.order.indexOf(tabId);
    if (idx !== -1) this.order.splice(idx, 1);
    if (beforeTabId) {
      const at = this.order.indexOf(beforeTabId);
      this.order.splice(at === -1 ? this.order.length : at, 0, tabId);
    } else {
      // End of the target group: insert after the last tab of the same
      // Bit + pinned/folder grouping.
      let at = this.order.length;
      for (let i = this.order.length - 1; i >= 0; i--) {
        const t = this.tabs.get(this.order[i]);
        if (t && t.spaceId === tab.spaceId && !!t.pinned === !!tab.pinned &&
            (t.folderId ?? null) === (tab.folderId ?? null)) {
          at = i + 1;
          break;
        }
      }
      this.order.splice(at, 0, tabId);
    }
    this.persistSessionSoon();
    this.onChange();
  }

  /**
   * Move a tab to another Bit. Clears the folder assignment when the folder
   * doesn't exist in the target Bit, records per-Bit activity, and persists
   * the session immediately (a move is a deliberate user action).
   */
  moveToSpace(tabId: string, spaceId: string): void {
    const tab = this.tabs.get(tabId);
    const space = this.store.d.spaces.find((s) => s.id === spaceId);
    if (!tab || !space || tab.spaceId === spaceId) return;
    const fromId = tab.spaceId;
    tab.spaceId = spaceId;
    if (tab.folderId && !space.folders.some((f) => f.id === tab.folderId)) {
      tab.folderId = null;
    }
    this.lastActiveBySpace.set(spaceId, tabId);
    // Repair the source Bit's pointer if it pointed at the moved tab.
    if (this.lastActiveBySpace.get(fromId) === tabId) {
      const sib = this.orderedTabs(fromId)[0];
      if (sib) this.lastActiveBySpace.set(fromId, sib.id);
      else this.lastActiveBySpace.delete(fromId);
    }
    this.persistSession();
    this.onChange();
  }

  /** Tabs of one Bit, in sidebar order. */
  orderedTabs(spaceId: string): TabRec[] {
    const inSpace = [...this.tabs.values()].filter((t) => t.spaceId === spaceId);
    const rank = new Map(this.order.map((id, i) => [id, i]));
    // Any tab missing from the order (shouldn't happen) sorts last, stably.
    return inSpace.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }

  /**
   * BOOST INJECTION POINT (planned feature). When SiteBoosts ship, enabled
   * boosts whose `host` matches the navigated host get their CSS injected
   * here via wc.insertCSS. Store already persists boosts; no UI yet.
   */
  private maybeInjectBoost(wc: WebContents, tab: TabRec) {
    const boosts = this.store.d.boosts.filter((b) => b.enabled);
    if (boosts.length === 0) return;
    let host = '';
    try { host = new URL(tab.url).hostname; } catch { return; }
    for (const b of boosts) {
      if (host === b.host || host.endsWith('.' + b.host)) {
        wc.insertCSS(b.css).catch(() => {});
      }
    }
  }

  close(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    try { tab.wc?.close(); } catch { /* already gone */ }
    this.tabs.delete(tabId);
    const oi = this.order.indexOf(tabId);
    if (oi !== -1) this.order.splice(oi, 1);
    if (this.activeTabId === tabId) {
      const sib = [...this.tabs.values()].find((t) => t.spaceId === tab.spaceId && !t.pinned)
        ?? [...this.tabs.values()].find((t) => t.spaceId === tab.spaceId);
      this.activeTabId = sib ? sib.id : null;
      if (sib) this.lastActiveBySpace.set(tab.spaceId, sib.id);
      else this.lastActiveBySpace.delete(tab.spaceId);
    }
    this.persistSessionSoon();
    this.onChange();
  }

  activate(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.activeTabId = tabId;
    this.lastActiveBySpace.set(tab.spaceId, tabId);
    tab.lastActive = Date.now();
    try { tab.wc?.focus(); } catch { /* noop */ }
    this.persistSessionSoon(); // crash-safe: remember the active tab per Bit
    this.onChange();
  }

  // -- navigation (active tab) -----------------------------------------------
  private active(): TabRec | null {
    return (this.activeTabId && this.tabs.get(this.activeTabId)) || null;
  }

  activeWebContents(): WebContents | null {
    return this.active()?.wc ?? null;
  }

  /** The guest webContents for a specific tab (null when none/destroyed). */
  webContentsFor(tabId: string): WebContents | null {
    const wc = this.tabs.get(tabId)?.wc ?? null;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /** Iterate every live guest webContents with its tab record. */
  forEachWebContents(cb: (tab: TabRec, wc: WebContents) => void): void {
    for (const tab of this.tabs.values()) {
      const wc = tab.wc;
      if (wc && !wc.isDestroyed()) {
        try {
          cb(tab, wc);
        } catch {
          /* one bad tab must not break the sweep */
        }
      }
    }
  }

  /**
   * Apply per-site engine policies on navigation (Settings → Privacy &
   * security → site settings): sound (mute) and autoplay. Runs on every
   * navigation so a policy change takes effect on next load.
   *
   * Electron has no per-webContents autoplay content-setting API, so
   * autoplay=block is enforced with a capture-phase play interceptor that
   * pauses playback until the page has seen real user activation
   * (document-user-activation-required semantics).
   */
  private applySitePolicies(wc: WebContents, url: string, tab?: TabRec): void {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    if (!origin.startsWith('http')) return;
    const p = this.store.d.privacy;
    try {
      if (p.muted[origin]) {
        wc.setAudioMuted(true);
        // Keep the tab record in sync so the sidebar speaker shows muted.
        if (tab && !tab.muted) {
          tab.muted = true;
          this.onDelta({ tabId: tab.id, type: 'muted', value: true });
        }
      }
    } catch {
      /* noop */
    }
    // Per-site autoplay policy: per-site override, else the global
    // default (unset = 'ask'). 'block' AND 'ask' install the play
    // interceptor — playback waits for real user activation
    // (document-user-activation-required semantics). 'allow' bypasses it
    // entirely. Electron has no per-webContents autoplay content-setting
    // API, hence the capture-phase play interceptor.
    const perSite = p.autoplay[origin];
    const policy = perSite === 'block' ? 'block' : (p.defaults['autoplay'] ?? 'ask');
    const interceptAutoplay = policy === 'block' || policy === 'ask';
    if (interceptAutoplay) {
      try {
        void wc
          .executeJavaScript(
            `(() => {
              if (window.__ntAutoplayBlock) return 'already';
              window.__ntAutoplayBlock = true;
              document.addEventListener('play', (e) => {
                try {
                  const v = e.target;
                  const activated =
                    !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
                  if (v instanceof HTMLMediaElement && !activated) v.pause();
                } catch {}
              }, true);
              return 'installed';
            })()`
          )
          .catch(() => {});
      } catch {
        /* noop */
      }
    }
  }

  /** Re-apply sound/autoplay policies to every live tab (after a Settings change). */
  applySitePoliciesToAll(): void {
    this.forEachWebContents((tab, wc) => {
      let url = '';
      try {
        url = wc.getURL();
      } catch {
        return;
      }
      this.applySitePolicies(wc, url, tab);
    });
  }

  /** Per-site popup policy: per-site override, else the global default, else 'ask'. */
  popupPolicyFor(url: string): 'allow' | 'block' | 'ask' {
    try {
      const origin = new URL(url).origin;
      return this.store.d.privacy.popups[origin]
        ?? this.store.d.privacy.defaults['popups']
        ?? 'ask';
    } catch {
      return 'ask';
    }
  }

  go(raw: string) {
    const tab = this.active();
    if (!tab) return;
    const url = resolveInput(raw, this.store.d.searchEngine);
    tab.lastActive = Date.now();
    try { tab.wc?.loadURL(url); } catch { tab.url = url; this.onChange(); }
  }

  back() { try { this.active()?.wc?.goBack(); } catch { /* noop */ } }
  forward() { try { this.active()?.wc?.goForward(); } catch { /* noop */ } }
  reload() { try { this.active()?.wc?.reload(); } catch { /* noop */ } }
  stop() { try { this.active()?.wc?.stop(); } catch { /* noop */ } }

  /** Reload a specific tab (not just the active one). */
  reloadTab(tabId: string) {
    try { this.tabs.get(tabId)?.wc?.reload(); } catch { /* noop */ } }

  /** Tab-level mute toggle (sidebar speaker icon / context menu). */
  setMuted(tabId: string, muted: boolean) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.muted === muted) return;
    tab.muted = muted;
    try { tab.wc?.setAudioMuted(muted); } catch { /* noop */ }
    this.onDelta({ tabId, type: 'muted', value: muted });
  }

  /** Duplicate a tab in its Bit, placed right after the original. */
  duplicate(tabId: string): TabRec | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    const dup = this.create(tab.spaceId, tab.url);
    dup.title = tab.title;
    const sibs = this.orderedTabs(tab.spaceId);
    const idx = sibs.findIndex((t) => t.id === tabId);
    const next = sibs[idx + 1];
    this.reorder(dup.id, next && next.id !== dup.id ? next.id : null, tab.folderId);
    this.activate(dup.id);
    return dup;
  }

  /** Close every other unpinned tab in the tab's Bit. */
  closeOthers(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    for (const t of this.orderedTabs(tab.spaceId)) {
      if (t.id !== tabId && !t.pinned) this.close(t.id);
    }
  }

  /** Close unpinned tabs to the right of the tab in sidebar order. */
  closeRight(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const sibs = this.orderedTabs(tab.spaceId);
    const idx = sibs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    for (const t of sibs.slice(idx + 1)) {
      if (!t.pinned) this.close(t.id);
    }
  }

  // -- archive ----------------------------------------------------------------
  archive(tabId: string, manual = false) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.pinned) return;
    if (this.activeTabId === tabId && !manual) return; // never sweep the visible tab
    const space = this.store.d.spaces.find((s) => s.id === tab.spaceId);
    const entry: ArchivedTab = {
      id: randomUUID(), spaceId: tab.spaceId,
      spaceName: space?.name ?? 'Bit',
      url: tab.url, title: tab.title, archivedAt: Date.now()
    };
    this.store.d.archived.unshift(entry);
    if (this.store.d.archived.length > 200) this.store.d.archived.length = 200;
    this.store.saveSoon();
    this.close(tabId);
  }

  /** Sweep idle tabs into the archive. Runs on a timer from main. */
  sweepIdle(now = Date.now()) {
    const after = this.store.d.archiveAfterMs;
    for (const tab of [...this.tabs.values()]) {
      if (!tab.pinned && tab.id !== this.activeTabId && now - tab.lastActive > after) {
        this.archive(tab.id);
      }
    }
  }

  restore(archivedId: string): TabRec | null {
    const i = this.store.d.archived.findIndex((a) => a.id === archivedId);
    if (i === -1) return null;
    const [entry] = this.store.d.archived.splice(i, 1);
    this.store.saveSoon();
    const spaceExists = this.store.d.spaces.some((s) => s.id === entry.spaceId);
    const spaceId = spaceExists ? entry.spaceId : this.store.d.activeSpaceId;
    const tab = this.create(spaceId, entry.url);
    tab.title = entry.title;
    this.activate(tab.id);
    return tab;
  }

  // -- snapshot ----------------------------------------------------------------
  toState(tab: TabRec): TabState {
    return {
      id: tab.id, spaceId: tab.spaceId, url: tab.url, title: tab.title,
      loading: tab.loading, pinned: tab.pinned,
      muted: tab.muted, audible: tab.audible,
      favicon: tab.favicon ?? this.faviconFor(tab.url),
      folderId: tab.folderId,
      canGoBack: tab.canGoBack, canGoForward: tab.canGoForward
    };
  }

  /** Persist pinned tabs so they survive restarts. */
  persistPinned() {
    for (const s of this.store.d.spaces) {
      s.pinned = this.orderedTabs(s.id)
        .filter((t) => t.pinned)
        .map((t) => ({ url: t.url, title: t.title }));
    }
    this.store.saveSoon();
  }

  restorePinned() {
    for (const s of this.store.d.spaces) {
      for (const p of s.pinned) {
        const tab = this.create(s.id, p.url, true);
        tab.title = p.title || p.url;
        tab.loading = false;
      }
    }
  }

  // -- open-tab sessions (per Bit, crash-safe) ---------------------------------
  /** Blank new-tab pages carry no state worth restoring. */
  private isRestorableUrl(url: string): boolean {
    return !!url && !url.startsWith('data:') && url !== 'about:blank';
  }

  /** Debounced write of every Bit's open tabs (url/title/folder/order). */
  persistSessionSoon() {
    if (this.sessionSaveTimer) return;
    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = null;
      this.persistSession();
    }, 500);
  }

  /** Synchronous session write — call before quit / destructive ops. */
  persistSession() {
    if (this.sessionSaveTimer) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    for (const s of this.store.d.spaces) {
      s.sessionTabs = this.orderedTabs(s.id)
        .filter((t) => !t.pinned && this.isRestorableUrl(t.url))
        .map((t) => ({ url: t.url, title: t.title, folderId: t.folderId, favicon: t.favicon ?? null }));
      // True per-Bit last-active URL — never the globally active tab's.
      const lastId = this.lastActiveBySpace.get(s.id);
      s.sessionActiveUrl = lastId ? this.tabs.get(lastId)?.url ?? null : null;
    }
    this.store.saveSoon();
  }

  /** Recreate last session's open tabs. Webviews mount lazily on first activation. */
  restoreSessions() {
    for (const s of this.store.d.spaces) {
      for (const st of s.sessionTabs) {
        const tab = this.create(s.id, st.url);
        tab.title = st.title || st.url;
        tab.folderId = st.folderId;
        tab.favicon = st.favicon ?? this.faviconFor(st.url) ?? undefined;
        tab.loading = false; // nothing has loaded yet — the webview mounts on activation
      }
      // Remember which tab was active so Bit switches restore the right one.
      const active = s.sessionActiveUrl
        ? this.orderedTabs(s.id).find((t) => t.url === s.sessionActiveUrl)
        : undefined;
      if (active) this.lastActiveBySpace.set(s.id, active.id);
    }
    if (this.sessionSaveTimer) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
  }

  /**
   * Move EVERY tab of a Bit into the Archive (including pinned and blank
   * start tabs) and destroy their guests. Used when deleting a Bit —
   * nothing is silently lost.
   */
  archiveSpaceTabs(spaceId: string) {
    const space = this.store.d.spaces.find((s) => s.id === spaceId);
    for (const tab of this.orderedTabs(spaceId)) {
      const entry: ArchivedTab = {
        id: randomUUID(), spaceId: tab.spaceId,
        spaceName: space?.name ?? 'Bit',
        url: tab.url, title: tab.title, archivedAt: Date.now()
      };
      this.store.d.archived.unshift(entry);
    }
    if (this.store.d.archived.length > 200) this.store.d.archived.length = 200;
    // Destroy the guests directly — close() would re-pick an active tab per tab.
    for (const tab of [...this.tabs.values()].filter((t) => t.spaceId === spaceId)) {
      try { tab.wc?.close(); } catch { /* already gone */ }
      this.tabs.delete(tab.id);
      const oi = this.order.indexOf(tab.id);
      if (oi !== -1) this.order.splice(oi, 1);
    }
    if (this.activeTabId && !this.tabs.has(this.activeTabId)) this.activeTabId = null;
    this.store.saveSoon();
  }
}
