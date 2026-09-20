import { webContents } from 'electron';
import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { ArchivedTab, TabDelta, TabState } from '../shared/ipc';
import type { Store } from './store';

export interface TabRec {
  id: string;
  spaceId: string;
  url: string;
  title: string;
  loading: boolean;
  pinned: boolean;
  lastActive: number;
  wc: WebContents | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Fresh tabs open a blank titled page — the renderer draws the large
 * centered command bar over it (Dia pattern: no tile page). A data: URL
 * keeps this offline and gives the guest a real title for the smoke test. */
const START_URL =
  'data:text/html,<html><head><title>New Tab</title></head><body></body></html>';

/** Decide whether raw input is a URL or a search query. */
export function resolveInput(raw: string, searchEngine: string): string {
  const t = raw.trim();
  if (!t) return START_URL;
  // Already a full URL or an internal page — pass through untouched.
  if (/^(data|about|file):/i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t; // has a scheme
  if (/^localhost(:\d+)?(\/\S*)?$/i.test(t)) return 'http://' + t;
  // domain-like: no spaces, has a dot, plausible TLD-ish shape
  if (/^[^\s]+\.[^\s]{2,}(\/\S*)?$/.test(t) && !/\s/.test(t)) return 'https://' + t;
  return searchEngine + encodeURIComponent(t);
}

export class TabManager {
  tabs = new Map<string, TabRec>();
  activeTabId: string | null = null;

  constructor(
    private store: Store,
    private onChange: () => void,
    private onDelta: (d: TabDelta) => void
  ) {}

  // -- lifecycle -------------------------------------------------------------
  create(spaceId: string, rawUrl?: string, pinned = false): TabRec {
    // Don't re-resolve the default: START_URL is a data: URL and must be
    // passed through untouched, never search-routed.
    const url = rawUrl ? resolveInput(rawUrl, this.store.d.searchEngine) : START_URL;
    const tab: TabRec = {
      id: randomUUID(), spaceId, url,
      title: 'New Tab', loading: true, pinned,
      lastActive: Date.now(), wc: null,
      canGoBack: false, canGoForward: false
    };
    this.tabs.set(tab.id, tab);
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
      this.maybeInjectBoost(wc, tab);
    });
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title || tab.url;
      this.onDelta({ tabId: tab.id, type: 'title', value: tab.title });
    });
    const onNav = (url: string) => {
      tab.url = url;
      tab.canGoBack = wc.canGoBack();
      tab.canGoForward = wc.canGoForward();
      this.onDelta({
        tabId: tab.id, type: 'url', value: url,
        canGoBack: tab.canGoBack, canGoForward: tab.canGoForward
      });
    };
    wc.on('did-navigate', (_e, url) => onNav(url));
    wc.on('did-navigate-in-page', (_e, url) => onNav(url));
    wc.once('destroyed', () => { tab.wc = null; });
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
    if (this.activeTabId === tabId) {
      const sib = [...this.tabs.values()].find((t) => t.spaceId === tab.spaceId && !t.pinned)
        ?? [...this.tabs.values()].find((t) => t.spaceId === tab.spaceId);
      this.activeTabId = sib ? sib.id : null;
    }
    this.onChange();
  }

  activate(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.activeTabId = tabId;
    tab.lastActive = Date.now();
    try { tab.wc?.focus(); } catch { /* noop */ }
    this.onChange();
  }

  // -- navigation (active tab) -----------------------------------------------
  private active(): TabRec | null {
    return (this.activeTabId && this.tabs.get(this.activeTabId)) || null;
  }

  activeWebContents(): WebContents | null {
    return this.active()?.wc ?? null;
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

  // -- archive ----------------------------------------------------------------
  archive(tabId: string, manual = false) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.pinned) return;
    if (this.activeTabId === tabId && !manual) return; // never sweep the visible tab
    const space = this.store.d.spaces.find((s) => s.id === tab.spaceId);
    const entry: ArchivedTab = {
      id: randomUUID(), spaceId: tab.spaceId,
      spaceName: space?.name ?? 'Space',
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
      canGoBack: tab.canGoBack, canGoForward: tab.canGoForward
    };
  }

  /** Persist pinned tabs so they survive restarts. */
  persistPinned() {
    for (const s of this.store.d.spaces) {
      s.pinned = [...this.tabs.values()]
        .filter((t) => t.spaceId === s.id && t.pinned)
        .map((t) => ({ url: t.url, title: t.title }));
    }
    this.store.saveSoon();
  }

  restorePinned() {
    for (const s of this.store.d.spaces) {
      for (const p of s.pinned) {
        const tab = this.create(s.id, p.url, true);
        tab.title = p.title || p.url;
      }
    }
  }
}
