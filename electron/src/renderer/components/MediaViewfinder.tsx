/**
 * MediaViewfinder — the sidebar's lower scoop becomes a curved video
 * viewfinder for background media (video playing in a NON-active tab).
 *
 * There is NO card, bubble, or background rect: the viewfinder is ONLY
 *   timeline bar | control buttons | thumbnail film
 * laid out across the sidebar's liquid curve.
 *
 * The timeline IS the scoop's curve: every frame (while visible) the exact
 * Bézier geometry is rebuilt from the live sidebar width (--sbw) and morph
 * (--media-t) with the same getScoopMetrics() the seam builder uses, and
 * written straight onto the paths' `d` attributes. No CSS-var indirection,
 * so the played ember line (#E8A33D) can never render as a straight segment.
 *
 * Layout (right to left, from the seam inward — all inside the curve):
 *   timeline (on the curve) | play/pause + PiP buttons | thin curved
 *   thumbnail film (a 36px film strip whose BOTH edges follow the curve).
 * The film shows live ~2.5fps capturePage frames; it renders nothing at all
 * until a frame arrives (no placeholder rect, ever).
 *
 * Drag-to-seek works on the curve (nearest-point hit testing), with a
 * current/total tooltip at the pointer.
 *
 * Appears ONLY when the user is not on the media tab (media.background).
 */
import { useEffect, useRef, useState } from "react";
import { Pause, PictureInPicture2, Play } from "lucide-react";
import type { MediaState } from "../../shared/ipc";
import { getScoopMetrics } from "../hooks/useLiquidSidebar";
import { nt } from "../nt";

/** Subscribe to the ~1Hz background-media state pushed from main. */
export function useMediaState(): MediaState | null {
  const [state, setState] = useState<MediaState | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = nt().onMediaState(setState);
    } catch (e) {
      // Never swallow this: a dead subscription makes the whole viewfinder
      // vanish with zero evidence. (preload bridge unavailable in tests.)
      console.warn("[viewfinder] onMediaState subscription failed:", e);
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
/**
 * Video band: the COMPLETE curve filled with live video — a wide band from
 * just inside the seam to deep in the sidebar. Offsets are measured
 * leftwards from the curve. The video IS the viewfinder now, not a thin
 * strip beside buttons.
 */
const FILM_NEAR = 10;
const FILM_FAR = 132;
/** PiP button: floats over the video band's inner edge at notch height. */
const BTN_OFFSET = 118;
/** Curve samples for the video band polygon. */
const FILM_SAMPLES = 64;

export function MediaViewfinder({ media }: { media: MediaState | null }) {
  // Only for background media — never while the media tab is active.
  const on = !!media?.hasVideo && !!media?.background;
  const live = !!media?.live;
  const duration = media?.duration && media.duration > 0 ? media.duration : 0;
  const paused = !!media?.paused;
  const tabId = media?.tabId;

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<SVGPathElement>(null);
  const progressRef = useRef<SVGPathElement>(null);
  const hitRef = useRef<SVGPathElement>(null);
  /** Visible playhead knob riding the curve — the drag handle you can see. */
  const knobRef = useRef<SVGCircleElement>(null);
  /** Mirror of the poll-driven progress ratio, readable from the rAF loop. */
  const progRatioRef = useRef(0);  /** Always-mounted invisible path: the geometry source for the film strip
      and button row, even when the timeline itself is hidden (live). */
  const geoRef = useRef<SVGPathElement>(null);
  const filmPolyRef = useRef<SVGPolygonElement>(null);
  const filmEdgeRef = useRef<SVGPolygonElement>(null);
  const filmImgRef = useRef<SVGImageElement>(null);
  const btnsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const dragRatio = useRef(0);
  const dragging = useRef(false);
  const raf = useRef(0);
  const geoRaf = useRef(0);
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

  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    cancelAnimationFrame(geoRaf.current);
  }, []);

  /**
   * Geometry loop: rebuild the EXACT scoop curve every frame from the live
   * sidebar width and morph (same function, same params the seam uses) and
   * write it directly onto the paths. The film strip polygon and the button
   * row are derived from the same metrics, so timeline | buttons | film can
   * never drift apart or from the sidebar's curve.
   */
  useEffect(() => {
    if (!on) {
      cancelAnimationFrame(geoRaf.current);
      geoRaf.current = 0;
      return;
    }
    const root = rootRef.current;
    const aside = root?.closest("aside.nt-liquid-sidebar") as HTMLElement | null;
    if (!root || !aside) return;

    const paint = () => {
      geoRaf.current = requestAnimationFrame(paint);
      let w = 0;
      let mt = 1;
      try {
        const cs = getComputedStyle(aside);
        w = parseFloat(cs.getPropertyValue("--sbw")) || 0;
        const m = parseFloat(cs.getPropertyValue("--media-t"));
        if (Number.isFinite(m)) mt = Math.min(1, Math.max(0, m));
      } catch {
        /* fall through to fallbacks */
      }
      if (!w) w = aside.clientWidth || 180;
      const h = aside.clientHeight || 600;
      const m = getScoopMetrics(w, h, mt);

      const d = m.d;
      geoRef.current?.setAttribute("d", d);
      trackRef.current?.setAttribute("d", d);
      progressRef.current?.setAttribute("d", d);
      hitRef.current?.setAttribute("d", d);

      // Film strip: sample the curve; both edges are constant leftward
      // offsets, so the strip hugs the curve exactly — curved on both sides.
      // Sampled from the always-mounted geometry path (the timeline paths
      // unmount for live streams).
      const path = geoRef.current;
      let total = 0;
      try {
        total = path?.getTotalLength() ?? 0;
      } catch {
        total = 0;
      }
      if (total > 0 && filmPolyRef.current) {
        const near: string[] = [];
        const far: string[] = [];
        let minY = Infinity;
        let maxY = -Infinity;
        let minX = Infinity;
        for (let i = 0; i <= FILM_SAMPLES; i++) {
          let p: DOMPoint;
          try {
            p = path!.getPointAtLength((total * i) / FILM_SAMPLES);
          } catch {
            break;
          }
          near.push(`${(p.x - FILM_NEAR).toFixed(1)},${p.y.toFixed(1)}`);
          far.push(`${(p.x - FILM_FAR).toFixed(1)},${p.y.toFixed(1)}`);
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
          if (p.x - FILM_FAR < minX) minX = p.x - FILM_FAR;
        }
        far.reverse();
        const pts = [...near, ...far].join(" ");
        filmPolyRef.current.setAttribute("points", pts);
        filmEdgeRef.current?.setAttribute("points", pts);
        // Fit the live frame into the strip's bounding box (slice-cropped).
        const img = filmImgRef.current;
        if (img && minY < maxY) {
          img.setAttribute("x", minX.toFixed(1));
          img.setAttribute("y", minY.toFixed(1));
          img.setAttribute("width", (FILM_FAR - FILM_NEAR).toFixed(1));
          img.setAttribute("height", (maxY - minY).toFixed(1));
        }
      }

      // Button row: between the timeline and the film, at notch height.
      // Sample the curve at the notch to sit exactly on the local geometry.
      if (btnsRef.current && total > 0 && path) {
        let cx = m.notch.x + m.d2 * 0.48;
        try {
          // Binary search the curve for the point nearest the notch height.
          let lo = 0;
          let hi = total;
          for (let k = 0; k < 24; k++) {
            const mid = (lo + hi) / 2;
            const p = path.getPointAtLength(mid);
            if (p.y < m.notch.y) lo = mid;
            else hi = mid;
          }
          cx = path.getPointAtLength((lo + hi) / 2).x;
        } catch {
          /* keep the estimate */
        }
        btnsRef.current.style.transform =
          `translate(${(cx - BTN_OFFSET).toFixed(1)}px, ${m.notch.y.toFixed(1)}px) translate(-50%, -50%)`;
      }

      // Playhead knob: rides the curve at the live progress ratio (or the
      // drag ratio mid-seek). The CSS transition on cx/cy matches the
      // progress line's 1s linear sweep so they never separate.
      const knob = knobRef.current;
      if (knob && total > 0 && path) {
        const kr = dragging.current ? dragRatio.current : progRatioRef.current;
        try {
          const kp = path.getPointAtLength(Math.min(1, Math.max(0, kr)) * total);
          knob.setAttribute("cx", kp.x.toFixed(1));
          knob.setAttribute("cy", kp.y.toFixed(1));
        } catch {
          /* path mid-rebuild — skip a frame */
        }
      }
    };
    paint();
    return () => {
      cancelAnimationFrame(geoRaf.current);
      geoRaf.current = 0;
    };
  }, [on]);

  /**
   * Map a pointer position to the nearest point on the scoop curve.
   * The overlay SVG has no viewBox, so user units are CSS pixels.
   *
   * Coarse-to-fine: an 80-sample sweep finds the neighbourhood, then a
   * golden-section search refines the ratio on the continuous curve to
   * ~1e-4 — sub-second precision even on hour-long media. (The old
   * sample-only version quantized to 1/80 of the timeline, ~9s steps on
   * an 11-minute video, which made precise seeking impossible.)
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
    const ptAt = (r: number): DOMPoint | null => {
      try {
        return path.getPointAtLength(Math.min(1, Math.max(0, r)) * total);
      } catch {
        return null;
      }
    };
    const dist2 = (r: number): number => {
      const p = ptAt(r);
      if (!p) return Infinity;
      const dx = p.x - x;
      const dy = p.y - y;
      return dx * dx + dy * dy;
    };
    // Coarse sweep.
    const N = 80;
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i <= N; i++) {
      const d = dist2(i / N);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    // Golden-section refinement between the neighbouring samples.
    let lo = Math.max(0, (bi - 1) / N);
    let hi = Math.min(1, (bi + 1) / N);
    const gr = (Math.sqrt(5) - 1) / 2;
    let c = hi - gr * (hi - lo);
    let d = lo + gr * (hi - lo);
    for (let k = 0; k < 32; k++) {
      if (dist2(c) < dist2(d)) hi = d;
      else lo = c;
      c = hi - gr * (hi - lo);
      d = lo + gr * (hi - lo);
    }
    const ratio = (lo + hi) / 2;
    const pt = ptAt(ratio);
    if (!pt) return null;
    return { ratio, x: pt.x, y: pt.y };
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
  // Mirror for the rAF geometry loop (it can't read render-scope locals).
  useEffect(() => {
    progRatioRef.current = progress;
  }, [progress]);
  const showTimeline = on && !live && duration > 0;
  const showTip = on && duration > 0 && (dragOn || hoverOn);

  return (
    <div ref={rootRef} className="nt-media-viewfinder" data-on={on ? "true" : "false"} aria-hidden={!on}>
      {/* Seam timeline: the scoop's exact curve, written per frame by the
          geometry loop above — the played portion glows ember. */}
      <svg className="nt-vf-seam" aria-hidden={!showTimeline}>
        {/* Invisible geometry source: always mounted while on, so the film
            strip and button row track the curve even for live streams. */}
        {on && <path ref={geoRef} className="nt-vf-seam-geo" />}
        {showTimeline && (
          <g
            role="slider"
            aria-label="Video timeline"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(media?.position ?? 0)}
            aria-valuetext={tip}
          >
            <path ref={trackRef} pathLength={ARC_UNITS} className="nt-vf-seam-track" />
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
            {/* Playhead knob: the visible drag handle. Always shown while
                the timeline is up; grows on hover/drag to invite grabbing. */}
            <circle
              ref={knobRef}
              className="nt-vf-knob"
              r={5.5}
              cx={-50}
              cy={-50}
              data-hot={dragOn || hoverOn ? "true" : "false"}
              data-drag={dragOn ? "true" : "false"}
            />
          </g>
        )}
        {/* Video band: the complete curve filled with live ~8fps video.
            Renders ONLY when a live frame has arrived — no placeholder, no
            card, no bubble. Click toggles play/pause. */}
        {on && thumb && (
          <g
            onClick={() => void nt().mediaToggle(tabId).catch(() => {})}
            style={{ cursor: "pointer" }}
          >
            <defs>
              <clipPath id="nt-vf-film-clip">
                <polygon ref={filmPolyRef} points="" />
              </clipPath>
            </defs>
            <g clipPath="url(#nt-vf-film-clip)">
              <image
                ref={filmImgRef}
                href={thumb}
                preserveAspectRatio="xMidYMid slice"
              />
            </g>
            <polygon ref={filmEdgeRef} points="" className="nt-vf-film-edge" />
          </g>
        )}
      </svg>

      {/* PiP: a single small button floating over the video band's inner
          edge — the video itself is the play/pause control (click it). */}
      {on && (
        <div ref={btnsRef} className="nt-vf-btns">
          <button
            className="nt-vf-btn"
            title="Picture in Picture"
            aria-label="Picture in Picture"
            onClick={() => void nt().tabsPip(tabId).catch(() => {})}
          >
            <PictureInPicture2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      )}

      {/* Paused indicator: a play glyph centered on the video band. */}
      {on && paused && thumb && (
        <div className="nt-vf-paused">
          <Play size={20} strokeWidth={0} fill="currentColor" />
        </div>
      )}

      {/* Seek tooltip riding the curve. */}
      {showTip && (
        <div ref={tipRef} className="nt-vf-tip" role="status">
          {tip || `${formatTime(media?.position ?? 0)} / ${formatTime(duration)}`}
        </div>
      )}
    </div>
  );
}
