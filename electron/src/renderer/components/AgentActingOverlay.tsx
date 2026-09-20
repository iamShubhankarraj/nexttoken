/**
 * AgentActingOverlay — visible indicators while the voice-driven agent
 * controls the browser, floating above the webview:
 *
 * - a top-center status capsule ("Clicking “Sign in”…", "Working…") with a
 *   "Take over" button that halts the agent,
 * - a pulsing ring around the action's target,
 * - an AI cursor that glides from the capsule to the target,
 * - a confirm flash when the action lands,
 * - a subtle viewport edge glow for the whole acting window,
 * - a dictation toast ("N words dictated — ⌘Z to undo").
 *
 * The <webview> is a separate guest, so this sits as a sibling above it and
 * uses target rectangles relative to the webview viewport (CSS px).
 */

import { useEffect, useRef, useState } from "react";
import { useVoiceSession } from "./VoiceSession";
import { nt } from "../nt";

export function AgentActingOverlay() {
  const { acting, engine, dictated } = useVoiceSession();
  const boxRef = useRef<HTMLDivElement>(null);

  // AI cursor: starts at the capsule, glides to the target center.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [cursorLanded, setCursorLanded] = useState(false);
  useEffect(() => {
    setCursorLanded(false);
    const rect = acting?.targetRect;
    if (!rect) {
      setCursor(null);
      return;
    }
    const box = boxRef.current;
    const startX = box ? box.clientWidth / 2 : 400;
    setCursor({ x: startX, y: 40 });
    const tx = rect.x + rect.w / 2;
    const ty = rect.y + rect.h / 2;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setCursor({ x: tx, y: ty });
        setTimeout(() => setCursorLanded(true), 500);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [acting]);

  // Confirm flash: when the in-flight action clears, flash its last rect.
  const [flash, setFlash] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const prevActing = useRef(acting);
  useEffect(() => {
    if (prevActing.current && !acting && prevActing.current.targetRect) {
      const r = prevActing.current.targetRect;
      setFlash(r);
      const id = setTimeout(() => setFlash(null), 650);
      prevActing.current = acting;
      return () => clearTimeout(id);
    }
    prevActing.current = acting;
  }, [acting]);

  // Dictation toast visibility (8 s).
  const [toastAt, setToastAt] = useState(0);
  useEffect(() => {
    if (dictated) setToastAt(Date.now());
  }, [dictated]);
  const toastVisible = dictated && Date.now() - toastAt < 8000;
  const [, force] = useState(0);
  useEffect(() => {
    if (!toastVisible) return;
    const id = setTimeout(() => force((n) => n + 1), 1000);
    return () => clearTimeout(id);
  }, [toastVisible, toastAt]);

  const showCapsule = acting !== null || engine === "thinking";
  const words = dictated ? Math.max(1, Math.round(dictated.chars / 5)) : 0;

  return (
    <div ref={boxRef} className="acting-overlay" aria-hidden={!showCapsule && !toastVisible}>
      {acting && <div className="acting-edge-glow" />}

      {acting?.targetRect && (
        <div
          className="acting-target-ring"
          style={{
            left: acting.targetRect.x,
            top: acting.targetRect.y,
            width: Math.max(8, acting.targetRect.w),
            height: Math.max(8, acting.targetRect.h),
          }}
        />
      )}

      {flash && (
        <div
          className="acting-flash"
          style={{ left: flash.x, top: flash.y, width: flash.w, height: flash.h }}
        />
      )}

      {cursor && (
        <div
          className={`acting-cursor${cursorLanded ? " acting-cursor--landed" : ""}`}
          style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M4 2.5 14.5 9 9.8 9.8 7.5 14.5 4 2.5Z"
              fill="#E8A33D"
              stroke="#0B0B0D"
              strokeWidth="1.2"
            />
          </svg>
        </div>
      )}

      {showCapsule && (
        <div className="acting-capsule" role="status">
          <span className="acting-capsule-spinner" aria-hidden="true" />
          <span className="acting-capsule-label">
            {acting ? acting.label : "Working…"}
          </span>
          <button
            className="acting-capsule-takeover"
            onClick={() => void nt().voiceTakeover()}
            aria-label="Take over from the voice agent"
          >
            Take over
          </button>
        </div>
      )}

      {toastVisible && dictated && (
        <div className="acting-toast" role="status">
          <span>
            {words} word{words === 1 ? "" : "s"} dictated — ⌘Z to undo
          </span>
          <button
            className="acting-toast-undo"
            onClick={() => void nt().voiceDictateUndo().catch(() => {})}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
