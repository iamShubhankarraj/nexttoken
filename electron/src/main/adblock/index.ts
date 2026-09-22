/**
 * Native ad blocker — Ghostery engine wrapper (main process).
 *
 * Uses @ghostery/adblocker-electron: a full EasyList / uBlock-Origin
 * compatible engine (network filters, cosmetic element-hiding filters,
 * and scriptlet injection — the combination that kills YouTube-style
 * video ads, not just network requests).
 *
 * Filter lists: the `fullLists` set published by `@ghostery/adblocker`
 * itself — EasyList, EasyPrivacy, Peter Lowe's, uBlock Origin filters +
 * unbreak/badware/resource-abuse/privacy, the **quick-fixes** list (where
 * YouTube's rapid-response player-ad counter-measures live), and the
 * annoyance/cookie lists. Fetched from Ghostery's CDN mirror on first
 * run; the compiled engine is serialized to disk (app userData) and
 * reused on later launches, with a background re-fetch every 24 hours.
 * One dead list degrades to an empty list instead of killing the whole
 * engine; only a total fetch failure leaves the blocker inert (fail-open)
 * — normal browsing keeps working, just unfiltered.
 *
 * Blocking is wired into the default session AND the webview guest
 * session (partition 'persist:nexttoken'); a web-contents-created hook
 * covers any guest session created later.
 *
 * - Global on/off + per-site allowlist live in the Store (persisted).
 * - Blocked counts are tracked per tab and pushed to the renderer so the
 *   toolbar shield can show a live badge.
 * - Fail-open everywhere: any error or missing context lets the request
 *   through so normal page loads never break.
 */

import { app, ipcMain, session } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  ElectronBlocker,
  type Caching,
  type Request,
} from '@ghostery/adblocker-electron';
import {
  FILTER_LIST_URLS,
  FilterListsUnavailableError,
  type FetchLike,
  isPageProtected,
  makeResilientFetch,
} from './filtering';
import type { Store } from '../store';

export interface AdBlockStats {
  tabId: string;
  count: number;
}

/** webview partition used by the renderer's <webview> guests. */
const PARTITION = 'persist:nexttoken';

/** Serialized engine cache, inside app userData. */
const ENGINE_CACHE_FILE = 'adblock-engine.bin';

/** How often filter lists are re-fetched in the background. */
const LIST_REFRESH_MS = 24 * 60 * 60 * 1000;

/** Diagnostics surfaced to Settings → Privacy. */
export interface AdBlockDiagnostics {
  /** Engine loaded and enforcing (false while lists are still fetching). */
  ready: boolean;
  ruleCount: number;
  listsLoaded: number;
  listsTotal: number;
  /** Epoch ms of the last successful list fetch, null when never. */
  lastUpdatedMs: number | null;
  /** List URLs that failed on the last load/refresh (degraded, not dead). */
  failedLists: string[];
  resourcesDegraded: boolean;
}

/** Cosmetic-injection IPC channels the engine registers per session. */
const COSMETIC_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters';
const MUTATION_CHANNEL = '@ghostery/adblocker/is-mutation-observer-enabled';

/** Raw fetch for the resilient wrapper (needs HTTP status, not just text). */
const FETCH_LIKE = fetch as unknown as FetchLike;

interface GuestTrack {
  tabId: string;
  /** Last known top-level URL — page context for per-site allowlist. */
  topUrl: string;
}

export class AdBlocker {
  private blocker: ElectronBlocker | null = null;
  private loadPromise: Promise<void> | null = null;
  private cachedRuleCount = 0;
  private caching: Caching | null = null;
  private failedLists: string[] = [];
  private listsLoaded = 0;
  private lastUpdatedMs: number | null = null;
  private resourcesDegraded = false;
  /** Every session we've ever seen (for re-enable after refresh/toggle). */
  private knownSessions = new Set<Electron.Session>();
  /** Sessions currently wired for blocking. */
  private enabledSessions = new Set<Electron.Session>();
  /** Guest webContentsId -> track. */
  private guests = new Map<number, GuestTrack>();
  private tabToWc = new Map<string, number>();
  private counts = new Map<string, number>();
  private flushTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private store: Store,
    private emit: (s: AdBlockStats) => void,
  ) {}

  /** Number of loaded filter rules (for diagnostics / settings UI). */
  get ruleCount(): number {
    return this.cachedRuleCount;
  }

  /** Snapshot of engine health for Settings → Privacy. */
  getDiagnostics(): AdBlockDiagnostics {
    return {
      ready: this.blocker !== null && this.cachedRuleCount > 0,
      ruleCount: this.cachedRuleCount,
      listsLoaded: this.listsLoaded,
      listsTotal: FILTER_LIST_URLS.length,
      lastUpdatedMs: this.lastUpdatedMs,
      failedLists: [...this.failedLists],
      resourcesDegraded: this.resourcesDegraded,
    };
  }

  /** Manual "check for filter updates" from Settings (debounced by load). */
  refreshNow(): Promise<void> {
    if (!this.caching) return Promise.resolve();
    return this.refreshLists(this.caching).catch((err) => {
      console.error('[adblock] manual list refresh failed:', err);
    });
  }

  attach(): void {
    if (this.loadPromise) return;
    // Cover guest sessions created after boot (new partitions, etc.).
    app.on('web-contents-created', (_event, contents) => {
      try {
        const ses = contents.session;
        this.knownSessions.add(ses);
        this.setupSession(ses);
      } catch {
        /* fail open */
      }
    });
    this.loadPromise = this.loadEngine().catch((err) => {
      // Offline with no cache (or CDN down): stay inert, never crash.
      console.error('[adblock] engine unavailable — browsing unfiltered:', err);
    });
  }

  private async loadEngine(): Promise<void> {
    const cachePath = path.join(app.getPath('userData'), ENGINE_CACHE_FILE);
    const caching: Caching = {
      path: cachePath,
      read: async (p: string): Promise<Uint8Array> => {
        const buf = await fs.readFile(p);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      },
      write: async (p: string, buffer: Uint8Array): Promise<void> => {
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(
          p,
          Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        );
      },
    };
    // fromLists: read serialized cache if present, else fetch lists from
    // CDN, build the engine, and write the cache for next launch.
    // The fetch wrapper is resilient: one dead list (404, timeout) degrades
    // to an empty list instead of rejecting the whole build, and a dead
    // resources.json degrades scriptlet injection only. Only a total
    // failure (every list down) throws — and then we stay fail-open.
    const failed: string[] = [];
    let resourcesDegraded = false;
    const resilientFetch = makeResilientFetch(FETCH_LIKE, FILTER_LIST_URLS, {
      onListFailed: (url, err) => {
        failed.push(url);
        console.warn('[adblock] filter list failed, continuing without it:', url, err);
      },
      onResourcesFailed: (err) => {
        resourcesDegraded = true;
        console.warn('[adblock] scriptlet resources failed, injection degraded:', err);
      },
    });
    const blocker = await ElectronBlocker.fromLists(
      resilientFetch,
      FILTER_LIST_URLS,
      {},
      caching,
    );
    this.caching = caching;
    this.failedLists = failed;
    this.listsLoaded = FILTER_LIST_URLS.length - failed.length;
    this.lastUpdatedMs = Date.now();
    this.resourcesDegraded = resourcesDegraded;
    this.installEngine(blocker);
    // Keep lists fresh without blocking startup.
    setInterval(() => {
      void this.refreshLists(caching).catch((err) => {
        console.error('[adblock] background list refresh failed:', err);
      });
    }, LIST_REFRESH_MS);
  }

  private installEngine(blocker: ElectronBlocker): void {
    this.blocker = blocker;
    // The engine emits these from its match() — our network wrapper
    // delegates to blocker.onBeforeRequest, so every blocked request lands
    // here with request.tabId = the guest webContentsId.
    blocker.on('request-blocked', (req: Request) => this.noteBlocked(req));
    blocker.on('request-redirected', (req: Request) => this.noteBlocked(req));
    try {
      const { networkFilters, cosmeticFilters } = blocker.getFilters();
      this.cachedRuleCount = networkFilters.length + cosmeticFilters.length;
    } catch {
      this.cachedRuleCount = 0;
    }
    this.refreshConfig();
  }

  /** Re-fetch lists in the background and hot-swap the engine. */
  private async refreshLists(caching: Caching): Promise<void> {
    const old = this.blocker;
    if (!old) return;
    const failed: string[] = [];
    let resourcesDegraded = false;
    const resilientFetch = makeResilientFetch(FETCH_LIKE, FILTER_LIST_URLS, {
      onListFailed: (url, err) => {
        failed.push(url);
        console.warn('[adblock] filter list failed, continuing without it:', url, err);
      },
      onResourcesFailed: (err) => {
        resourcesDegraded = true;
        console.warn('[adblock] scriptlet resources failed, injection degraded:', err);
      },
    });
    let fresh: ElectronBlocker;
    try {
      fresh = await ElectronBlocker.fromLists(
        resilientFetch,
        FILTER_LIST_URLS,
        {},
        caching,
      );
    } catch (err) {
      // Total fetch failure (or a corrupt cache): keep the old engine
      // running on its stale lists rather than going dark.
      if (err instanceof FilterListsUnavailableError) {
        console.error('[adblock] background refresh: all lists down, keeping stale engine');
        return;
      }
      throw err;
    }
    this.failedLists = failed;
    this.listsLoaded = FILTER_LIST_URLS.length - failed.length;
    this.lastUpdatedMs = Date.now();
    this.resourcesDegraded = resourcesDegraded;
    // Tear down old session wiring first so webRequest listeners and IPC
    // handlers never double up, then install the new engine.
    for (const ses of [...this.enabledSessions]) {
      try {
        old.disableBlockingInSession(ses);
      } catch {
        /* already gone */
      }
    }
    this.enabledSessions.clear();
    this.installEngine(fresh);
  }

  /**
   * Re-apply the global toggle after a settings change. No-op until the
   * engine has loaded (installEngine applies the persisted config).
   */
  refreshConfig(): void {
    const blocker = this.blocker;
    if (!blocker) return;
    if (this.store.d.adblock.enabled === false) {
      // Full teardown: removes network listeners, CSP header injection,
      // and the cosmetic preload wiring from every session.
      for (const ses of [...this.enabledSessions]) {
        try {
          blocker.disableBlockingInSession(ses);
        } catch {
          /* already gone */
        }
      }
      this.enabledSessions.clear();
      return;
    }
    this.setupSession(session.defaultSession);
    this.setupSession(session.fromPartition(PARTITION));
    for (const ses of this.knownSessions) this.setupSession(ses);
  }

  /**
   * Wire one session: engine network+CSP listeners, cosmetic/scriptlet
   * injection, then our own onBeforeRequest wrapper (Electron keeps a
   * single listener per session — ours replaces the engine's and
   * delegates after the global/per-site checks).
   */
  private setupSession(ses: Electron.Session): void {
    const blocker = this.blocker;
    if (!blocker || this.enabledSessions.has(ses)) return;
    // enableBlockingInSession registers the two cosmetic IPC handlers on
    // EVERY call and Electron throws on double registration. Both handlers
    // are bound to this same blocker instance, so dropping stale ones
    // first is safe.
    for (const ch of [COSMETIC_CHANNEL, MUTATION_CHANNEL]) {
      try {
        ipcMain.removeHandler(ch);
      } catch {
        /* noop */
      }
    }
    try {
      blocker.enableBlockingInSession(ses);
    } catch (err) {
      console.error('[adblock] failed to wire session:', err);
      return;
    }
    ses.webRequest.onBeforeRequest(
      { urls: ['<all_urls>'] },
      this.onBeforeRequest,
    );
    // Route cosmetic/scriptlet injection through the per-site allowlist
    // (the engine itself has no per-site concept).
    for (const ch of [COSMETIC_CHANNEL, MUTATION_CHANNEL]) {
      try {
        ipcMain.removeHandler(ch);
      } catch {
        /* noop */
      }
    }
    ipcMain.handle(COSMETIC_CHANNEL, this.onInjectCosmeticFilters);
    ipcMain.handle(MUTATION_CHANNEL, blocker.onIsMutationObserverEnabled);
    this.enabledSessions.add(ses);
  }

  /** True when the page may be filtered (global on, site not allowlisted). */
  private isProtected(pageUrl: string | undefined): boolean {
    return isPageProtected(
      pageUrl,
      this.store.d.adblock.enabled !== false,
      this.store.d.adblock.allowedHosts,
    );
  }

  private onBeforeRequest = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void,
  ): void => {
    try {
      const blocker = this.blocker;
      const wcId = details.webContentsId;
      const pageUrl =
        wcId !== undefined ? this.guests.get(wcId)?.topUrl : undefined;
      if (blocker && this.isProtected(pageUrl)) {
        blocker.onBeforeRequest(details, callback);
        return;
      }
    } catch {
      /* fail open — never break a page load */
    }
    callback({});
  };

  private onInjectCosmeticFilters = async (
    event: Electron.IpcMainInvokeEvent,
    url: string,
    msg?: Parameters<ElectronBlocker['onInjectCosmeticFilters']>[2],
  ): Promise<void> => {
    try {
      const blocker = this.blocker;
      if (!blocker) return;
      if (!this.isProtected(url)) return;
      await blocker.onInjectCosmeticFilters(event, url, msg);
    } catch {
      /* never break page rendering */
    }
  };

  private noteBlocked(req: Request): void {
    try {
      const g = this.guests.get(req.tabId);
      if (!g) return;
      const n = (this.counts.get(g.tabId) ?? 0) + 1;
      this.counts.set(g.tabId, n);
      this.scheduleFlush(g.tabId);
    } catch {
      /* stats must never break blocking */
    }
  }

  /** A guest webContents attached to a tab (from nt.tabs.attach). */
  noteAttach(tabId: string, wcId: number, url: string): void {
    this.guests.set(wcId, { tabId, topUrl: url });
    this.tabToWc.set(tabId, wcId);
  }

  /** Top-level navigation — refresh page context and reset the counter. */
  noteNavigation(tabId: string, url: string): void {
    const wcId = this.tabToWc.get(tabId);
    if (wcId !== undefined) {
      const g = this.guests.get(wcId);
      if (g) g.topUrl = url;
    }
    if ((this.counts.get(tabId) ?? 0) > 0) {
      this.counts.set(tabId, 0);
      this.emit({ tabId, count: 0 });
    }
  }

  /** Tab closed / archived — drop tracking state. */
  noteDetach(tabId: string): void {
    const wcId = this.tabToWc.get(tabId);
    if (wcId !== undefined) {
      this.guests.delete(wcId);
      this.tabToWc.delete(tabId);
    }
    this.counts.delete(tabId);
    const t = this.flushTimers.get(tabId);
    if (t) {
      clearTimeout(t);
      this.flushTimers.delete(tabId);
    }
  }

  /** Debounced stats push so the shield badge updates live, not per request. */
  private scheduleFlush(tabId: string): void {
    if (this.flushTimers.has(tabId)) return;
    this.flushTimers.set(
      tabId,
      setTimeout(() => {
        this.flushTimers.delete(tabId);
        this.emit({ tabId, count: this.counts.get(tabId) ?? 0 });
      }, 350),
    );
  }
}
