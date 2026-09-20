/**
 * VoicePill — the floating voice indicator rendered in the dedicated
 * overlay window (location hash #voice-pill). Transparent, frameless,
 * bottom-center; the main process forwards every voice event here.
 *
 * Owns its own visibility policy: visible while listening, transcribing,
 * thinking, speaking (TTS playback), or showing an error; invisible
 * otherwise. Never rely on color alone — every state has a text label.
 */

import { useEffect, useRef, useState } from "react";
import { VoiceOrb, type VoiceOrbMode } from "./VoiceOrb";
import type { VoiceEngineState } from "../../shared/ipc";
import { nt } from "../nt";

type PillPhase = "hidden" | "listening" | "transcribing" | "thinking" | "speaking" | "error";

const PHASE_LABEL: Record<Exclude<PillPhase, "hidden" | "error">, string> = {
  listening: "Listening…",
  transcribing: "Transcribing…",
  thinking: "Working…",
  speaking: "Speaking — tap to interrupt",
};

const BARS = 24;

export function VoicePill() {
  const [engine, setEngine] = useState<VoiceEngineState>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [amp, setAmp] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    const offs = [
      nt().onVoiceEngineState((s) => {
        setEngine(s);
        if (s === "listening") {
          startedAt.current = Date.now();
          setElapsed(0);
          setError(null);
        }
        if (s !== "idle") setError(null);
      }),
      nt().onVoicePlaybackState((v) => setSpeaking(v)),
      nt().onVoiceAmplitude((level) => setAmp(level)),
      nt().onVoiceError((message) => setError(message)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Listening timer.
  useEffect(() => {
    if (engine !== "listening") return;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)),
      500,
    );
    return () => clearInterval(id);
  }, [engine]);

  const phase: PillPhase =
    error !== null
      ? "error"
      : speaking || engine === "speaking"
        ? "speaking"
        : engine === "listening"
          ? "listening"
          : engine === "transcribing"
            ? "transcribing"
            : engine === "thinking"
              ? "thinking"
              : "hidden";

  if (phase === "hidden") return null;

  const orbMode: VoiceOrbMode =
    phase === "listening"
      ? "listening"
      : phase === "speaking"
        ? "speaking"
        : phase === "thinking" || phase === "transcribing"
          ? "thinking"
          : "idle";

  const onTap = () => {
    if (phase === "speaking") {
      // Barge-in: main kills the engine state, tells the app window to
      // stop TTS playback and start listening fresh.
      void nt().voiceStopSpeaking();
    } else if (phase === "error") {
      setError(null);
    }
  };

  const mm = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="voice-pill-root">
      <button
        className={`voice-pill voice-pill--${phase}`}
        onClick={onTap}
        aria-label={
          phase === "speaking"
            ? "Interrupt speech and start listening"
            : phase === "error"
              ? `Voice error: ${error}. Activate to dismiss.`
              : PHASE_LABEL[phase as Exclude<PillPhase, "hidden" | "error">]
        }
      >
        <VoiceOrb mode={orbMode} amplitude={amp} size={30} />
        {phase === "listening" || phase === "speaking" ? (
          <span className={`voice-pill-wave voice-pill-wave--${phase}`} aria-hidden="true">
            {Array.from({ length: BARS }, (_, i) => {
              // Mic amplitude drives listening bars; speaking bars animate
              // via CSS (playback has no live amplitude feed).
              const h =
                phase === "listening"
                  ? 4 + amp * 22 * (0.4 + 0.6 * Math.abs(Math.sin(i * 1.7)))
                  : 10;
              return (
                <i
                  key={i}
                  style={
                    phase === "listening"
                      ? { height: `${Math.min(26, h)}px` }
                      : { animationDelay: `${(i % 8) * 0.09}s` }
                  }
                />
              );
            })}
          </span>
        ) : null}
        <span className="voice-pill-text">
          <span className="voice-pill-label">
            {phase === "error" ? "Voice error" : PHASE_LABEL[phase as Exclude<PillPhase, "hidden" | "error">]}
          </span>
          {phase === "error" ? (
            <span className="voice-pill-sub">{error}</span>
          ) : phase === "listening" ? (
            <span className="voice-pill-sub">{mm}</span>
          ) : null}
        </span>
        {phase === "transcribing" || phase === "thinking" ? (
          <span className="voice-pill-spinner" aria-hidden="true" />
        ) : null}
      </button>
    </div>
  );
}
