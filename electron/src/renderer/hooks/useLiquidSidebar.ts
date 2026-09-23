/**
 * useLiquidSidebar — the "breathing" sidebar engine.
 *
 * Drives everything imperatively (refs + direct DOM writes) so React never
 * re-renders per frame:
 *  - Sidebar width breathes with cursor proximity: rests at ~180px, expands
 *    to ~235px as the cursor approaches/hovers. A real spring
 *    (stiffness/damping, slight overshoot, ~0.8-1s settle) runs on rAF and
 *    writes the `--sbw` CSS variable per frame.
 *  - The liquid seam SVG path (the sidebar's organic right edge with its two
 *    scoop cutouts) is rebuilt from the animated width every frame — the
 *    seam morphs live in sync with the spring.
 *  - The active-tab glide pill springs (translateY) to the active row instead
 *    of jump-cutting, and stays glued to it across scrolls.
 *
 * Respects prefers-reduced-motion (snaps instead of springing).
 */
import { useEffect, useMemo, useRef } from "react";

export const SB_REST = 180;
export const SB_MAX = 235;
/** Drag-resize limits for the main sidebar (px). */
export const SB_DRAG_MIN = 160;
export const SB_DRAG_MAX = 320;
/** Drag-resize limits for the agent panel (px). */
export const AGENT_DRAG_MIN = 300;
export const AGENT_DRAG_MAX = 560;
/** Cursor distance (px) past the sidebar's right edge that still counts as "approaching". */
const PROXIMITY = 130;
/** Spring constants: slight overshoot, settles in ~0.8-1s. */
const STIFFNESS = 170;
const DAMPING = 21;
const GLIDE_STIFFNESS = 260;
const GLIDE_DAMPING = 30;

export interface LiquidSidebarRefs {
  asideRef: React.RefObject<HTMLElement | null>;
  /** The sidebar background shape (fill). */
  seamFillRef: React.RefObject<SVGPathElement | null>;
  /** Soft highlight along the liquid edge (stroke). */
  seamHiRef: React.RefObject<SVGPathElement | null>;
  /**
   * Curved resize-handle affordance: the hover/drag line on the sidebar's
   * right edge. It is given the SAME path as the seam edge each frame, so the
   * grab line bends with the sidebar's curve (including both scoops) instead
   * of being a straight vertical rule that cuts across the curve.
   */
  resizeAffRef: React.RefObject<SVGPathElement | null>;
  /**
   * Paper-grain layer. Shares the fill path, so the grain is clipped to the
   * sidebar's organic shape (scoops included) and follows the breathing width
   * for free. Always mounted; its strength is the --nt-sidebar-texture
   * opacity, which is what lets the settings slider preview live.
   */
  seamGrainRef: React.RefObject<SVGPathElement | null>;
  /** The gliding active-tab pill. */
  glideRef: React.RefObject<HTMLDivElement | null>;
  /** The scroll viewport containing the tab lists. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Positioned content wrapper inside the scroll viewport (pill's offset parent). */
  contentRef: React.RefObject<HTMLDivElement | null>;
}

interface Engine {
  w: number;
  v: number;
  target: number;
  gy: number;
  gv: number;
  gTarget: number;
  gVisible: boolean;
  /** Media-notch morph 0..1 (drives the deepened lower scoop). */
  mt: number;
  mvv: number;
  mTarget: number;
  /** Explicit user-set width (drag resize). When set, auto-breathing is off. */
  dragW: number | null;
  /** True while a drag-resize pointer is down (width follows the pointer). */
  dragging: boolean;
  raf: number;
  running: boolean;
  h: number;
  reduceMotion: boolean;
  /** Recompute the glide target from the live active row. */
  syncGlide: (animate: boolean) => void;
  kick: () => void;
  paint: () => void;
}

/**
 * Build the sidebar background shape for animated width `w` and height `h`.
 * The right edge is organic: a rounded notch (scoop) near the top around the
 * URL pill zone, and a parenthesis sweep near the bottom cradling the bottom
 * controls. Scoop depths morph subtly with the width so the seam "breathes"
 * with the spring. When `mediaT` (0..1) rises — the media notch showing —
 * the lower scoop deepens to cradle the video controls, and a `notch` anchor
 * is returned so the control cluster can ride the seam.
 */
/** The two cubic segments of the lower parenthesis scoop (no moveto). */
function scoopCurves(ex: number, y0: number, y1: number, d2: number): string {
  return (
    ` C ${ex},${y0 + 30} ${ex + d2},${y0 + 44} ${ex + d2},${y0 + 88}` +
    ` C ${ex + d2},${y0 + 132} ${ex},${y0 + 146} ${ex},${y1}`
  );
}

/**
 * The lower scoop's curve as a standalone path — the EXACT same Bézier
 * geometry as the liquid seam's right edge. The media viewfinder draws its
 * progress line with this path (via the --scoop-d CSS var) so the timeline
 * bends with the sidebar's curve instead of rendering as a straight line.
 */
export function buildScoopPath(w: number, h: number, mediaT = 0): string {
  return getScoopMetrics(w, h, mediaT).d;
}

/**
 * All scoop geometry in one place, computed from the exact same inputs as
 * the seam builder. The viewfinder reads this (via the live --sbw/--media-t
 * CSS vars) and sets its timeline `d` attribute directly, so the progress
 * line IS the sidebar's curve — never an approximation, never a straight
 * segment.
 */
export interface ScoopMetrics {
  /** Standalone path of the scoop curve (the timeline's exact shape). */
  d: string;
  /** Anchor for the media control cluster: inside the deepened scoop. */
  notch: { x: number; y: number };
  /** Nominal right edge of the sidebar. */
  ex: number;
  /** Scoop depth at the current width/morph. */
  d2: number;
  /** Scoop vertical span. */
  y0: number;
  y1: number;
}

export function getScoopMetrics(w: number, h: number, mediaT = 0): ScoopMetrics {
  const t = Math.min(1, Math.max(0, (w - SB_REST) / (SB_MAX - SB_REST)));
  const d2 = 24 + t * 9 + mediaT * 18;
  const ex = w - 2;
  const tbBot = 100 + 92;
  const y1 = h - 64;
  const y0 = Math.max(tbBot + 28, y1 - 152);
  return {
    d: `M ${ex},${y0}` + scoopCurves(ex, y0, y1, d2),
    notch: { x: ex + d2 * 0.52, y: y0 + 76 },
    ex,
    d2,
    y0,
    y1,
  };
}

export function buildSeamPaths(
  w: number,
  h: number,
  mediaT = 0
): { fill: string; edge: string; notch: { x: number; y: number } } {
  const t = Math.min(1, Math.max(0, (w - SB_REST) / (SB_MAX - SB_REST)));
  const d1 = 20 + t * 9; // top notch depth: 20 -> 29
  // Bottom parenthesis depth: 24 -> 33, +18 with media. Shared with the
  // viewfinder via getScoopMetrics so the timeline is never an approximation.
  const { d2, ex, y0, y1, notch } = getScoopMetrics(w, h, mediaT);
  const rTL = 14;
  const rTR = 14;
  const rBR = 22;
  const rBL = 14;

  // Top notch (scoop): spans tbTop..tbTop+92, cradling the URL pill zone.
  const tbTop = 100;
  const tbBot = tbTop + 92;

  const fill =
    `M ${rTL},0` +
    ` H ${ex - rTR} Q ${ex},0 ${ex},${rTR}` +
    ` V ${tbTop}` +
    ` C ${ex},${tbTop + 18} ${ex + d1},${tbTop + 26} ${ex + d1},${tbTop + 46}` +
    ` C ${ex + d1},${tbTop + 66} ${ex},${tbTop + 74} ${ex},${tbBot}` +
    ` V ${y0}` +
    scoopCurves(ex, y0, y1, d2) +
    ` V ${h - rBR} Q ${ex},${h} ${ex - rBR},${h}` +
    ` H ${rBL} Q 0,${h} 0,${h - rBL}` +
    ` V ${rTL} Q 0,0 ${rTL},0 Z`;

  const edge =
    `M ${ex - rTR},0 Q ${ex},0 ${ex},${rTR}` +
    ` V ${tbTop}` +
    ` C ${ex},${tbTop + 18} ${ex + d1},${tbTop + 26} ${ex + d1},${tbTop + 46}` +
    ` C ${ex + d1},${tbTop + 66} ${ex},${tbTop + 74} ${ex},${tbBot}` +
    ` V ${y0}` +
    scoopCurves(ex, y0, y1, d2) +
    ` V ${h - rBR} Q ${ex},${h} ${ex - rBR},${h}`;

  return {
    fill,
    edge,
    // Anchor for the media control cluster: inside the deepened scoop,
    // vertically centered on it. Written to --media-x/--media-y per frame.
    notch,
  };
}

/** Imperative controls for the sidebar's explicit (user-dragged) width. */
export interface LiquidSidebarApi {
  /** Begin a drag-resize gesture (pauses the auto-breathing spring). */
  beginDrag: () => void;
  /** Follow the pointer during a drag — width morphs the seam live. */
  dragTo: (widthPx: number) => void;
  /** End the drag. Returns the settled explicit width (px). */
  endDrag: () => number | null;
  /** Clear the explicit width and return to auto-breathing. */
  resetWidth: () => void;
  /** Whether an explicit width is currently set. */
  isExplicit: () => boolean;
}

export function useLiquidSidebar(
  refs: LiquidSidebarRefs,
  activeTabId: string | undefined,
  enabled: boolean,
  mediaActive = false,
  initialWidth: number | null = null,
): LiquidSidebarApi {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // The engine lives for the whole mount; the main effect wires DOM listeners.
  const engineRef = useRef<Engine | null>(null);
  if (!engineRef.current) {
    const s: Engine = {
      w: SB_REST,
      v: 0,
      target: SB_REST,
      gy: 0,
      gv: 0,
      gTarget: 0,
      gVisible: false,
      mt: 0,
      mvv: 0,
      mTarget: 0,
      dragW: null,
      dragging: false,
      raf: 0,
      running: false,
      h: 0,
      reduceMotion: false,
      syncGlide: () => {},
      kick: () => {},
      paint: () => {},
    };

    s.paint = () => {
      const r = refsRef.current;
      const aside = r.asideRef.current;
      if (aside) aside.style.setProperty("--sbw", `${s.w.toFixed(2)}px`);
      if (s.h > 0) {
        const p = buildSeamPaths(s.w, s.h, s.mt);
        r.seamFillRef.current?.setAttribute("d", p.fill);
        r.seamHiRef.current?.setAttribute("d", p.edge);
        // The resize affordance traces the very same edge.
        r.resizeAffRef.current?.setAttribute("d", p.edge);
        // Grain reuses the fill outline (null ref when texture is off).
        r.seamGrainRef.current?.setAttribute("d", p.fill);
        // Publish the live morph param too: the viewfinder reads --sbw and
        // --media-t and rebuilds the EXACT scoop curve itself (same function,
        // same params), so its timeline can never drift from the seam.
        if (aside) aside.style.setProperty("--media-t", s.mt.toFixed(3));
        // Keep the media control cluster riding the deepened scoop, and
        // publish the scoop's exact curve so the viewfinder's progress line
        // bends with the seam (no straight segments).
        if (s.mt > 0.02 && aside) {
          aside.style.setProperty("--media-x", `${p.notch.x.toFixed(1)}px`);
          aside.style.setProperty("--media-y", `${p.notch.y.toFixed(1)}px`);
          aside.style.setProperty("--scoop-d", `path("${buildScoopPath(s.w, s.h, s.mt)}")`);
        }
      }
      const glide = r.glideRef.current;
      if (glide) {
        glide.style.transform = `translate3d(0, ${s.gy.toFixed(2)}px, 0)`;
        glide.style.opacity = s.gVisible ? "1" : "0";
      }
    };

    const step = (now: number, prev: number): boolean => {
      const dt = Math.min(0.05, Math.max(0.001, (now - prev) / 1000));
      let settled = true;
      if (s.reduceMotion) {
        s.w = s.target;
        s.v = 0;
        s.gy = s.gTarget;
        s.gv = 0;
        s.mt = s.mTarget;
        s.mvv = 0;
      } else {
        const f = -(s.w - s.target) * STIFFNESS - s.v * DAMPING;
        s.v += f * dt;
        s.w += s.v * dt;
        if (Math.abs(s.w - s.target) > 0.05 || Math.abs(s.v) > 0.05) settled = false;
        else {
          s.w = s.target;
          s.v = 0;
        }
        const gf = -(s.gy - s.gTarget) * GLIDE_STIFFNESS - s.gv * GLIDE_DAMPING;
        s.gv += gf * dt;
        s.gy += s.gv * dt;
        if (Math.abs(s.gy - s.gTarget) > 0.1 || Math.abs(s.gv) > 0.1) settled = false;
        else {
          s.gy = s.gTarget;
          s.gv = 0;
        }
        // Media-notch morph: same spring language, slightly snappier.
        const mf = -(s.mt - s.mTarget) * 200 - s.mvv * 24;
        s.mvv += mf * dt;
        s.mt += s.mvv * dt;
        if (Math.abs(s.mt - s.mTarget) > 0.002 || Math.abs(s.mvv) > 0.002) settled = false;
        else {
          s.mt = s.mTarget;
          s.mvv = 0;
        }
      }
      s.paint();
      return settled;
    };

    s.kick = () => {
      if (s.running) return;
      s.running = true;
      const loop = (prev: number) => (now: number) => {
        if (!step(now, prev)) {
          s.raf = requestAnimationFrame(loop(now));
        } else {
          s.running = false;
          s.paint();
        }
      };
      s.raf = requestAnimationFrame(loop(performance.now()));
    };

    s.syncGlide = (animate: boolean) => {
      const r = refsRef.current;
      const id = activeTabIdRef.current;
      const content = r.contentRef.current;
      if (!id || !content) {
        if (s.gVisible) {
          s.gVisible = false;
          s.paint();
        }
        return;
      }
      let row: HTMLElement | null = null;
      try {
        row = content.querySelector<HTMLElement>(`[data-tab-row="${CSS.escape(id)}"]`);
      } catch {
        row = null;
      }
      if (!row) {
        // Active tab lives in a collapsed folder or isn't mounted (virtualized
        // out) — park the pill instead of jumping it somewhere wrong.
        if (s.gVisible) {
          s.gVisible = false;
          s.paint();
        }
        return;
      }
      const rr = row.getBoundingClientRect();
      const cr = content.getBoundingClientRect();
      s.gTarget = rr.top - cr.top;
      s.gVisible = true;
      if (!animate || s.reduceMotion) {
        s.gy = s.gTarget;
        s.gv = 0;
        s.paint();
      } else {
        s.kick();
      }
    };

    engineRef.current = s;
  }

  // Imperative drag-resize API. All writes go straight to the engine (refs +
  // direct DOM writes), so a drag never re-renders React — the seam path is
  // rebuilt from the live width every frame at 60fps.
  const api = useMemo<LiquidSidebarApi>(
    () => ({
      beginDrag: () => {
        const s = engineRef.current;
        if (!s) return;
        s.dragging = true;
        s.v = 0;
      },
      dragTo: (widthPx: number) => {
        const s = engineRef.current;
        if (!s || !s.dragging) return;
        const c = Math.min(SB_DRAG_MAX, Math.max(SB_DRAG_MIN, widthPx));
        s.dragW = c;
        s.target = c;
        s.w = c;
        s.v = 0;
        s.paint();
      },
      endDrag: () => {
        const s = engineRef.current;
        if (!s) return null;
        s.dragging = false;
        s.kick();
        return s.dragW;
      },
      resetWidth: () => {
        const s = engineRef.current;
        if (!s) return;
        s.dragging = false;
        s.dragW = null;
        s.target = SB_REST;
        s.kick();
      },
      isExplicit: () => engineRef.current?.dragW != null,
    }),
    [],
  );

  // Apply the persisted explicit width once the engine is enabled. The
  // persisted width survives the snapshot round-trip, so the guard here only
  // prevents re-applying on re-renders — a drag that sets dragW itself is
  // the source of truth while active.
  const appliedInitialRef = useRef(false);
  useEffect(() => {
    if (!enabled || appliedInitialRef.current) return;
    appliedInitialRef.current = true;
    const s = engineRef.current;
    if (!s || initialWidth == null) return;
    const c = Math.min(SB_DRAG_MAX, Math.max(SB_DRAG_MIN, initialWidth));
    s.dragW = c;
    s.target = c;
    s.w = c;
    s.v = 0;
    s.paint();
  }, [enabled, initialWidth]);

  useEffect(() => {
    const s = engineRef.current;
    if (!s) return;
    try {
      s.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* keep false */
    }
  }, []);

  useEffect(() => {
    const s = engineRef.current;
    if (!s || !enabled) return;
    const r = refsRef.current;

    const measure = () => {
      const h = r.asideRef.current?.clientHeight ?? 0;
      if (h && h !== s.h) {
        s.h = h;
        s.paint();
      }
    };

    // Cursor proximity -> width target. The sidebar spans 0..w, so anything
    // within PROXIMITY px of its right edge counts as "approaching".
    // An explicit (user-dragged) width wins over breathing entirely.
    const onMove = (e: MouseEvent) => {
      if (s.dragging || s.dragW != null) return;
      const t = e.clientX < s.w + PROXIMITY ? SB_MAX : SB_REST;
      if (t !== s.target) {
        s.target = t;
        s.kick();
      }
    };
    const onLeave = () => {
      if (s.dragW != null) return;
      if (s.target !== SB_REST) {
        s.target = SB_REST;
        s.kick();
      }
    };
    // Keyboard users: expand while focus is inside the sidebar.
    const onFocusIn = (e: FocusEvent) => {
      if (s.dragW != null) return;
      if ((e.target as HTMLElement | null)?.closest?.("aside.nt-liquid-sidebar")) {
        if (s.target !== SB_MAX) {
          s.target = SB_MAX;
          s.kick();
        }
      }
    };
    const onFocusOut = () => {
      if (s.dragW != null) return;
      if (s.target !== SB_REST) {
        s.target = SB_REST;
        s.kick();
      }
    };
    const onScroll = () => s.syncGlide(false);

    window.addEventListener("mousemove", onMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);
    window.addEventListener("focusin", onFocusIn);
    window.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && r.asideRef.current) ro.observe(r.asideRef.current);
    const scroller = r.scrollRef.current;
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    // The ungrouped tab list has its own inner scroll viewport.
    const innerScrollers = r.asideRef.current?.querySelectorAll(".nt-tablist-scroll");
    innerScrollers?.forEach((el) => el.addEventListener("scroll", onScroll, { passive: true }));

    measure();
    s.paint();
    // Defer one frame so tab rows have mounted, then glue the pill.
    const t0 = requestAnimationFrame(() => s.syncGlide(false));

    return () => {
      cancelAnimationFrame(t0);
      if (s.running) cancelAnimationFrame(s.raf);
      s.running = false;
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", measure);
      ro?.disconnect();
      scroller?.removeEventListener("scroll", onScroll);
      innerScrollers?.forEach((el) => el.removeEventListener("scroll", onScroll));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // The active tab changed -> glide the pill there (spring, never a jump cut).
  useEffect(() => {
    if (!enabled) return;
    const s = engineRef.current;
    if (!s) return;
    // Defer a frame: the new active row may just have mounted.
    const t = requestAnimationFrame(() => s.syncGlide(true));
    return () => cancelAnimationFrame(t);
  }, [activeTabId, enabled]);

  // Media notch: morph the lower scoop deeper while a video is present.
  useEffect(() => {
    if (!enabled) return;
    const s = engineRef.current;
    if (!s) return;
    s.mTarget = mediaActive ? 1 : 0;
    s.kick();
  }, [mediaActive, enabled]);

  return api;
}
