/**
 * MediaNotch — the sidebar's video control cluster, cradled in the liquid
 * seam's lower scoop while the active tab has a playable video.
 *
 * - Thin vertical YouTube-style timeline (red fill), draggable to seek,
 *   with a current/total tooltip while dragging.
 * - Play/pause toggle and a PiP button (existing nt.tabs.pip engine).
 * - Live streams (unknown duration): timeline hides, transport stays.
 * - Positioned by the liquid engine via --media-x / --media-y so the
 *   cluster rides the seam as the sidebar breathes; fades/scales with the
 *   sidebar's spring language via data-on.
 *
 * State arrives ~1Hz from main; the timeline fill glides between polls
 * with a 1s linear transition (no React rerender per frame). Dragging
 * writes the fill directly through refs on a rAF throttle.
 */
import { useEffect, useRef, useState } from "react";
import { Pause, PictureInPicture2, Play } from "lucide-react";
import type { MediaState } from "../../shared/ipc";
import { nt } from "../nt";

/** Subscribe to the ~1Hz media state pushed from main. */
export function useMediaState(): MediaState | null {
  const [state, setState] = useState<MediaState | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = nt().onMediaState(setState);
    } catch {
      /* preload bridge unavailable (tests) */
    }
    return () => off?.();
  }, []);
  return state;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}

export function MediaNotch({ media }: { media: MediaState | null }) {
  const on = !!media?.hasVideo;
  const live = !!media?.live;
  const duration = media?.duration && media.duration > 0 ? media.duration : 0;
  const paused = !!media?.paused;

  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const dragRatio = useRef(0);
  const dragging = useRef(false);
  const raf = useRef(0);
  const [dragOn, setDragOn] = useState(false);
  const [tip, setTip] = useState("");

  // Keep the tooltip text in sync with the polled position when idle.
  useEffect(() => {
    if (dragging.current || !on || !duration) return;
    setTip(`${formatTime(media?.currentTime ?? 0)} / ${formatTime(duration)}`);
  }, [media?.currentTime, duration, on]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const ratioFromClientY = (clientY: number): number => {
    const el = trackRef.current;
    if (!el || !duration) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
  };

  const paintDrag = () => {
    raf.current = 0;
    const ratio = dragRatio.current;
    if (fillRef.current) {
      fillRef.current.style.height = `${(ratio * 100).toFixed(2)}%`;
    }
    if (duration) setTip(`${formatTime(ratio * duration)} / ${formatTime(duration)}`);
  };

  const queuePaintDrag = (ratio: number) => {
    dragRatio.current = ratio;
    if (!raf.current) raf.current = requestAnimationFrame(paintDrag);
  };

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    dragging.current = true;
    setDragOn(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    queuePaintDrag(ratioFromClientY(e.clientY));
  };

  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    queuePaintDrag(ratioFromClientY(e.clientY));
  };

  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setDragOn(false);
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const ratio = dragRatio.current;
    // Restore the poll-driven fill; the next ~1Hz tick confirms the seek.
    if (fillRef.current) fillRef.current.style.height = "";
    void nt()
      .mediaSeek(ratio)
      .catch(() => {});
  };

  const progress = duration > 0 ? Math.min(1, Math.max(0, (media?.currentTime ?? 0) / duration)) : 0;
  const showTimeline = on && !live && duration > 0;

  // The pill stays mounted and only data-on flips, so the fade/scale
  // transition animates both in and out.
  return (
    <div
      className="nt-media-notch"
      data-on={on ? "true" : "false"}
      aria-hidden={!on}
      style={{ left: "var(--media-x, 190px)", top: "var(--media-y, 50%)" }}
      title={media?.title || "Video controls"}
    >
      <div className="nt-media-pill">
        {showTimeline ? (
          <div
            ref={trackRef}
            className="nt-media-track"
            data-drag={dragOn ? "true" : "false"}
            role="slider"
            aria-label="Video timeline"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(media?.currentTime ?? 0)}
            aria-valuetext={tip}
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div
              ref={fillRef}
              className="nt-media-fill"
              style={{ height: `${(progress * 100).toFixed(2)}%` }}
            />
            <span className="nt-media-tip">
              {tip || `${formatTime(media?.currentTime ?? 0)} / ${formatTime(duration)}`}
            </span>
          </div>
        ) : (
          <span className="nt-media-live" title="Live stream">
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "#ff6b5e",
                display: "inline-block",
              }}
            />
            LIVE
          </span>
        )}
        <button
          className="nt-media-btn"
          title={paused ? "Play" : "Pause"}
          aria-label={paused ? "Play video" : "Pause video"}
          onClick={() => void nt().mediaToggle().catch(() => {})}
        >
          {paused ? (
            <Play size={14} strokeWidth={0} fill="currentColor" />
          ) : (
            <Pause size={14} strokeWidth={0} fill="currentColor" />
          )}
        </button>
        <button
          className="nt-media-btn"
          title="Picture in Picture"
          aria-label="Picture in Picture"
          onClick={() => void nt().tabsPip().catch(() => {})}
        >
          <PictureInPicture2 size={15} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
