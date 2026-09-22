/**
 * MediaViewfinder — the sidebar's lower scoop becomes a curved video
 * viewfinder for background media (video playing in a NON-active tab).
 *
 * There is NO card, bubble, or background rect: the viewfinder is ONLY two
 * thin curved lines hugging the sidebar's liquid curve, with the transport
 * buttons seated BETWEEN them at notch height:
 *
 *   (seam) video line (16px, live frames) | play/pause + PiP | timeline line
 *
 * The video plays ONLY in the thin line — never across the whole sidebar.
 * The timeline is a REAL timeline: it tracks the polled currentTime /
 * duration of the actual playing media and drag-to-seek seeks the real
 * video. There is no playhead knob dot anywhere; the line itself is the
 * timeline.
 *
 * Geometry: every frame (while visible) the exact Bézier scoop curve is
 * rebuilt from the live sidebar width (--sbw) and morph (--media-t) with
 * the same getScoopMetrics() the seam builder uses. The video strip and
 * the timeline are constant leftward offsets sampled off that curve, so
 * both edges of both lines follow the scoop exactly.
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
 * Video line: a THIN strip hugging the seam — the video plays only here,
 * never across the whole sidebar. Offsets are measured leftwards from the
 * scoop curve.
 */
const VIDEO_NEAR = 4;
const VIDEO_FAR = 20;
/** Timeline line: a second thin curve further in, carrying real progress. */
const TIMELINE_OFFSET = 44;
/** Transport buttons sit BETWEEN the video line and the timeline. */
const BTN_OFFSET = 30;
/** Curve samples for the video strip polygon and the timeline polyline. */
const LINE_SAMPLES = 56;

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
  /** Always-mounted invisible path: the geometry source for both lines and
      the button row, even when the timeline itself is hidden (live). */
  const geoRef = useRef<SVGPathElement>(null);
  const filmPolyRef = useRef<SVGPolygonElement>(null);
  const filmEdgeRef = useRef<SVGPolygonElement>(null);
  const filmImgRef = useRef<SVGImageElement>(null);
  const btnsRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const dragRatio = useRef(0);
  const dragging = useRef(false);
  const raf = useRef(0);
  const geoRaf = useRef(0);
  const [dragOn, setDragOn] = useState(false);
  const [hoverOn, setHoverOn] = useState(false);
  const [tip, setTip] = useState("");

  // Live miniature preview: ~4fps frames from main, only for our tab.
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
   * derive both lines plus the button row from it, so video line |
   * buttons | timeline can never drift apart or from the sidebar's curve.
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

      const path = geoRef.current;
      path?.setAttribute("d", m.d);
      let total = 0;
      try {
        total = path?.getTotalLength() ?? 0;
      } catch {
        total = 0;
      }
      if (!path || total <= 0) return;

      // Video line: sample the curve; both edges are constant leftward
      // offsets, so the thin strip hugs the curve exactly on both sides.
      const near: string[] = [];
      const far: string[] = [];
      const tl: string[] = [];
      let minY = Infinity;
      let maxY = -Infinity;
      let minX = Infinity;
      for (let i = 0; i <= LINE_SAMPLES; i++) {
        let p: DOMPoint;
        try {
          p = path.getPointAtLength((total * i) / LINE_SAMPLES);
        } catch {
          break;
        }
        near.push(`${(p.x - VIDEO_NEAR).toFixed(1)},${p.y.toFixed(1)}`);
        far.push(`${(p.x - VIDEO_FAR).toFixed(1)},${p.y.toFixed(1)}`);
        tl.push(`${(p.x - TIMELINE_OFFSET).toFixed(1)},${p.y.toFixed(1)}`);
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (p.x - VIDEO_FAR < minX) minX = p.x - VIDEO_FAR;
      }
      far.reverse();
      const pts = [...near, ...far].join(" ");
      filmPolyRef.current?.setAttribute("points", pts);
      filmEdgeRef.current?.setAttribute("points", pts);
      // Fit the live frame into the strip's bounding box (slice-cropped).
      const img = filmImgRef.current;
      if (img && minY < maxY) {
        img.setAttribute("x", minX.toFixed(1));
        img.setAttribute("y", minY.toFixed(1));
        img.setAttribute("width", (VIDEO_FAR - VIDEO_NEAR).toFixed(1));
        img.setAttribute("height", (maxY - minY).toFixed(1));
      }

      // Timeline line: the same curve shifted inward — a polyline through
      // the sampled offset points. Track, progress and hit lane all share
      // this geometry, so seeking maps 1:1 onto the visible line.
      const tlD = "M" + tl.join(" L");
      trackRef.current?.setAttribute("d", tlD);
      progressRef.current?.setAttribute("d", tlD);
      hitRef.current?.setAttribute("d", tlD);

      // Button row: between the video line and the timeline, at notch
      // height. Sample the curve at the notch to sit on local geometry.
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
      if (btnsRef.current) {
        btnsRef.current.style.transform =
          `translate(${(cx - BTN_OFFSET).toFixed(1)}px, ${m.notch.y.toFixed(1)}px) translate(-50%, -50%)`;
      }
      // Paused glyph: centered on the video line at notch height.
      if (pausedRef.current) {
        pausedRef.current.style.transform =
          `translate(${(cx - VIDEO_NEAR - (VIDEO_FAR - VIDEO_NEAR) / 2).toFixed(1)}px, ${m.notch.y.toFixed(1)}px) translate(-50%, -50%)`;
      }
    };
    paint();
    return () => {
      cancelAnimationFrame(geoRaf.current);
      geoRaf.current = 0;
    };
  }, [on]);

  /**
   * Map a pointer position to the nearest point on the timeline curve.
   * The overlay SVG has no viewBox, so user units are CSS pixels.
   *
   * Coarse-to-fine: an 80-sample sweep finds the neighbourhood, then a
   * golden-section search refines the ratio on the continuous curve to
   * ~1e-4 — sub-second precision even on hour-long media.
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

  const toggle = () => {
    void nt()
      .mediaToggle(tabId)
      .catch(() => {});
  };

  const progress =
    duration > 0 ? Math.min(1, Math.max(0, (media?.position ?? 0) / duration)) : 0;
  const showTimeline = on && !live && duration > 0;
  const showTip = on && duration > 0 && (dragOn || hoverOn);

  return (
    <div ref={rootRef} className="nt-media-viewfinder" data-on={on ? "true" : "false"} aria-hidden={!on}>
      <svg className="nt-vf-seam" aria-hidden={!showTimeline}>
        {/* Invisible geometry source: always mounted while on, so both
            lines and the button row track the curve even for live streams. */}
        {on && <path ref={geoRef} className="nt-vf-seam-geo" />}
        {/* Video line FIRST (underneath): the thin curved strip with live
            frames. Renders ONLY when a frame has arrived — no placeholder,
            no card, no bubble. Click toggles play/pause. */}
        {on && thumb && (
          <g onClick={toggle} style={{ cursor: "pointer" }}>
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
        {/* Timeline line ON TOP of the video line: the real, live,
            draggable timeline. No playhead knob dot — the line itself is
            the timeline. */}
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
          </g>
        )}
      </svg>

      {/* Transport: play/pause + PiP, seated BETWEEN the video line and the
          timeline at notch height — inside the curve, never outside or
          below. Positioned per frame by the geometry loop. No card, no
          bubble, no background. */}
      {on && (
        <div ref={btnsRef} className="nt-vf-btns">
          <button
            className="nt-vf-btn"
            title={paused ? "Play" : "Pause"}
            aria-label={paused ? "Play" : "Pause"}
            onClick={toggle}
          >
            {paused ? (
              <Play size={14} strokeWidth={0} fill="currentColor" />
            ) : (
              <Pause size={14} strokeWidth={1.75} />
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
      )}

      {/* Paused indicator: a play glyph on the video line at notch height. */}
      {on && paused && thumb && (
        <div ref={pausedRef} className="nt-vf-paused" aria-hidden="true">
          <Play size={16} strokeWidth={0} fill="currentColor" />
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
