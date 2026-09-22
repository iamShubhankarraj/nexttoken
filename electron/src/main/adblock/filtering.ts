/**
 * Pure, Electron-free helpers for the native ad blocker.
 *
 * Kept free of `electron` imports on purpose so it can be unit-tested
 * with plain node (see electron/scripts/adblock-test.mjs) and reused
 * without a BrowserWindow in sight.
 *
 * Filter lists: we use the `fullLists` set published by
 * `@ghostery/adblocker` itself (same URLs the library's own
 * `fromPrebuiltFull()` uses), instead of a hand-rolled subset:
 *
 * - EasyList + EasyPrivacy + Peter Lowe's server list
 * - uBlock Origin: filters, filters-2020…2024, unbreak, badware,
 *   resource-abuse, privacy
 * - uBlock Origin **quick-fixes** — this is where the rapid-response
 *   YouTube counter-measures live (playerResponse adPlacements/adSlots
 *   pruning scriptlets, anti-adblock defusers). Without it, YouTube
 *   pre-roll/mid-roll video ads largely survive network-only blocking
 *   because they are served from the same googlevideo.com hosts as the
 *   video itself.
 * - Annoyance + cookie-notice lists (uBO parity)
 *
 * Because the list comes from the installed package, upgrading
 * `@ghostery/adblocker` automatically tracks Ghostery's curated set.
 */

import { fullLists, type Fetch } from '@ghostery/adblocker';

/** Filter list URLs, in fetch order. */
export const FILTER_LIST_URLS: string[] = [...fullLists];

/** Scriptlet/redirect resource bundle the engine needs for `+js()` rules. */
export const RESOURCES_URL =
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';

/**
 * Minimal valid resources distribution. Returned when resources.json
 * cannot be fetched: network + cosmetic blocking keep working, only
 * scriptlet injection degrades until the next successful refresh.
 */
export const EMPTY_RESOURCES_JSON = '{"scriptlets":[],"redirects":[]}';

/** Thrown when not a single filter list could be fetched (stay fail-open). */
export class FilterListsUnavailableError extends Error {
  constructor(failed: string[]) {
    super(
      `adblock: all ${failed.length} filter lists failed to download; staying unfiltered`,
    );
    this.name = 'FilterListsUnavailableError';
  }
}

/** Minimal fetch shape the resilient wrapper needs (HTTP status aware). */
export type FetchLike = (url: string) => Promise<Response>;

export interface ResilientFetchHooks {
  /** Called once per list URL that failed (after the engine's own retries). */
  onListFailed?: (url: string, err: unknown) => void;
  /** Called when resources.json could not be fetched. */
  onResourcesFailed?: (err: unknown) => void;
}

const isResourcesUrl = (url: string): boolean =>
  url.endsWith('/ublock-origin/resources.json');

/**
 * Wrap a `fetch` implementation so one bad list can never kill the whole
 * engine: `ElectronBlocker.fromLists` does `Promise.all` over every list,
 * so a single 404/offline list would otherwise reject the entire build
 * and leave browsing unfiltered.
 *
 * - Non-OK HTTP responses count as failures (the engine's own retry only
 *   covers network errors, not 404s).
 * - A failed *list* resolves to an empty list: the engine builds from the
 *   lists that did arrive.
 * - A failed *resources.json* resolves to an empty (but valid) resources
 *   distribution: blocking keeps working, scriptlet injection degrades.
 * - If *every* list fails, throws FilterListsUnavailableError so the
 *   caller can stay fail-open instead of running a zero-rule engine.
 */
export function makeResilientFetch(
  fetchImpl: FetchLike,
  urls: string[] = FILTER_LIST_URLS,
  hooks: ResilientFetchHooks = {},
): Fetch {
  const listUrls = new Set(urls);
  let failedLists = 0;
  return async (url: string) => {
    try {
      const res = await fetchImpl(url);
      // The engine's own retry only covers network errors, not HTTP errors:
      // a 404 body would otherwise be parsed as (garbage) rules.
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      if (isResourcesUrl(url) || !listUrls.has(url)) {
        // resources.json (or anything unexpected): degrade gracefully.
        hooks.onResourcesFailed?.(err);
        return new Response(EMPTY_RESOURCES_JSON, { status: 200 });
      }
      failedLists += 1;
      hooks.onListFailed?.(url, err);
      if (failedLists >= listUrls.size) {
        throw new FilterListsUnavailableError([...listUrls]);
      }
      return new Response('', { status: 200 });
    }
  };
}

/** Lower-cased hostname of a URL, '' when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True when a page may be filtered: the global switch is on and the
 * page's host is not on the per-site allowlist. Exact-host match —
 * allowlisting `example.com` does not allowlist `ads.example.com`.
 */
export function isPageProtected(
  pageUrl: string | undefined,
  enabled: boolean,
  allowedHosts: string[],
): boolean {
  if (!enabled) return false;
  if (pageUrl) {
    const host = hostOf(pageUrl);
    if (host && allowedHosts.includes(host)) return false;
  }
  return true;
}

/** Human-friendly "x rules · y lists · updated z ago" line for Settings. */
export function describeEngineStatus(
  ruleCount: number,
  listsLoaded: number,
  listsTotal: number,
  lastUpdatedMs: number | null,
  nowMs: number = Date.now(),
): string {
  const rules =
    ruleCount > 0 ? `${ruleCount.toLocaleString('en-US')} filter rules` : 'filter lists not loaded yet';
  const lists = ` · ${listsLoaded}/${listsTotal} lists`;
  let updated = '';
  if (lastUpdatedMs !== null) {
    const mins = Math.max(0, Math.round((nowMs - lastUpdatedMs) / 60000));
    updated =
      mins < 1 ? ' · updated just now' : mins < 60 ? ` · updated ${mins}m ago` : ` · updated ${Math.round(mins / 60)}h ago`;
  }
  return `${rules}${ruleCount > 0 ? lists : ''}${updated}`;
}
