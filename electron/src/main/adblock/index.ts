/**
 * Native ad blocker — main-process network filter.
 *
 * Hooks Electron's webRequest.onBeforeRequest on the webview session
 * (partition 'persist:nexttoken') and cancels ad/tracker requests using
 * the bundled filter list (see filters.ts) matched by matcher.ts.
 *
 * - Global on/off + per-site allowlist live in the Store (persisted).
 * - Blocked counts are tracked per tab and pushed to the renderer so the
 *   toolbar shield can show a live badge.
 * - Fail-open everywhere: any error or missing context lets the request
 *   through so normal page loads never break.
 */

import { session } from 'electron';
import { FilterMatcher, hostOf } from './matcher';
import { FILTER_TEXT } from './filters';
import type { Store } from '../store';

export interface AdBlockStats {
  tabId: string;
  count: number;
}

/** webview partition used by the renderer's <webview> guests. */
const PARTITION = 'persist:nexttoken';

interface GuestTrack {
  tabId: string;
  /** Last known top-level URL — page context for third-party checks. */
  topUrl: string;
}

export class AdBlocker {
  private matcher = new FilterMatcher(FILTER_TEXT);
  /** Guest webContentsId -> track. */
  private guests = new Map<number, GuestTrack>();
  private tabToWc = new Map<string, number>();
  private counts = new Map<string, number>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  private attached = false;

  constructor(
    private store: Store,
    private emit: (s: AdBlockStats) => void,
  ) {}

  /** Number of bundled filter rules (for diagnostics / settings UI). */
  get ruleCount(): number {
    return this.matcher.size;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    session.fromPartition(PARTITION).webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => {
        try {
          // webContentsId can be absent for some request kinds — fail open.
          const wcId = details.webContentsId;
          if (wcId !== undefined && this.shouldBlock(details.url, details.resourceType, wcId)) {
            const g = this.guests.get(wcId);
            if (g) {
              const n = (this.counts.get(g.tabId) ?? 0) + 1;
              this.counts.set(g.tabId, n);
              this.scheduleFlush(g.tabId);
            }
            callback({ cancel: true });
            return;
          }
        } catch {
          /* fail open — never break a page load */
        }
        callback({});
      },
    );
  }

  private shouldBlock(url: string, resourceType: string, wcId: number): boolean {
    const cfg = this.store.d.adblock;
    if (!cfg || cfg.enabled === false) return false;
    const g = this.guests.get(wcId);
    const pageUrl = g?.topUrl;
    if (pageUrl) {
      const host = hostOf(pageUrl);
      if (host && cfg.allowedHosts.includes(host)) return false;
    }
    return this.matcher.matches(url, { pageUrl, resourceType });
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
