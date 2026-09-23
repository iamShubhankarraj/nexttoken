/**
 * MediaViewfinder — the sidebar's lower scoop becomes a curved video
 * viewfinder for the media that is actually playing (in this tab or in a
 * background one).
 *
 * There is NO card, bubble, or background rect: the viewfinder is ONLY two
 * thin curved lines hugging the sidebar's liquid curve, with the transport
 * buttons seated BETWEEN them at notch height:
 *
 *   (seam) film line (live frames) | play/pause + PiP | timeline line
 *
 * The video plays ONLY in the thin line — never across the whole sidebar.
 * The timeline is a REAL timeline: it tracks the actual playing media and
 * drag-to-seek seeks the real video. There is no playhead knob dot
 * anywhere; the line itself is the timeline.
 *
 * The film line renders ONLY while real frames are arriving, so a media tab
 * that yields no frames (a background `display: none` webview does not
 * paint, so capturePage comes back empty) shows the timeline and transport
 * with no film. No media at all — the whole viewfinder stays hidden.
 *
 * Geometry: every frame (while visible) the exact Bézier scoop curve is
 * rebuilt from the live sidebar width (--sbw) and morph (--media-t) with
 * the same getScoopMetrics() the seam builder uses. The film strip and
 * the timeline are constant leftward offsets sampled off that curve, so
 * both edges of both lines follow the scoop exactly.
 *
 * TIMING: main polls playback state at only ~1Hz, which is far too coarse to
 * render — and far too coarse to drag — a timeline. So the line is driven by
 * a LOCAL rAF clock that extrapolates from the last polled position
 * (position + elapsed while playing, frozen while paused). A drag writes its
 * ratio straight into that clock, so the line tracks the pointer 1:1 with no
 * transition, and releasing never snaps back to the stale polled position.
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
 * Film line: a THIN strip hugging the seam — the media plays only here,
 * never across the whole sidebar. Offsets are measured leftwards from the
 * scoop curve. 24px wide: at 16px the strip was a sliver too thin to read
 * as video at all.
 */
const VIDEO_NEAR = 4;
const VIDEO_FAR = 28;
/** Timeline line: a second thin curve further in, carrying real progress. */
const TIMELINE_OFFSET = 44;
/** Transport buttons sit BETWEEN the film line and the timeline. */
const BTN_OFFSET = 32;
/** How long to trust a drag's optimistic ratio over a stale poll (ms). */
const SEEK_GRACE_MS = 1500;
/** Curve samples for the video strip polygon and the timeline polyline. */
const LINE_SAMPLES = 56;

export function MediaViewfinder({ media }: { media: MediaState | null }) {
  // Any media at all turns the viewfinder on; the film line additionally
  // needs frames, so it simply stays hidden when none arrive.
  const on = !!media?.hasVideo;
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
  const filmSheenRef = useRef<SVGPolygonElement>(null);
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

  /**
   * Local playback clock. The ~1Hz poll is far too coarse to render or drag
   * a timeline from, so the line is extrapolated from the last polled
   * position between polls (see the file header). During a drag the ratio is
   * written here directly, and `pendingSeek` keeps the next stale poll from
   * yanking the line back to where it was before the seek.
   */
  const clock = useRef({ pos: 0, at: 0, paused: false });
  const pendingSeek = useRef<{ ratio: number; at: number } | null>(null);

  //
  // Entrance effect. `media.background` flips true the moment the user leaves
  // the tab that is playing: the media is still running, but now the ONLY
  // place it is visible is this curve. That hand-off deserves a beat of
  // feedback, so the transport blurs in and the timeline gives one ember
  // pulse — a deliberate "it's still playing, right here".
  //
  // The class is added and removed on a timer rather than keyed off a render,
  // so each hand-off re-fires the animation.
  //
  const backgroundOn = !!media?.background;
  const [enterFx, setEnterFx] = useState(false);
  useEffect(() => {
    if (!on || !backgroundOn) {
      setEnterFx(false);
      return;
    }
    setEnterFx(true);
    const t = setTimeout(() => setEnterFx(false), 700);
    return () => clearTimeout(t);
  }, [on, backgroundOn]);

  // A different media tab: any in-flight seek belongs to the old one.
  useEffect(() => {
    pendingSeek.current = null;
  }, [tabId]);

  // Re-arm the clock whenever fresh playback state arrives.
  useEffect(() => {
    const now = performance.now();
    const pos = media?.position ?? 0;
    const pend = pendingSeek.current;
    if (pend && duration > 0) {
      // Ignore polls that still predate our seek, or the line snaps back.
      if (Math.abs(pos / duration - pend.ratio) > 0.02 && now - pend.at < SEEK_GRACE_MS) {
        return;
      }
      pendingSeek.current = null;
    }
    clock.current.pos = pos;
    clock.current.at = now;
    clock.current.paused = !!media?.paused;
  }, [media?.position, media?.paused, duration]);

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

    const paint = (nowArg?: number) => {
      geoRaf.current = requestAnimationFrame(paint);
      const now = nowArg ?? performance.now();
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
      let maxX = -Infinity;
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
        if (p.x - VIDEO_NEAR > maxX) maxX = p.x - VIDEO_NEAR;
      }
      far.reverse();
      const pts = [...near, ...far].join(" ");
      filmPolyRef.current?.setAttribute("points", pts);
      filmEdgeRef.current?.setAttribute("points", pts);
      filmSheenRef.current?.setAttribute("points", pts);
      // Fit the live frame to the strip's ACTUAL bounding box.
      //
      // The box is the full swept range of the curve, not the nominal strip
      // width: the scoop bends as the sidebar breathes, so the band spans
      // minX..maxX. Sizing the image to (VIDEO_FAR - VIDEO_NEAR) instead left
      // most of the clipped strip with no image drawn in it at all, which is
      // a large part of why the film line was effectively invisible.
      const img = filmImgRef.current;
      if (img && minY < maxY && minX < maxX) {
        img.setAttribute("x", minX.toFixed(1));
        img.setAttribute("y", minY.toFixed(1));
        img.setAttribute("width", (maxX - minX).toFixed(1));
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
      // Paused glyph: centered on the film line at notch height.
      if (pausedRef.current) {
        pausedRef.current.style.transform =
          `translate(${(cx - VIDEO_NEAR - (VIDEO_FAR - VIDEO_NEAR) / 2).toFixed(1)}px, ${m.notch.y.toFixed(1)}px) translate(-50%, -50%)`;
      }

      // Drive the timeline from the local clock. While a drag is live the
      // pointer owns the offset (queuePaintDrag writes it), so skip. Written
      // as an inline style so it beats React's attribute and the poll rate:
      // the line advances every frame instead of lurching once a second.
      if (duration > 0 && progressRef.current && !dragging.current) {
        const elapsed = clock.current.paused ? 0 : (now - clock.current.at) / 1000;
        const pos = Math.min(duration, Math.max(0, clock.current.pos + elapsed));
        progressRef.current.style.strokeDashoffset = String(
          ARC_UNITS * (1 - pos / duration)
        );
      }
    };
    paint(performance.now());
    return () => {
      cancelAnimationFrame(geoRaf.current);
      geoRaf.current = 0;
    };
    // `duration` is read live inside the loop, so the effect only needs the
    // on/off transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Kill the CSS transition SYNCHRONOUSLY. Relying on the `dragOn` state's
    // re-render left the first few frames of every drag animating at the
    // transition's pace, which is what made the drag feel imprecise.
    if (progressRef.current) progressRef.current.dataset.drag = "true";
    pendingSeek.current = null;
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
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    const ratio = dragRatio.current;
    // Adopt the dragged position as the clock's new truth. Clearing the
    // inline offset here (the old behaviour) handed the line back to React's
    // attribute, which still held the PRE-seek polled value — the line
    // visibly jumped backwards, then crawled forward again.
    const now = performance.now();
    if (duration > 0) {
      clock.current.pos = ratio * duration;
      clock.current.at = now;
      pendingSeek.current = { ratio, at: now };
    }
    if (progressRef.current) {
      progressRef.current.style.strokeDashoffset = String(ARC_UNITS * (1 - ratio));
      // Re-enable the transition only after this value has painted, so the
      // re-enable itself can't animate anything.
      requestAnimationFrame(() => {
        if (progressRef.current) delete progressRef.current.dataset.drag;
      });
    }
    setDragOn(false);
    void nt()
      .mediaSeek(ratio, tabId)
      .catch(() => {});
  };

  const toggle = () => {
    // Optimistic: flip the local clock immediately so pausing stops the line
    // at once instead of letting it keep advancing until the next ~1Hz poll.
    clock.current.paused = !clock.current.paused;
    clock.current.at = performance.now();
    void nt()
      .mediaToggle(tabId)
      .catch(() => {});
  };

  // Initial paint only: the geometry loop takes over the offset from here.
  const progress =
    duration > 0 ? Math.min(1, Math.max(0, (media?.position ?? 0) / duration)) : 0;
  const showTimeline = on && !live && duration > 0;
  const showTip = on && duration > 0 && (dragOn || hoverOn);

  return (
    <div
      ref={rootRef}
      className={`nt-media-viewfinder${enterFx ? " nt-vf-enter" : ""}`}
      data-on={on ? "true" : "false"}
      aria-hidden={!on}
    >
      <svg className="nt-vf-seam" aria-hidden={!showTimeline}>
        {/* Invisible geometry source: always mounted while on, so both
            lines and the button row track the curve even for live streams. */}
        {on && <path ref={geoRef} className="nt-vf-seam-geo" />}
        {/* Film line FIRST (underneath): the thin curved strip carrying live
            frames of the media that is actually playing. Renders ONLY when a
            frame has arrived — no placeholder, no card, no bubble, and no
            empty rail when the media tab produces no frames at all. Click
            toggles play/pause. */}
        {on && thumb && (
          <g onClick={toggle} style={{ cursor: "pointer" }}>
            <defs>
              <clipPath id="nt-vf-film-clip">
                <polygon ref={filmPolyRef} points="" />
              </clipPath>
              {/* Glass sheen for the strip: light from the top-left. */}
              <linearGradient id="nt-vf-film-glass" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(255,255,255,0.22)" />
                <stop offset="42%" stopColor="rgba(255,255,255,0.04)" />
                <stop offset="100%" stopColor="rgba(0,0,0,0.18)" />
              </linearGradient>
            </defs>
            <g clipPath="url(#nt-vf-film-clip)">
              {/* `none` (not `slice`): the whole frame is mapped onto the
                  curved band so the viewer can actually tell what is
                  playing. `slice` cropped the picture to a 24px vertical
                  sliver of the frame's centre, which reads as noise. */}
              <image
                ref={filmImgRef}
                href={thumb}
                preserveAspectRatio="none"
              />
              {/* Sheen rides the exact same strip polygon as the frame. */}
              <polygon ref={filmSheenRef} points="" className="nt-vf-film-sheen" />
            </g>
            <polygon ref={filmEdgeRef} points="" className="nt-vf-film-edge" />
          </g>
        )}
        {/* Timeline line ON TOP of the film line: the real, live, draggable
            timeline. No playhead knob dot — the line itself is the
            timeline. */}
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

      {/* Transport: play/pause + PiP, seated BETWEEN the film line and the
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

      {/* Paused indicator: a play glyph on the film line at notch height. */}
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
