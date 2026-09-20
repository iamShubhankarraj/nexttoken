/**
 * VoiceOrb — Perplexity-style amplitude-reactive particle sphere, recolored
 * to ember. ~40 dots on a sphere projected to 2D on a <canvas>; the radius
 * breathes with mic/playback amplitude, and dots "scatter and reform" on
 * mode change. No WebGL, no dependencies.
 *
 * Respects prefers-reduced-motion: renders a static dot field instead.
 */

import { useEffect, useRef } from "react";

export type VoiceOrbMode = "listening" | "thinking" | "speaking" | "idle";

interface Props {
  mode: VoiceOrbMode;
  /** 0..1 mic or playback amplitude (listening/speaking). */
  amplitude?: number;
  size?: number;
  className?: string;
}

interface Particle {
  /** Unit-sphere position. */
  x: number;
  y: number;
  z: number;
  /** Scatter offset applied on mode change, decays to 0. */
  sx: number;
  sy: number;
  scatter: number;
  speed: number;
  phase: number;
}

const COUNT = 42;

export function VoiceOrb({ mode, amplitude = 0, size = 28, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{ parts: Particle[]; mode: VoiceOrbMode } | null>(null);
  const liveRef = useRef({ mode, amplitude });
  liveRef.current = { mode, amplitude };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Fibonacci sphere for an even dot distribution.
    const parts: Particle[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < COUNT; i++) {
      const y = 1 - (i / (COUNT - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      parts.push({
        x: Math.cos(th) * r,
        y,
        z: Math.sin(th) * r,
        sx: 0,
        sy: 0,
        scatter: 0,
        speed: 0.25 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
      });
    }
    const st = { parts, mode: liveRef.current.mode as VoiceOrbMode };
    stateRef.current = st;

    let raf = 0;
    let last = performance.now();
    const scatterOn = (m: VoiceOrbMode) => {
      if (m === st.mode) return;
      st.mode = m;
      for (const p of parts) {
        const a = Math.random() * Math.PI * 2;
        const d = 0.6 + Math.random() * 0.9;
        p.sx = Math.cos(a) * d;
        p.sy = Math.sin(a) * d;
        p.scatter = 1;
      }
    };

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { mode: m, amplitude: amp } = liveRef.current;
      scatterOn(m);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const R = canvas.width * 0.36;

      // Radius breathes with amplitude (listening/speaking); slow idle spin for thinking.
      const breathe = m === "listening" || m === "speaking" ? amp : 0.12 + 0.08 * Math.sin(now / 900);
      const radius = R * (1 + breathe * 0.45);
      const spin = m === "thinking" ? now / 2400 : now / 5200;

      for (const p of parts) {
        // Rotate around Y.
        const x = p.x * Math.cos(spin) + p.z * Math.sin(spin);
        const z = -p.x * Math.sin(spin) + p.z * Math.cos(spin);
        const y = p.y + (reduced ? 0 : Math.sin(now / 700 + p.phase) * 0.05 * p.speed);

        // Scatter decays back to the sphere.
        p.scatter = Math.max(0, p.scatter - dt * 1.6);
        const ease = p.scatter * p.scatter;
        const px = cx + (x * radius + p.sx * radius * ease);
        const py = cy + (y * radius + p.sy * radius * ease);

        const depth = (z + 1) / 2; // 0 far → 1 near
        const dotR = (0.9 + depth * 1.5) * dpr;
        const alpha = 0.25 + depth * 0.75;
        ctx.beginPath();
        ctx.arc(px, py, dotR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(232, 163, 61, ${alpha.toFixed(3)})`;
        ctx.fill();
      }
    };

    if (reduced) {
      // One static frame: the identity without the motion.
      const { amplitude: amp } = liveRef.current;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const R = canvas.width * 0.36 * (1 + Math.min(1, amp) * 0.45);
      for (const p of parts) {
        const depth = (p.z + 1) / 2;
        ctx.beginPath();
        ctx.arc(cx + p.x * R, cy + p.y * R, (0.9 + depth * 1.5) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(232, 163, 61, ${(0.25 + depth * 0.75).toFixed(3)})`;
        ctx.fill();
      }
    } else {
      raf = requestAnimationFrame(draw);
    }
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
