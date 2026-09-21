/**
 * MediaViewfinder — the sidebar's lower scoop becomes a curved video
 * viewfinder for background media (video playing in a NON-active tab).
 *
 * The progress line is the scoop's curve itself: an SVG path sampling the
 * EXACT Bézier geometry of the liquid seam's right edge (published per
 * frame by the liquid engine as --scoop-d), so the timeline bends with the
 * sidebar — never a straight vertical segment. The played portion glows
 * ember #E8A33D; the track is a thin translucent line hugging the edge.
 *
 * Drag-to-seek works on the curve (nearest-point hit testing), with a
 * current/total tooltip at the pointer. A live miniature preview
 * (~2.5fps frames captured in main via webContents.capturePage) sits
 * inside the curve, and play/pause + PiP controls are seated at its base.
 *
 * Appears ONLY when the user is not on the media tab (media.background).
 * Fades with the sidebar's spring language via data-on.
 *
 * State arrives ~1Hz from main; the progress arc glides between polls
 * with a 1s linear transition (no React rerender per frame). Dragging
 * writes the arc directly through refs on a rAF throttle.
 */
import { useEffect, useRef, useState } from "react";
import { Pause, PictureInPicture2, Play } from "lucide-react";
import type { MediaState } from "../../shared/ipc";
import { nt } from "../nt";

/** Subscribe to the ~1Hz background-media state pushed from main. */
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

/** pathLength normalisation: progress is 0..100 along the curve. */
const ARC_UNITS = 100;

export function MediaViewfinder({ media }: { media: MediaState | null }) {
  // Only for background media — never while the media tab is active.
  const on = !!media?.hasVideo && !!media?.background;
  const live = !!media?.live;
  const duration = media?.duration && media.duration > 0 ? media.duration : 0;
  const paused = !!media?.paused;
  const tabId = media?.tabId;

  const progressRef = useRef<SVGPathElement>(null);
  const hitRef = useRef<SVGPathElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const dragRatio = useRef(0);
  const dragging = useRef(false);
  const raf = useRef(0);
  const [dragOn, setDragOn] = useState(false);
  const [hoverOn, setHoverOn] = useState(false);
  const [tip, setTip] = useState("");

  // Live miniature preview: ~2.5fps frames from main, only for our tab.
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = nt().onMediaThumb((t) => {
        if (t.tabId === tabId) setThumb(t.dataUrl);
      });
    } catch {
      /* bridge unavailable */
    }
    return () => off?.();
  }, [tabId]);
  useEffect(() => {
    if (!on) setThumb(null);
  }, [on]);

  // Keep the tooltip in sync with the polled position when idle.
  useEffect(() => {
    if (dragging.current || !on || !duration) return;
    setTip(`${formatTime(media?.position ?? 0)} / ${formatTime(duration)}`);
  }, [media?.position, duration, on]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  /**
   * Map a pointer position to the nearest point on the scoop curve.
   * The overlay SVG has no viewBox, so user units are CSS pixels.
   */
  const curveHit = (
    clientX: number,
    clientY: number
  ): { ratio: number; x: number; y: number } | null => {
    const path = hitRef.current;
    const svg = path?.ownerSVGElement;
    if (!path || !svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let total = 0;
    try {
      total = path.getTotalLength();
    } catch {
      return null;
    }
    if (!total) return null;
    const N = 80;
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i <= N; i++) {
      let p: DOMPoint;
      try {
        p = path.getPointAtLength((total * i) / N);
      } catch {
        return null;
      }
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    let pt: DOMPoint;
    try {
      pt = path.getPointAtLength((total * bi) / N);
    } catch {
      return null;
    }
    return { ratio: bi / N, x: pt.x, y: pt.y };
  };

  const moveTip = (x: number, y: number) => {
    const el = tipRef.current;
    if (!el) return;
    el.style.left = `${x.toFixed(1)}px`;
    el.style.top = `${(y - 12).toFixed(1)}px`;
  };

  const paintDrag = () => {
    raf.current = 0;
    const ratio = dragRatio.current;
    if (progressRef.current) {
      progressRef.current.style.strokeDashoffset = String(ARC_UNITS * (1 - ratio));
    }
    if (duration) setTip(`${formatTime(ratio * duration)} / ${formatTime(duration)}`);
  };

  const queuePaintDrag = (clientX: number, clientY: number) => {
    const hit = curveHit(clientX, clientY);
    if (!hit) return;
    dragRatio.current = hit.ratio;
    moveTip(hit.x, hit.y);
    if (!raf.current) raf.current = requestAnimationFrame(paintDrag);
  };

  const beginDrag = (e: React.PointerEvent) => {
    if (!duration) return;
    dragging.current = true;
    setDragOn(true);
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* noop */
    }
    queuePaintDrag(e.clientX, e.clientY);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (dragging.current) {
      queuePaintDrag(e.clientX, e.clientY);
    } else if (hoverOn && duration) {
      // Hover scrub preview: tooltip follows the curve without seeking.
      const hit = curveHit(e.clientX, e.clientY);
      if (hit) {
        moveTip(hit.x, hit.y);
        setTip(`${formatTime(hit.ratio * duration)} / ${formatTime(duration)}`);
      }
    }
  };
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setDragOn(false);
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const ratio = dragRatio.current;
    // Restore the poll-driven arc; the next ~1Hz tick confirms the seek.
    if (progressRef.current) progressRef.current.style.strokeDashoffset = "";
    void nt()
      .mediaSeek(ratio, tabId)
      .catch(() => {});
  };

  const progress =
    duration > 0 ? Math.min(1, Math.max(0, (media?.position ?? 0) / duration)) : 0;
  const showTimeline = on && !live && duration > 0;
  const showTip = on && duration > 0 && (dragOn || hoverOn);

  return (
    <div className="nt-media-viewfinder" data-on={on ? "true" : "false"} aria-hidden={!on}>
      {/* Seam-hugging progress: the scoop's exact curve, published per
          frame by the liquid engine as --scoop-d. */}
      <svg className="nt-vf-seam" aria-hidden={!showTimeline}>
        {showTimeline && (
          <g
            role="slider"
            aria-label="Video timeline"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(media?.position ?? 0)}
            aria-valuetext={tip}
          >
            <path pathLength={ARC_UNITS} className="nt-vf-seam-track" />
            <path
              ref={progressRef}
             
              pathLength={ARC_UNITS}
              className="nt-vf-seam-progress"
              strokeDasharray={ARC_UNITS}
              strokeDashoffset={ARC_UNITS * (1 - progress)}
              data-drag={dragOn ? "true" : "false"}
            />
            {/* Wide invisible hit lane for drag-seek along the curve. */}
            <path
              ref={hitRef}
             
              className="nt-vf-seam-hit"
              onPointerDown={beginDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerEnter={() => setHoverOn(true)}
              onPointerLeave={() => setHoverOn(false)}
            />
          </g>
        )}
      </svg>

      {/* Live miniature preview + transport, seated inside the curve. */}
      <div className="nt-vf-cluster">
        <svg className="nt-vf-thumb-svg" width="96" height="128" viewBox="0 0 96 128">
          <defs>
            <clipPath id="nt-vf-clip">
              <rect x="12" y="16" width="72" height="96" rx="12" />
            </clipPath>
          </defs>
          {thumb ? (
            <g clipPath="url(#nt-vf-clip)">
              <image
                href={thumb}
                x="12"
                y="16"
                width="72"
                height="96"
                preserveAspectRatio="xMidYMid slice"
              />
              <rect x="12" y="16" width="72" height="96" rx="12" className="nt-vf-frame-edge" />
            </g>
          ) : (
            <rect x="12" y="16" width="72" height="96" rx="12" className="nt-vf-empty" />
          )}
          {on && live && (
            <g>
              <circle cx="26" cy="28" r="4" className="nt-vf-live-dot" />
              <text x="34" y="32" className="nt-vf-live-text">LIVE</text>
            </g>
          )}
        </svg>
        <div className="nt-vf-controls">
          <button
            className="nt-vf-btn nt-vf-play"
            title={paused ? "Play" : "Pause"}
            aria-label={paused ? "Play video" : "Pause video"}
            onClick={() => void nt().mediaToggle(tabId).catch(() => {})}
          >
            {paused ? (
              <Play size={13} strokeWidth={0} fill="currentColor" />
            ) : (
              <Pause size={13} strokeWidth={0} fill="currentColor" />
            )}
          </button>
          <button
            className="nt-vf-btn"
            title="Picture in Picture"
            aria-label="Picture in Picture"
            onClick={() => void nt().tabsPip(tabId).catch(() => {})}
          >
            <PictureInPicture2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* Seek tooltip riding the curve. */}
      {showTip && (
        <div ref={tipRef} className="nt-vf-tip" role="status">
          {tip || `${formatTime(media?.position ?? 0)} / ${formatTime(duration)}`}
        </div>
      )}
    </div>
  );
}
