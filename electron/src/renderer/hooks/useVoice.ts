/**
 * Voice control for Next Token.
 *
 * Two STT backends:
 *   - LOCAL (preferred): on-device whisper.cpp via the main process
 *     (`window.nt.voice*` IPC, implemented by the integrator). Mic audio is
 *     captured with getUserMedia → AudioContext → ScriptProcessor,
 *     downsampled to 16 kHz int16, and streamed to the main process in
 *     ~250 ms chunks. Used whenever `voiceSttAvailable()` reports a
 *     downloaded STT model.
 *   - WEB (fallback): webkitSpeechRecognition in Chromium/Electron,
 *     exactly as before. Any local failure falls back here.
 *
 * Two modes:
 *   - "command": one final transcript is parsed by runVoiceCommand() and
 *     executed against window.nt; recognition stops after the command.
 *   - "dictate": manual stop; the final transcript is appended into the
 *     agent chat input via onDictation.
 *
 * Alt+V (or Cmd/Ctrl+Shift+V) toggles command listening from anywhere —
 * the hook listens for a "nt:voice-toggle" CustomEvent dispatched by the
 * global key handler.
 *
 * TTS: `speakLocal(text)` synthesises via the on-device Kokoro engine and
 * plays the WAV; returns false when unavailable so callers can fall back
 * to speechSynthesis.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpaceState, VoiceEngineState, VoiceTranscript } from "../../shared/ipc";
import { fuzzy, nt } from "../nt";

export type VoiceMode = "command" | "dictate";

/**
 * Guided voice-setup states. Shown as a card in the agent panel instead of
 * a bare error string:
 * - "no-stt-model": no Whisper model downloaded → one-tap download button.
 * - "no-stt-binary": model is ready but the whisper-cli sidecar is missing →
 *   manual install steps.
 * - "mic-denied": mic permission denied → macOS System Settings guide.
 */
export type VoiceGuideKind = "no-stt-model" | "no-stt-binary" | "mic-denied";

export interface VoiceGuide {
  kind: VoiceGuideKind;
  /** Manual whisper-cli install steps (no-stt-binary only). */
  steps?: string;
}

/** macOS mic-denial guidance (Next Token is macOS-only). */
const MIC_DENIED_NOTICE =
  "Microphone access was denied. Grant access in System Settings → Privacy & Security → Microphone, then try again.";

/**
 * Local voice IPC surface. Owned by the integrator (preload + main
 * handlers); declared here so the hook compiles without it.
 */
interface NtVoice {
  voiceSttAvailable(): Promise<boolean>;
  /** Granular STT readiness (wired in preload; may be absent in old builds). */
  voiceSttStatus?(): Promise<{ model: boolean; binary: boolean; binarySteps: string }>;
  voiceStartListening(): Promise<void>;
  /** Ask the main process to ensure macOS mic permission (properly
   *  attributed prompt). Resolves {granted:false} when denied. */
  voiceEnsureMic?(): Promise<{ granted: boolean }>;
  voiceAudioChunk(data: Uint8Array): Promise<void>;
  voiceStopListening(): Promise<VoiceTranscript>;
  voiceCancelListening(): Promise<void>;
  voiceSpeak(text: string): Promise<Uint8Array>;
  voiceStopSpeaking(): Promise<void>;
  /** Fire-and-forget mic amplitude (0..1) for the pill waveform. */
  voiceAmplitude(level: number): void;
  /** Renderer started/stopped TTS audio playback (drives the pill). */
  voicePlaybackStarted(): void;
  voicePlaybackEnded(): void;
  settingsGetVoice(): Promise<{ micDeviceId?: string }>;
  onVoiceEngineState(cb: (s: VoiceEngineState) => void): () => void;
}

/** The integrator wires these onto window.nt; null until they do. */
function voiceApi(): NtVoice | null {
  try {
    const api = window.nt as unknown as NtVoice | undefined;
    if (!api || typeof api.voiceSttAvailable !== "function") return null;
    return api;
  } catch {
    return null;
  }
}

async function localSttAvailable(): Promise<boolean> {
  const api = voiceApi();
  if (!api) return false;
  try {
    return await api.voiceSttAvailable();
  } catch {
    return false;
  }
}

/**
 * Speak via the on-device Kokoro TTS engine. Plays the returned WAV and
 * resolves true on success; resolves false when the local engine is
 * unavailable or fails, so the caller can fall back to speechSynthesis.
 *
 * The active <audio> element is tracked so barge-in (Alt+V / tap the pill)
 * can stop it instantly via stopLocalSpeech().
 */
let activeSpeechEl: HTMLAudioElement | null = null;

function playbackApi(): Pick<NtVoice, "voicePlaybackStarted" | "voicePlaybackEnded"> | null {
  return voiceApi();
}

/** True while on-device TTS audio is playing. */
export function isLocalSpeechPlaying(): boolean {
  return activeSpeechEl !== null && !activeSpeechEl.paused && !activeSpeechEl.ended;
}

/** Barge-in: pause and discard any in-flight TTS playback at once. */
export function stopLocalSpeech(): void {
  const el = activeSpeechEl;
  activeSpeechEl = null;
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute("src");
    el.load();
  } catch {
    /* already gone */
  }
  try {
    playbackApi()?.voicePlaybackEnded();
  } catch {
    /* noop */
  }
}

export async function speakLocal(text: string): Promise<boolean> {
  try {
    const api = voiceApi();
    if (!api || typeof api.voiceSpeak !== "function") return false;
    const wav = await api.voiceSpeak(text);
    if (!wav || wav.length === 0) return false;
    // Copy into a fresh ArrayBuffer-backed view (structured-clone payloads
    // may ride on a SharedArrayBuffer, which Blob rejects).
    const bytes = new Uint8Array(wav);
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    try {
      await new Promise<void>((resolve, reject) => {
        const el = new Audio(url);
        activeSpeechEl = el;
        try {
          playbackApi()?.voicePlaybackStarted();
        } catch {
          /* noop */
        }
        const done = () => {
          if (activeSpeechEl === el) activeSpeechEl = null;
          try {
            playbackApi()?.voicePlaybackEnded();
          } catch {
            /* noop */
          }
        };
        el.onended = () => {
          done();
          resolve();
        };
        el.onerror = () => {
          done();
          reject(new Error("local TTS playback failed"));
        };
        el.play().catch((e) => {
          done();
          reject(e);
        });
      });
      return true;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return false;
  }
}

/** Active on-device capture session. */
interface LocalCapture {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Int16Array[];
  pendingSamples: number;
  /** Auto-finalize timer (90 s cap on a single utterance). */
  capTimer?: ReturnType<typeof setTimeout>;
  /** Ordered sender — chunks never overtake each other. */
  send(bytes: Uint8Array): Promise<void>;
  drain(): Promise<void>;
}

/** ~250 ms of 16 kHz audio per streamed chunk. */
const LOCAL_CHUNK_SAMPLES = 4000;

function clamp16(v: number): number {
  const s = Math.round(v * 32768);
  return s < -32768 ? -32768 : s > 32767 ? 32767 : s;
}

/** Downsample float32 mic audio to 16 kHz int16 (box average). */
function downsampleTo16k(input: Float32Array, fromRate: number): Int16Array {
  if (fromRate <= 16000) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = clamp16(input[i]);
    return out;
  }
  const ratio = fromRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = clamp16(sum / Math.max(1, end - start));
  }
  return out;
}

function mergeInt16(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function teardownLocalSession(s: LocalCapture): void {
  if (s.capTimer) clearTimeout(s.capTimer);
  try {
    s.processor.onaudioprocess = null;
  } catch {
    /* noop */
  }
  try {
    s.processor.disconnect();
  } catch {
    /* noop */
  }
  try {
    s.source.disconnect();
  } catch {
    /* noop */
  }
  for (const t of s.stream.getTracks()) {
    try {
      t.stop();
    } catch {
      /* noop */
    }
  }
  s.ctx.close().catch(() => {});
}

interface VoiceCommandContext {
  spaces: SpaceState[];
  activeSpaceId: string;
  activeTabId: string | null;
  sidebarCollapsed: boolean;
  agentPanelOpen: boolean;
}

/**
 * Parse a spoken command and run it. Returns feedback text for the UI,
 * or null when the transcript matched nothing.
 */
export async function runVoiceCommand(
  raw: string,
  ctx: VoiceCommandContext,
): Promise<string | null> {
  const t = raw.toLowerCase().trim().replace(/[.?!,]+$/, "");
  const a = nt();

  const match = (re: RegExp) => re.test(t);
  const rest = (re: RegExp) => t.replace(re, "").trim();

  if (match(/^(open a |open |create )?(new tab|newtab)/)) {
    await a.tabsCreate({});
    return "Opened a new tab.";
  }
  if (match(/^close (this |the |current )?tab/)) {
    if (ctx.activeTabId) {
      await a.tabsClose(ctx.activeTabId);
      return "Closed the current tab.";
    }
    return "There is no active tab to close.";
  }
  if (match(/^go back/)) {
    await a.navBack();
    return "Went back.";
  }
  if (match(/^go forward/)) {
    await a.navForward();
    return "Went forward.";
  }
  if (match(/^(reload|refresh)( the| this)? page?/)) {
    await a.navReload();
    return "Reloaded the page.";
  }
  if (match(/^stop (loading|the page)/)) {
    await a.navStop();
    return "Stopped loading.";
  }
  if (match(/^open settings/)) {
    await a.uiSetSettingsOpen(true);
    return "Opened settings.";
  }
  if (match(/^close settings/)) {
    await a.uiSetSettingsOpen(false);
    return "Closed settings.";
  }
  if (match(/^toggle sidebar/)) {
    await a.uiSetSidebarCollapsed(!ctx.sidebarCollapsed);
    return ctx.sidebarCollapsed ? "Showed the sidebar." : "Hid the sidebar.";
  }
  if (match(/^toggle (agent|copilot)/)) {
    await a.uiSetAgentPanelOpen(!ctx.agentPanelOpen);
    return ctx.agentPanelOpen ? "Closed the agent panel." : "Opened the agent panel.";
  }
  if (match(/^summariz(e|e this page|e the page|e this)/)) {
    await a.agentChat("Summarize the current page", { voice: true });
    return "Asking the agent to summarize this page.";
  }
  if (match(/^(switch to|go to space|open space) /)) {
    const name = rest(/^(switch to|go to space|open space) /);
    let best: { id: string; score: number } | null = null;
    for (const s of ctx.spaces) {
      const score = fuzzy(name, s.name);
      if (score !== null && (!best || score > best.score)) {
        best = { id: s.id, score };
      }
    }
    if (best) {
      await a.spacesSwitch(best.id);
      const space = ctx.spaces.find((s) => s.id === best!.id);
      return `Switched to the ${space?.name ?? "space"}.`;
    }
    return `No space matches “${name}”.`;
  }
  if (match(/^go to /)) {
    const dest = rest(/^go to /);
    if (dest) {
      await a.navGo(dest);
      return `Navigating to ${dest}.`;
    }
  }
  if (match(/^search (for )?/)) {
    const q = rest(/^search (for )?/);
    if (q) {
      await a.navGo(q);
      return `Searching for ${q}.`;
    }
  }
  return null;
}

interface UseVoiceHandlers {
  onCommand: (text: string) => void;
  onDictation: (text: string) => void;
  /** Renderer asks the panel's voice settings: is voice control enabled? */
  isEnabled: () => boolean;
}

interface UseVoiceResult {
  supported: boolean;
  listening: boolean;
  mode: VoiceMode | null;
  /** Live interim transcript while listening. */
  interim: string;
  /** Graceful notice (unsupported / disabled / mic blocked / errors). */
  notice: string | null;
  clearNotice: () => void;
  /**
   * Guided setup card (missing STT model/binary, mic denied). Rendered by
   * the panel instead of a bare exception string.
   */
  guide: VoiceGuide | null;
  clearGuide: () => void;
  /** One-tap Whisper model download; voice starts automatically when ready. */
  downloadSttModel: () => void;
  downloadingStt: boolean;
  /** Explicit opt-in to the Web Speech fallback (sends audio to Google). */
  useWebSpeechFallback: () => void;
  toggleCommand: () => void;
  toggleDictate: () => void;
  /** Start listening without toggling (barge-in entry point). */
  beginCommand: () => void;
  beginDictate: () => void;
  stop: () => void;
}

export function useVoice(handlers: UseVoiceHandlers): UseVoiceResult {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const recRef = useRef<SpeechRecognition | null>(null);
  const localRef = useRef<LocalCapture | null>(null);
  const toggleCommandRef = useRef<() => void>(() => {});
  /** finalizeLocal lives below startLocal; the 90 s cap timer reaches it here. */
  const finalizeLocalRef = useRef<(m: VoiceMode) => Promise<void>>(() => Promise.resolve());
  /** Smoothed mic amplitude (0..1) + last send time for ~15 Hz throttling. */
  const ampLevel = useRef(0);
  const ampSentAt = useRef(0);

  const [listening, setListening] = useState(false);
  const [mode, setMode] = useState<VoiceMode | null>(null);
  const [interim, setInterim] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [localReady, setLocalReady] = useState(false);
  const [guide, setGuide] = useState<VoiceGuide | null>(null);
  const [downloadingStt, setDownloadingStt] = useState(false);
  /** Voice mode the user asked for before the guided setup appeared. */
  const pendingMode = useRef<VoiceMode | null>(null);
  /** Poll timer while waiting for the Whisper download to finish. */
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const webSupported =
    typeof window !== "undefined" &&
    (!!window.webkitSpeechRecognition || !!window.SpeechRecognition);
  const supported = webSupported || localReady;

  // Probe once: is the on-device STT engine available (model downloaded)?
  useEffect(() => {
    let cancelled = false;
    localSttAvailable()
      .then((ok) => {
        if (!cancelled) setLocalReady(ok);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    const session = localRef.current;
    localRef.current = null;
    if (session) {
      teardownLocalSession(session);
      // Hard stop: discard captured audio, never transcribe.
      voiceApi()?.voiceCancelListening().catch(() => {});
    }
    setListening(false);
    setMode(null);
    setInterim("");
    ampLevel.current = 0;
  }, []);

  /** The original Web Speech implementation, kept intact as the fallback. */
  const startWeb = useCallback(
    (nextMode: VoiceMode) => {
      const Ctor = window.webkitSpeechRecognition ?? window.SpeechRecognition;
      if (!Ctor) {
        setNotice(
          "Voice input isn't available here — it needs Chromium's Web Speech API.",
        );
        return;
      }
      stop();
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = nextMode === "dictate";
      rec.maxAlternatives = 1;

      rec.onresult = (e: SpeechRecognitionEvent) => {
        let interimText = "";
        let finalText = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) finalText += transcript;
          else interimText += transcript;
        }
        setInterim(interimText);
        const final = finalText.trim();
        if (!final) return;
        if (nextMode === "command") {
          handlersRef.current.onCommand(final);
        } else {
          handlersRef.current.onDictation(`${final} `);
        }
      };
      rec.onerror = (e: SpeechRecognitionErrorEvent) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          setNotice(MIC_DENIED_NOTICE);
          setGuide({ kind: "mic-denied" });
        } else if (e.error === "no-speech") {
          setNotice("Didn't hear anything — try again.");
        } else if (e.error !== "aborted") {
          setNotice(`Voice error: ${e.error}.`);
        }
        setListening(false);
        setMode(null);
      };
      rec.onend = () => {
        setListening(false);
        setMode(null);
        setInterim("");
        recRef.current = null;
      };

      recRef.current = rec;
      setNotice(null);
      setInterim("");
      setMode(nextMode);
      setListening(true);
      try {
        rec.start();
      } catch {
        setListening(false);
        setMode(null);
        recRef.current = null;
      }
    },
    [stop],
  );

  /**
   * Start the on-device path: capture mic audio, downsample to 16 kHz
   * int16, and stream ~250 ms chunks to the main process. Throws on
   * failure so the caller can fall back to Web Speech. Mic denial is
   * tagged (micDenied) so the caller skips the fallback and just shows
   * the notice — Web Speech would hit the same denial.
   */
  const startLocal = useCallback(async (nextMode: VoiceMode) => {
    const api = voiceApi();
    if (!api) throw new Error("local voice API unavailable");

    // Preferred microphone from Settings → Voice ("" = system default).
    let micDeviceId = "";
    try {
      micDeviceId = (await api.settingsGetVoice()).micDeviceId ?? "";
    } catch {
      /* default device */
    }

    // Let the main process own the macOS mic permission prompt so it is
    // attributed to Next Token (a renderer getUserMedia prompt can be
    // misattributed when the app was launched from a terminal).
    try {
      const res = await api.voiceEnsureMic?.();
      if (res && res.granted === false) throw new Error("mic-denied");
    } catch (e) {
      if (e instanceof Error && e.message === "mic-denied") {
        setNotice(MIC_DENIED_NOTICE);
        setGuide({ kind: "mic-denied" });
        const err = new Error("mic-denied");
        (err as { micDenied?: boolean }).micDenied = true;
        throw err;
      }
      /* main-side check unavailable — fall through to getUserMedia */
    }

    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          micDeviceId ? { audio: { deviceId: { exact: micDeviceId } } } : { audio: true },
        );
      } catch {
        // The saved device may be unplugged — fall back to the default mic.
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch {
      setNotice(MIC_DENIED_NOTICE);
      setGuide({ kind: "mic-denied" });
      const err = new Error("mic-denied");
      (err as { micDenied?: boolean }).micDenied = true;
      throw err;
    }

    const ctx = new AudioContext();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* capture still proceeds */
      }
    }
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but is the only capture primitive that
    // works in Electron without shipping a separate AudioWorklet module.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    // Mute the monitor tap: the processor must stay connected for
    // onaudioprocess to fire, but the mic must not play back.
    const sink = ctx.createGain();
    sink.gain.value = 0;

    let tail: Promise<void> = Promise.resolve();
    const session: LocalCapture = {
      stream,
      ctx,
      source,
      processor,
      chunks: [],
      pendingSamples: 0,
      send(bytes: Uint8Array): Promise<void> {
        tail = tail
          .then(() => api.voiceAudioChunk(bytes))
          .then(
            () => undefined,
            () => undefined, // a failed chunk must not stall later ones
          );
        return tail;
      },
      drain(): Promise<void> {
        return tail;
      },
    };

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (localRef.current !== session) return;
      const input = e.inputBuffer.getChannelData(0);
      // Real mic amplitude: RMS of the raw input, smoothed, throttled to ~15 Hz.
      let sum = 0;
      for (let i = 0; i < input.length; i += 4) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / Math.ceil(input.length / 4));
      ampLevel.current = ampLevel.current * 0.65 + Math.min(1, rms * 3) * 0.35;
      const nowMs = performance.now();
      if (nowMs - ampSentAt.current > 66) {
        ampSentAt.current = nowMs;
        try {
          api.voiceAmplitude(ampLevel.current);
        } catch {
          /* fire-and-forget */
        }
      }
      const down = downsampleTo16k(input, e.inputBuffer.sampleRate);
      session.chunks.push(down);
      session.pendingSamples += down.length;
      if (session.pendingSamples >= LOCAL_CHUNK_SAMPLES) {
        const merged = mergeInt16(session.chunks);
        session.chunks = [];
        session.pendingSamples = 0;
        void session.send(
          new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength),
        );
      }
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    localRef.current = session;

    // 90 s cap on a single utterance: auto-finalize so the mic never runs away.
    session.capTimer = setTimeout(() => {
      if (localRef.current === session) void finalizeLocalRef.current(nextMode);
    }, 90_000);

    try {
      await api.voiceStartListening();
    } catch (e) {
      localRef.current = null;
      teardownLocalSession(session);
      throw e;
    }

    setNotice(null);
    setInterim("");
    setMode(nextMode);
    setListening(true);
  }, []);

  /**
   * Toggle-off for the local path: stop capture, flush remaining audio in
   * order, transcribe, and deliver the transcript to the existing handlers.
   */
  const finalizeLocal = useCallback(async (nextMode: VoiceMode) => {
    const session = localRef.current;
    localRef.current = null;
    const api = voiceApi();
    setListening(false);
    setMode(null);
    setInterim("");
    if (!session || !api) return;

    let rest: Uint8Array | null = null;
    if (session.pendingSamples > 0) {
      const merged = mergeInt16(session.chunks);
      session.chunks = [];
      session.pendingSamples = 0;
      rest = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
    }
    teardownLocalSession(session);

    try {
      if (rest) await session.send(rest);
      await session.drain();
      const result = await api.voiceStopListening();
      const transcript = (result?.text ?? "").trim();
      if (result?.cleaned && result.fillersRemoved > 0) {
        // Flow-style cleanup feedback: "Cleaned up N filler words."
        setNotice(
          `Cleaned up ${result.fillersRemoved} filler word${result.fillersRemoved === 1 ? "" : "s"}.`,
        );
      }
      if (transcript) {
        if (nextMode === "command") {
          handlersRef.current.onCommand(transcript);
        } else {
          handlersRef.current.onDictation(`${transcript} `);
        }
      } else if (!result?.silent) {
        setNotice("Didn't hear anything — try again.");
      }
    } catch (e) {
      // Surface the real engine error — a bare "failed, try again" made the
      // STT pipeline undebuggable (the actual reason only exists in main).
      const detail = e instanceof Error && e.message ? e.message : String(e ?? "");
      setNotice(
        detail
          ? `On-device transcription failed: ${detail}`
          : "On-device transcription failed. Try again.",
      );
    }
  }, []);

  finalizeLocalRef.current = finalizeLocal;

  const start = useCallback(
    async (nextMode: VoiceMode) => {
      if (!handlersRef.current.isEnabled()) {
        setNotice("Voice is turned off. Enable it in Settings → Voice.");
        return;
      }
      stop();
      // A fresh open cancels any in-flight guided setup (the download itself
      // keeps running in the main process; reopening voice later picks it up).
      setGuide(null);
      pendingMode.current = null;
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      if (downloadingStt) setDownloadingStt(false);
      // Prefer the on-device engines when a local STT model is downloaded.
      try {
        if (await localSttAvailable()) {
          await startLocal(nextMode);
          return;
        }
      } catch (e) {
        if ((e as { micDenied?: boolean }).micDenied) return;
        // Any other local failure → guided setup below.
      }
      // No usable on-device STT: show the guided setup card instead of a
      // bare error (and never silently fall back to cloud speech).
      pendingMode.current = nextMode;
      let status: { model: boolean; binary: boolean; binarySteps: string } | null = null;
      try {
        const fn = voiceApi()?.voiceSttStatus;
        if (typeof fn === "function") status = await fn();
      } catch {
        /* fall through to the generic card */
      }
      if (status && status.model && !status.binary) {
        setGuide({ kind: "no-stt-binary", steps: status.binarySteps });
      } else {
        setGuide({ kind: "no-stt-model" });
      }
    },
    [stop, startLocal, downloadingStt],
  );

  /**
   * One-tap Whisper download from the guided setup card. Fire-and-forget
   * IPC (progress/errors arrive via nt.model-event); polls the STT engine
   * until it becomes available, then starts the pending voice mode.
   */
  const downloadSttModel = useCallback(async () => {
    setDownloadingStt(true);
    setNotice(null);
    try {
      await nt().modelsDownload("whisper-base.en");
    } catch {
      setDownloadingStt(false);
      setNotice("Couldn't start the Whisper download. Try again from Settings → Models.");
      return;
    }
    if (pollTimer.current) clearInterval(pollTimer.current);
    let off: (() => void) | undefined;
    try {
      off = nt().onModelEvent((e) => {
        if (e.id !== "whisper-base.en" || e.kind !== "error") return;
        if (pollTimer.current) {
          clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
        off?.();
        setDownloadingStt(false);
        setNotice("Whisper download failed — check Settings → Models for details.");
      });
    } catch {
      /* polling below is the fallback */
    }
    pollTimer.current = setInterval(() => {
      void (async () => {
        let ok = false;
        try {
          ok = await localSttAvailable();
        } catch {
          /* keep polling */
        }
        if (!ok) return;
        if (pollTimer.current) {
          clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
        off?.();
        setDownloadingStt(false);
        setGuide(null);
        const m = pendingMode.current;
        pendingMode.current = null;
        if (m) void start(m);
      })();
    }, 3000);
  }, [start]);

  /** Explicit opt-in to the Web Speech fallback (sends audio to Google). */
  const useWebSpeechFallback = useCallback(() => {
    const m = pendingMode.current ?? "command";
    pendingMode.current = null;
    setGuide(null);
    startWeb(m);
  }, [startWeb]);

  const clearGuide = useCallback(() => {
    setGuide(null);
    pendingMode.current = null;
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (downloadingStt) setDownloadingStt(false);
  }, [downloadingStt]);

  const toggleCommand = useCallback(() => {
    if (listening && mode === "command") {
      if (localRef.current) void finalizeLocal("command");
      else stop();
    } else void start("command");
  }, [listening, mode, start, stop, finalizeLocal]);

  const toggleDictate = useCallback(() => {
    if (listening && mode === "dictate") {
      if (localRef.current) void finalizeLocal("dictate");
      else stop();
    } else void start("dictate");
  }, [listening, mode, start, stop, finalizeLocal]);

  toggleCommandRef.current = toggleCommand;

  // Global hotkey bus: Alt+V or Cmd/Ctrl+Shift+V → command listening.
  useEffect(() => {
    const onToggle = () => toggleCommandRef.current();
    window.addEventListener("nt:voice-toggle", onToggle);
    return () => window.removeEventListener("nt:voice-toggle", onToggle);
  }, []);

  useEffect(
    () => () => {
      stop();
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    },
    [stop],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  // Barge-in entry points: start listening without toggling off first.
  const beginCommand = useCallback(() => {
    if (listening && mode === "command") return;
    void start("command");
  }, [listening, mode, start]);
  const beginDictate = useCallback(() => {
    if (listening && mode === "dictate") return;
    void start("dictate");
  }, [listening, mode, start]);

  return {
    supported,
    listening,
    mode,
    interim,
    notice,
    clearNotice,
    guide,
    clearGuide,
    downloadSttModel,
    downloadingStt,
    useWebSpeechFallback,
    toggleCommand,
    toggleDictate,
    beginCommand,
    beginDictate,
    stop,
  };
}
