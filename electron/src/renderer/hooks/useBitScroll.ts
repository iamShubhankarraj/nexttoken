/**
 * useBitScroll — two-finger horizontal scroll on the sidebar switches Bits.
 *
 * A two-finger swipe left/right on a trackpad (or Shift+wheel on a mouse)
 * over the sidebar moves to the next/previous Bit, the way a paged surface
 * behaves. Three things make it safe to have this live on the whole sidebar:
 *
 *  - INTENT. A gesture only counts when the horizontal delta dominates the
 *    vertical one, so ordinary vertical scrolling of the tab list is never
 *    stolen. Shift+wheel is treated as horizontal because that is how most
 *    mice report a sideways scroll (as deltaY with shiftKey set).
 *
 *  - ONE SWIPE, ONE BIT. Trackpad momentum keeps emitting wheel events for up
 *    to a second after the fingers lift. Counting raw events would skip
 *    several Bits per flick, so deltas accumulate toward a threshold and a
 *    cooldown then swallows the momentum tail — pacing is per gesture, not
 *    per event.
 *
 *  - OPT-OUT. Regions marked `data-nt-bit-scroll-exclude` are ignored
 *    entirely. The App Store uses this, because horizontal scrolling
 *    there belongs to its own paging rather than to Bit switching.
 *
 * A committing swipe also calls preventDefault(), otherwise macOS reads the
 * same gesture as its native back/forward history swipe and both fire.
 */
import { useEffect, useRef } from "react";
import { nt } from "../nt";

/** Accumulated horizontal delta (px) that commits one Bit change. */
const COMMIT_PX = 90;
/** Gap (ms) with no wheel events that ends a gesture. */
const GESTURE_GAP_MS = 180;
/** Lockout after a commit, so one flick can only ever move one Bit. */
const COOLDOWN_MS = 520;

export function useBitScroll({
  targetRef,
  spaceIds,
  activeSpaceId,
  enabled,
}: {
  /** The sidebar element the gesture listens on. */
  targetRef: React.RefObject<HTMLElement | null>;
  /** Bit ids in sidebar order. */
  spaceIds: string[];
  activeSpaceId: string | undefined;
  enabled: boolean;
}): void {
  // Read live inside the listener, which itself is attached only once. Without
  // this the listener would close over the first render's Bit list.
  const live = useRef({ spaceIds, activeSpaceId });
  live.current = { spaceIds, activeSpaceId };

  useEffect(() => {
    const el = targetRef.current;
    if (!el || !enabled) return;

    let acc = 0;
    let lastAt = 0;
    let cooldownUntil = 0;

    const onWheel = (e: WheelEvent) => {
      // Regions that own their own horizontal gestures.
      if (
        (e.target as HTMLElement | null)?.closest?.(
          "[data-nt-bit-scroll-exclude]",
        )
      ) {
        acc = 0;
        return;
      }

      const shift = e.shiftKey && Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      const dx = shift ? e.deltaY : e.deltaX;
      const dy = shift ? 0 : e.deltaY;

      // Vertical intent — never steal it. (Also covers deltaX === 0.)
      if (Math.abs(dx) <= Math.abs(dy)) {
        acc = 0;
        return;
      }

      const now = performance.now();
      // Silence means a new gesture; drop whatever the last one accumulated so
      // a slow drift can never creep up on the threshold across gestures.
      if (now - lastAt > GESTURE_GAP_MS) acc = 0;
      lastAt = now;
      acc += dx;

      if (Math.abs(acc) < COMMIT_PX) return;

      // Fingers moving left (deltaX > 0) pull the NEXT Bit in from the right.
      const dir = acc > 0 ? 1 : -1;
      acc = 0;

      // Past the threshold this is unambiguously a Bit gesture, so consume it
      // even when clamped at an end — otherwise macOS would interpret the very
      // same swipe as a back/forward history navigation.
      e.preventDefault();

      if (now < cooldownUntil) return;

      const { spaceIds: ids, activeSpaceId: active } = live.current;
      const i = active ? ids.indexOf(active) : -1;
      if (i < 0) return;
      const next = i + dir;

      // Clamp at the ends rather than wrapping: with a wrap, one stray swipe
      // from the last Bit silently drops the user on the first.
      if (next < 0 || next >= ids.length) return;

      cooldownUntil = now + COOLDOWN_MS;
      void nt().spacesSwitch(ids[next]);
    };

    // Non-passive: preventDefault() is ignored on a passive listener, and
    // without it the native history swipe fires alongside ours.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [targetRef, enabled]);
}
