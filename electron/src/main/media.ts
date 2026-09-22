/**
 * Media controller — drives the best video element across tabs.
 *
 * The sidebar's curved viewfinder (not the page) controls media that is
 * playing in a *background* tab: the viewfinder appears only when the user
 * is NOT on the tab where the media plays. When the media tab is active,
 * the curve stays clean and the page itself shows the video.
 *
 * Used by the viewfinder (`nt.media.*` IPC), the PiP engine, and the
 * agent's picture_in_picture / media_toggle tools (those target the active
 * tab, as before). All page interaction goes through one shared "best
 * video" snippet so the heuristic (playing first, then largest) is
 * identical everywhere.
 */
import type { WebContents } from 'electron';
import type { TabManager } from './tabs';
import type { MediaState } from '../shared/ipc';

/** JS evaluated in the guest: the best video element (or null).
 *
 * Two deliberate choices:
 *  - NO `disablePictureInPicture` filter. YouTube sets that flag on music
 *    content (PiP is Premium-gated there); filtering on it made the
 *    viewfinder blind to the very songs people play most, and the poll then
 *    fell back to some other tab's paused video — wrong title, wrong
 *    duration, wrong position. PiP-gating belongs on the PiP *button*, not
 *    on detection.
 *  - The playing video ALWAYS wins, regardless of size. (The old code built
 *    a playing-first array and then re-sorted it by area, silently
 *    discarding the preference.) Largest is only the tiebreak among
 *    non-playing candidates.
 */
const BEST_VIDEO_JS = `(() => {
  const vids = [...document.querySelectorAll('video')]
    .filter(v => v.readyState >= 2);
  if (!vids.length) return null;
  const playing = vids.find(v => !v.paused && !v.ended);
  if (playing) return playing;
  vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  return vids[0];
})()`;

/** Guard an executeJavaScript so a wedged page can't stall the poll loop.
 * `userGesture` grants transient activation — required for
 * requestPictureInPicture / video.play() issued from main-process IPC. */
async function evalGuest<T>(
  wc: WebContents,
  js: string,
  timeoutMs = 1500,
  userGesture = false
): Promise<T | null> {
  if (!wc || wc.isDestroyed()) return null;
  try {
    const r = await Promise.race([
      wc.executeJavaScript(js, userGesture),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return r as T | null;
  } catch {
    return null;
  }
}

/** True when the tab's guest has a playable video element. */
export async function hasPlayableVideo(wc: WebContents): Promise<boolean> {
  const r = await evalGuest<boolean>(
    wc,
    `(() => { const v = ${BEST_VIDEO_JS}; return v ? true : false; })()`,
    1500
  );
  return r === true;
}

/** Resolve the webContents media actions should target. */
function targetWc(tabs: TabManager, tabId?: string): WebContents | null {
  if (tabId) return tabs.webContentsFor(tabId);
  return tabs.activeWebContents();
}

/**
 * Native PiP via the page's own requestPictureInPicture — the fallback path
 * when the custom Next Token PiP window can't be used. `userGesture: true`
 * is essential: without it Chromium rejects with "Must be handling a user
 * gesture" because the call arrives via main-process IPC. Toggles off when
 * a PiP window is already open.
 */
export async function enterNativePictureInPicture(
  tabs: TabManager,
  tabId?: string
): Promise<{ ok: boolean; error?: string }> {
  const wc = targetWc(tabs, tabId);
  const res = await (wc
    ? evalGuest<string>(
        wc,
        `(() => {
          const v = ${BEST_VIDEO_JS};
          if (!v) return 'none';
          if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
            return 'toggled-off';
          }
          return v.requestPictureInPicture()
            .then(() => 'ok')
            .catch(e => 'err:' + (e && e.message ? e.message : e));
        })()`,
        4000,
        true // user gesture: grants transient activation for requestPictureInPicture
      )
    : null);
  if (res === 'ok' || res === 'toggled-off') return { ok: true };
  if (res === 'none') return { ok: false, error: 'No playable video found on this page.' };
  if (res === null) return { ok: false, error: 'No video tab.' };
  return {
    ok: false,
    error: res.startsWith('err:') ? res.slice(4) : 'Picture in Picture failed.',
  };
}

/**
 * Put a tab's best video into Picture-in-Picture. Picks the
 * currently-playing video first, then the largest visible one. Runs inside
 * the page, so site players (YouTube, etc.) keep working. Calling again
 * while a PiP window is open exits it. Defaults to the active tab (agent
 * tools); the viewfinder passes its background media tab id.
 *
 * NOTE: the primary PiP surface is now the custom Next Token PiP window
 * (main/pip.ts); this native path is kept as its fallback.
 */
export async function enterPictureInPicture(
  tabs: TabManager,
  tabId?: string
): Promise<{ ok: boolean; error?: string }> {
  return enterNativePictureInPicture(tabs, tabId);
}

interface GuestMedia {
  hasVideo: boolean;
  title?: string;
  currentTime?: number;
  duration?: number;
  live?: boolean;
  paused?: boolean;
}

/** Read one tab's media state. */
async function queryTabMedia(wc: WebContents): Promise<GuestMedia> {
  const s = await evalGuest<GuestMedia>(
    wc,
    `(v => v ? {
      hasVideo: true,
      title: String(document.title || '').slice(0, 120),
      currentTime: v.currentTime || 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      live: !Number.isFinite(v.duration),
      paused: !!v.paused,
    } : { hasVideo: false })(${BEST_VIDEO_JS})`
  );
  return s ?? { hasVideo: false };
}

/** Seek a tab's video to `ratio` (0..1) of its duration. */
export async function seekMedia(
  tabs: TabManager,
  ratio: number,
  tabId?: string
): Promise<void> {
  const wc = targetWc(tabs, tabId);
  if (!wc) return;
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  await evalGuest(
    wc,
    `(() => {
      const v = ${BEST_VIDEO_JS};
      if (v && Number.isFinite(v.duration) && v.duration > 0) {
        v.currentTime = v.duration * ${r};
      }
    })()`
  );
}

/** Toggle play/pause on a tab's video. userGesture grants transient
 * activation so play() works when invoked from main-process IPC. */
export async function toggleMedia(
  tabs: TabManager,
  tabId?: string
): Promise<{ paused: boolean }> {
  const wc = targetWc(tabs, tabId);
  const paused = wc
    ? await evalGuest<boolean>(
        wc,
        `(() => {
          const v = ${BEST_VIDEO_JS};
          if (!v) return null;
          if (v.paused) { v.play().catch(() => {}); return false; }
          v.pause();
          return true;
        })()`,
        1500,
        true
      )
    : null;
  return { paused: paused !== false };
}

/**
 * Capture a small live thumbnail of the media tab's best video.
 * Crops capturePage to the video's rect and downscales — cheap enough for
 * ~2-3 fps while the viewfinder is visible. Returns a data URL or null.
 */
export async function captureMediaThumb(
  tabs: TabManager,
  tabId: string
): Promise<string | null> {
  const wc = tabs.webContentsFor(tabId);
  if (!wc) return null;
  const rect = await evalGuest<{ x: number; y: number; w: number; h: number } | null>(
    wc,
    `(() => {
      const v = ${BEST_VIDEO_JS};
      if (!v) return null;
      const r = v.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), w: r.width, h: r.height };
    })()`,
    1200
  );
  if (!rect) return null;
  try {
    const shot = await wc.capturePage({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.w),
      height: Math.round(rect.h),
    });
    if (shot.isEmpty()) return null;
    // Downscale hard: the ribbon is a thin sliver — 160px wide is plenty.
    const small = shot.resize({ width: 160 });
    return small.toDataURL();
  } catch {
    return null;
  }
}

export interface MediaPollHooks {
  /** Deliver a state snapshot to the renderer. */
  send: (state: MediaState) => void;
  /** True while the window is hidden — polling pauses. */
  isHidden: () => boolean;
  /** Currently active tab id (the viewfinder hides for this tab). */
  activeTabId: () => string | null;
}

const EMPTY_MEDIA: MediaState = {
  hasVideo: false,
  paused: false,
  position: 0,
  duration: 0,
  live: false,
  url: '',
};

/**
 * Start the ~1Hz media sweep. Every tick scans live tabs for videos and
 * picks the background media tab: a playing video in a non-active tab
 * first, else a paused video in a non-active tab (most recently playing
 * wins). A video in the ACTIVE tab never surfaces — the curve stays clean
 * while the user watches it directly.
 */
export function startMediaPolling(
  tabs: TabManager,
  hooks: MediaPollHooks
): () => void {
  const lastPlayingAt = new Map<string, number>();
  let lastJson = '';
  let lastActive: string | null | undefined;

  const tick = async () => {
    try {
      if (hooks.isHidden()) {
        if (lastJson !== '') {
          lastJson = '';
          hooks.send(EMPTY_MEDIA);
        }
        return;
      }
      const activeId = hooks.activeTabId();
      if (activeId !== lastActive) {
        // Active tab changed: drop the latch so stale controls vanish.
        lastActive = activeId;
        lastJson = '';
        hooks.send(EMPTY_MEDIA);
      }
      let best: { tabId: string; url: string; s: GuestMedia } | null = null;
      let bestPaused: { tabId: string; url: string; s: GuestMedia } | null = null;
      const seen = new Set<string>();
      const jobs: Promise<void>[] = [];
      tabs.forEachWebContents((tab, wc) => {
        let url = '';
        try {
          url = wc.getURL();
        } catch {
          return;
        }
        if (!/^https?:\/\//i.test(url)) return;
        seen.add(tab.id);
        jobs.push(
          queryTabMedia(wc).then((s) => {
            if (!s.hasVideo) return;
            if (!s.paused) {
              lastPlayingAt.set(tab.id, Date.now());
              if (tab.id !== activeId) {
                const prev = best ? lastPlayingAt.get(best.tabId) ?? 0 : 0;
                if (!best || (lastPlayingAt.get(tab.id) ?? 0) >= prev) {
                  best = { tabId: tab.id, url, s };
                }
              }
            } else if (tab.id !== activeId && !bestPaused) {
              bestPaused = { tabId: tab.id, url, s };
            }
          })
        );
      });
      await Promise.all(jobs);
      // Drop timestamps for closed tabs.
      for (const id of [...lastPlayingAt.keys()]) {
        if (!seen.has(id)) lastPlayingAt.delete(id);
      }
      // NB: `best`/`bestPaused` are assigned inside promise callbacks, which
      // TS excludes from control-flow analysis (they stay narrowed to the
      // `= null` initializer), so read them through .find() instead.
      type Pick = { tabId: string; url: string; s: GuestMedia };
      const pick: Pick | null =
        ([best, bestPaused] as (Pick | null)[]).find((x) => x !== null) ?? null;
      const state: MediaState = pick
        ? {
            hasVideo: true,
            tabId: pick.tabId,
            background: true,
            paused: !!pick.s.paused,
            position: pick.s.currentTime ?? 0,
            duration: pick.s.duration ?? 0,
            live: !!pick.s.live,
            url: pick.url,
          }
        : EMPTY_MEDIA;
      const json = JSON.stringify(state);
      if (json !== lastJson) {
        lastJson = json;
        hooks.send(state);
      }
    } catch {
      // Never break the loop on a transient failure.
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 1000);
  void tick();
  return () => clearInterval(timer);
}
