/**
 * siteZoom.ts — per-origin zoom memory (v0.6.3, impl-5).
 *
 * Follows the mute/autoplay per-origin pattern: the origin is derived from
 * the navigating URL, the percent is persisted in store.d.privacy.zoom,
 * and re-applied whenever a tab lands on a remembered origin. tabs.ts and
 * privacy.ts are untouched — this module is called from index.ts's
 * TabDelta 'url' wire and the nt.tabs.zoom handler.
 */
import type { WebContents } from 'electron';
import type { Store } from './store';

/** Electron zoom percent <-> zoom level (Chromium uses 1.2^level). */
export function percentToLevel(percent: number): number {
  return Math.log(percent / 100) / Math.log(1.2);
}

export function levelToPercent(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100);
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin.startsWith('http') ? origin : null;
  } catch {
    return null;
  }
}

/** Apply the remembered zoom to one tab after a navigation. */
export function applyForTab(
  store: Store,
  tab: { wc?: WebContents } | undefined,
  url: string
): void {
  const origin = originOf(url);
  if (!origin) return;
  const percent = store.d.privacy.zoom[origin];
  if (typeof percent !== 'number') return;
  const wc = tab?.wc;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.setZoomLevel(percentToLevel(percent));
  } catch {
    /* noop */
  }
}

/** Remember a user-initiated zoom for the origin (100 clears the memory). */
export function recordZoom(store: Store, url: string, percent: number): void {
  const origin = originOf(url);
  if (!origin) return;
  store.setSiteZoom(origin, percent);
}

/** All remembered zooms, newest-first is unnecessary — sorted by origin. */
export function listZooms(store: Store): Array<{ origin: string; percent: number }> {
  return Object.entries(store.d.privacy.zoom)
    .map(([origin, percent]) => ({ origin, percent }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

/**
 * Forget one origin's zoom and reset live tabs on it back to 100%.
 * Returns the refreshed list.
 */
export function resetZoom(
  store: Store,
  forEachWebContents: (cb: (wc: WebContents) => void) => void,
  origin: string
): Array<{ origin: string; percent: number }> {
  store.setSiteZoom(origin, null);
  forEachWebContents((wc) => {
    let url = '';
    try {
      url = wc.getURL();
    } catch {
      return;
    }
    if (originOf(url) === origin) {
      try {
        wc.setZoomLevel(0);
      } catch {
        /* noop */
      }
    }
  });
  return listZooms(store);
}
