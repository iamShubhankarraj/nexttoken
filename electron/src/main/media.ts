/**
 * Media controller — drives the active tab's best video element.
 *
 * Used by the sidebar media notch (`nt.media.*` IPC), the PiP engine, and
 * the agent's picture_in_picture / media_toggle tools. All page interaction
 * goes through one shared "best video" snippet so the heuristic (playing
 * first, then largest) is identical everywhere.
 */
import type { TabManager } from './tabs';
import type { MediaState } from '../shared/ipc';

/** JS evaluated in the guest: the best video element (or null). */
const BEST_VIDEO_JS = `(() => {
  const vids = [...document.querySelectorAll('video')]
    .filter(v => v.readyState >= 2 && !v.disablePictureInPicture);
  if (!vids.length) return null;
  const playing = vids.find(v => !v.paused && !v.ended);
  const scored = (playing ? [playing] : vids).concat(vids.filter(v => v !== playing));
  scored.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
  return scored[0];
})()`;

/** Guard an executeJavaScript so a wedged page can't stall the poll loop. */
async function evalGuest<T>(
  tabs: TabManager,
  js: string,
  timeoutMs = 1500
): Promise<T | null> {
  const wc = tabs.activeWebContents();
  if (!wc || wc.isDestroyed()) return null;
  try {
    const r = await Promise.race([
      wc.executeJavaScript(js),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return r as T | null;
  } catch {
    return null;
  }
}

/**
 * Put the active tab's best video into Picture-in-Picture. Picks the
 * currently-playing video first, then the largest visible one. Runs inside
 * the page, so site players (YouTube, etc.) keep working. Calling again
 * while a PiP window is open exits it.
 */
export async function enterPictureInPicture(
  tabs: TabManager
): Promise<{ ok: boolean; error?: string }> {
  const res = await evalGuest<string>(
    tabs,
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
    })()`
  );
  if (res === 'ok' || res === 'toggled-off') return { ok: true };
  if (res === 'none') return { ok: false, error: 'No playable video found on this page.' };
  if (res === null) return { ok: false, error: 'No active tab.' };
  return {
    ok: false,
    error: res.startsWith('err:') ? res.slice(4) : 'Picture in Picture failed.',
  };
}

/** Read the active tab's media state (the notch polls this ~1Hz). */
export async function queryMediaState(tabs: TabManager): Promise<MediaState> {
  const s = await evalGuest<{
    hasVideo: boolean;
    title?: string;
    currentTime?: number;
    duration?: number;
    live?: boolean;
    paused?: boolean;
  }>(
    tabs,
    `(v => v ? {
      hasVideo: true,
      title: String(document.title || '').slice(0, 120),
      currentTime: v.currentTime || 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      live: !Number.isFinite(v.duration),
      paused: !!v.paused,
    } : { hasVideo: false })(${BEST_VIDEO_JS})`
  );
  if (!s || !s.hasVideo) return { hasVideo: false };
  return {
    hasVideo: true,
    title: s.title ?? '',
    currentTime: s.currentTime ?? 0,
    duration: s.duration ?? 0,
    live: !!s.live,
    paused: !!s.paused,
  };
}

/** Seek the active tab's video to `ratio` (0..1) of its duration. */
export async function seekMedia(tabs: TabManager, ratio: number): Promise<void> {
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  await evalGuest(
    tabs,
    `(() => {
      const v = ${BEST_VIDEO_JS};
      if (v && Number.isFinite(v.duration) && v.duration > 0) {
        v.currentTime = v.duration * ${r};
      }
    })()`
  );
}

/** Toggle play/pause on the active tab's video. */
export async function toggleMedia(
  tabs: TabManager
): Promise<{ paused: boolean }> {
  const paused = await evalGuest<boolean>(
    tabs,
    `(() => {
      const v = ${BEST_VIDEO_JS};
      if (!v) return null;
      if (v.paused) { v.play().catch(() => {}); return false; }
      v.pause();
      return true;
    })()`
  );
  return { paused: paused !== false };
}

export interface MediaPollHooks {
  /** Deliver a state snapshot to the renderer. */
  send: (state: MediaState) => void;
  /** True while the window is hidden — polling pauses. */
  isHidden: () => boolean;
  /** Key that changes when the active tab changes (resets the latch). */
  activeTabKey: () => string | null;
}

/**
 * Start the ~1Hz media poll. Each tick is cheap: it no-ops unless the
 * active tab's URL looks video-plausible (http/https) or the previous tick
 * found a video. An active-tab change immediately resets to {hasVideo:false}
 * so the notch never shows stale controls.
 */
export function startMediaPolling(
  tabs: TabManager,
  hooks: MediaPollHooks
): () => void {
  let lastKey: string | null | undefined;
  let lastHad = false;
  let lastJson = '';
  const tick = async () => {
    try {
      if (hooks.isHidden()) {
        if (lastHad) {
          lastHad = false;
          lastJson = '';
          hooks.send({ hasVideo: false });
        }
        return;
      }
      const key = hooks.activeTabKey();
      if (key !== lastKey) {
        // Active tab changed: drop the latch so stale controls vanish.
        lastKey = key;
        lastHad = false;
        lastJson = '';
        hooks.send({ hasVideo: false });
      }
      const wc = tabs.activeWebContents();
      const url = wc && !wc.isDestroyed() ? wc.getURL() : '';
      const plausible = /^https?:\/\//i.test(url);
      if (!plausible && !lastHad) return;
      const s = await queryMediaState(tabs);
      const json = JSON.stringify(s);
      if (json !== lastJson) {
        lastJson = json;
        lastHad = !!s.hasVideo;
        hooks.send(s);
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
