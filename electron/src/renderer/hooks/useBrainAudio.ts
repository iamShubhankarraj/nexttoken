/**
 * Brain audio + voice-control plumbing.
 *
 * - `useBrainAudio()` subscribes to the brain's raw WAV playback channel
 *   (`nt.voice.playback`) and plays it through a lazily-created AudioContext.
 * - Brain-driven "start/stop listening" requests (`voice.listen.start/stop`
 *   intents) are routed to the component that owns the microphone via a tiny
 *   module-level registry — the AgentPanel registers its useVoice controls.
 * - Brain-driven command-bar opens arrive as `nt.ui.command-bar` and are
 *   re-dispatched as a window event so App can open the CommandBar.
 */

import { useEffect, useRef } from "react";
import { nt } from "../nt";

interface BrainVoiceControl {
  startListening: () => void;
  stopListening: () => void;
}

const registry: { current: BrainVoiceControl | null } = { current: null };

/** Called by the AgentPanel (the useVoice owner) on mount / unmount. */
export function registerBrainVoiceControl(c: BrainVoiceControl | null) {
  registry.current = c;
}

let sharedCtx: AudioContext | null = null;

async function playWavBytes(bytes: number[]) {
  if (!sharedCtx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    sharedCtx = new AC();
  }
  const ctx = sharedCtx;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* autoplay policy — best effort */
    }
  }
  try {
    const raw = new Uint8Array(bytes);
    // Copy into a fresh ArrayBuffer: decodeAudioData detaches the buffer.
    const buf = await ctx.decodeAudioData(raw.buffer.slice(0) as ArrayBuffer);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
  } catch {
    /* corrupt clip — skip */
  }
}

export function useBrainAudio() {
  const playingRef = useRef(false);

  useEffect(() => {
    const offPlayback = nt().onVoicePlayback((bytes) => {
      if (playingRef.current) return; // one TTS reply at a time
      playingRef.current = true;
      void playWavBytes(bytes).finally(() => {
        playingRef.current = false;
      });
    });
    const offListen = nt().onVoiceRequestListen((start) => {
      if (start) registry.current?.startListening();
      else registry.current?.stopListening();
    });
    const offBar = nt().onCommandBar(() => {
      window.dispatchEvent(new CustomEvent("nt:open-command-bar"));
    });
    return () => {
      offPlayback();
      offListen();
      offBar();
    };
  }, []);
}
