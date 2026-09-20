/**
 * VoiceEngine — orchestrates the on-device voice pipeline for the main process.
 *
 * The renderer streams 16 kHz mono int16 PCM via pushAudio() while in the
 * `listening` state; stopListening() writes it to a temp WAV, runs whisper,
 * runs the transcript cleanup pipeline (Flow's quick-clean → LLM cleanup
 * pass → vocabulary guard), and returns the result. speak() runs sherpa-onnx
 * Kokoro and returns 16 kHz mono WAV bytes.
 *
 * State machine: idle → listening → transcribing → thinking → idle for
 * STT+agent turns; idle → speaking → idle for TTS (always restored in
 * `finally`). "thinking" is set by the caller (main) around the agent/brain
 * turn that follows transcription.
 *
 * Wiring note (for the integrator): construct one VoiceEngine in main,
 * register the `nt.voice.*` IPC handlers against its methods, and supply
 * getSttModelFile()/getTtsModelDir() from the model registry
 * (src/main/models, owned by the models agent).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SttEngine, type EnsureSidecarFn } from "./stt";
import { TtsEngine } from "./tts";
import { encodeWav } from "./wav";
import {
  acceptFormatterOutput,
  countFillersRemoved,
  stripReasoning,
  tryQuickClean,
} from "./cleanup";

export type VoiceEngineState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

export interface VoiceEngineEvents {
  onState(s: VoiceEngineState): void;
  /** Plain-language error for the voice pill (never a stack trace). */
  onError?(message: string): void;
}

export interface CleanupPrompt {
  system: string;
  fewShot: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface VoiceEngineOptions {
  binDir: string;
  modelsDir: string;
  ensureSidecar: EnsureSidecarFn;
  events: VoiceEngineEvents;
  /** Absolute path to the downloaded ggml .bin, or null when none. */
  getSttModelFile(): string | null;
  /** Absolute path to the downloaded Kokoro model dir, or null when none. */
  getTtsModelDir(): string | null;
  /** Cleanup-pass config + Flow's prompt assets (null disables the LLM pass). */
  getCleanupConfig(): {
    enabled: boolean;
    quickCleanMaxWords: number;
    prompts: CleanupPrompt | null;
  };
}

/** Non-streaming LLM completion for the cleanup pass (wired to ModelRouter). */
export type CleanupCompleteFn = (
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
) => Promise<string>;

export interface StopListeningResult {
  /** Final transcript (cleaned when the cleanup pass ran). */
  text: string;
  /** Raw whisper transcript before cleanup. */
  rawText: string;
  /** True when the clip was silent (below the peak threshold). */
  silent: boolean;
  /** True when the text was changed by quick-clean or the LLM pass. */
  cleaned: boolean;
  /** Fillers removed (for the "Cleaned up N fillers" toast). */
  fillersRemoved: number;
}

const SAMPLE_RATE = 16_000;
/** Clips shorter than this are returned as "" without invoking whisper. */
const MIN_LISTEN_SECONDS = 0.4;
const MIN_LISTEN_BYTES = Math.floor(SAMPLE_RATE * MIN_LISTEN_SECONDS) * 2;
/**
 * Silence-peak guard (Flow's SILENCE_PEAK = 1e-4 on f32, scaled to int16).
 * macOS delivers exact zeros when mic permission is denied; whisper
 * hallucinates words (e.g. "gracias") on empty clips, so we never send
 * silent audio to the STT engine.
 */
const SILENCE_PEAK_INT16 = 4;

export class VoiceEngine {
  private state: VoiceEngineState = "idle";
  private pcm = Buffer.alloc(0);
  private readonly stt: SttEngine;
  private readonly tts: TtsEngine;
  private cleanupComplete: CleanupCompleteFn | null = null;
  /** Serialises concurrent speak() calls so audio never overlaps. */
  private speakTail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: VoiceEngineOptions) {
    this.stt = new SttEngine(opts);
    this.tts = new TtsEngine(opts);
  }

  /** Wire the ModelRouter's non-streaming complete() for the cleanup pass. */
  setCleanupComplete(fn: CleanupCompleteFn): void {
    this.cleanupComplete = fn;
  }

  /** Current state (also mirrored to events.onState on every transition). */
  get currentState(): VoiceEngineState {
    return this.state;
  }

  private setState(s: VoiceEngineState): void {
    this.state = s;
    try {
      this.opts.events.onState(s);
    } catch {
      /* event listeners must never break the engine */
    }
  }

  private error(message: string): void {
    try {
      this.opts.events.onError?.(message);
    } catch {
      /* never break the engine */
    }
  }

  /** Begin accumulating PCM via pushAudio(). Resets any previous audio. */
  startListening(): void {
    this.pcm = Buffer.alloc(0);
    this.setState("listening");
  }

  /**
   * Append a 16 kHz mono int16-LE PCM chunk from the renderer.
   * Silently ignored unless currently listening.
   */
  pushAudio(pcm16k: Buffer): void {
    if (this.state !== "listening") return;
    if (!pcm16k || pcm16k.length === 0) return;
    this.pcm = Buffer.concat([this.pcm, pcm16k]);
  }

  /**
   * Stop capture, transcribe, clean up, and return the result.
   * Returns a silent/empty result for clips under 0.4 s or below the
   * silence-peak threshold, without invoking whisper.
   * Throws a clear error when no STT model is downloaded.
   */
  async stopListening(): Promise<StopListeningResult> {
    if (this.state !== "listening") {
      return { text: "", rawText: "", silent: false, cleaned: false, fillersRemoved: 0 };
    }
    const audio = this.pcm;
    this.pcm = Buffer.alloc(0);

    if (audio.length < MIN_LISTEN_BYTES) {
      this.setState("idle");
      return { text: "", rawText: "", silent: true, cleaned: false, fillersRemoved: 0 };
    }
    if (peakInt16(audio) < SILENCE_PEAK_INT16) {
      this.setState("idle");
      this.error("Didn't hear anything — check the mic.");
      return { text: "", rawText: "", silent: true, cleaned: false, fillersRemoved: 0 };
    }

    const modelFile = this.opts.getSttModelFile();
    if (!modelFile) {
      this.setState("idle");
      throw new Error(
        "Voice: no speech-to-text model is downloaded. Download a Whisper model in Settings → Models first.",
      );
    }

    this.setState("transcribing");
    const wavPath = path.join(os.tmpdir(), `nt-voice-${randomUUID()}.wav`);
    try {
      const samples = new Int16Array(
        audio.buffer,
        audio.byteOffset,
        Math.floor(audio.byteLength / 2),
      );
      await fs.writeFile(wavPath, encodeWav(samples, SAMPLE_RATE));
      const raw = await this.stt.transcribe(wavPath, modelFile);
      const cleaned = await this.cleanupTranscript(raw.trim());
      return {
        text: cleaned.text,
        rawText: raw.trim(),
        silent: false,
        cleaned: cleaned.changed,
        fillersRemoved: cleaned.fillersRemoved,
      };
    } finally {
      await fs.rm(wavPath, { force: true }).catch(() => {});
      this.setState("idle");
    }
  }

  /**
   * The cleanup pipeline: quick-clean for short utterances, otherwise the
   * LLM cleanup pass via the active model, guarded by the vocabulary check.
   * Any failure falls back to the raw transcript — cleanup never blocks
   * dictation.
   */
  private async cleanupTranscript(raw: string): Promise<{
    text: string;
    changed: boolean;
    fillersRemoved: number;
  }> {
    const none = { text: raw, changed: false, fillersRemoved: 0 };
    if (!raw) return none;
    const cfg = this.opts.getCleanupConfig();
    if (!cfg.enabled) return none;

    const quick = tryQuickClean(raw, cfg.quickCleanMaxWords, true);
    if (quick !== null) {
      return {
        text: quick,
        changed: quick !== raw,
        fillersRemoved: countFillersRemoved(raw, quick),
      };
    }

    // Quick-clean deferred (long / enumerated / spoken punctuation) —
    // run the LLM pass when prompts and a completion function are wired.
    if (!cfg.prompts || !this.cleanupComplete) return none;
    try {
      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: cfg.prompts.system },
      ];
      for (const m of cfg.prompts.fewShot) messages.push({ ...m });
      messages.push({ role: "user", content: raw });
      const out = stripReasoning(await this.cleanupComplete(messages)).trim();
      if (!acceptFormatterOutput(raw, out)) return none; // guard: model slipped into assistant mode
      return {
        text: out,
        changed: out !== raw,
        fillersRemoved: countFillersRemoved(raw, out),
      };
    } catch {
      return none; // dead model / rate limit never blocks dictation
    }
  }

  /** Discard captured audio and return to idle. In-flight transcription (if any) is left to finish. */
  cancelListening(): void {
    if (this.state !== "listening") return;
    this.pcm = Buffer.alloc(0);
    this.setState("idle");
  }

  /**
   * Enter the thinking state while the agent/brain works on a voice turn.
   * Called by main around the post-transcription turn; a no-op unless the
   * engine just finished transcribing (or is idle after a silent clip).
   */
  setThinking(on: boolean): void {
    if (on) {
      if (this.state === "idle" || this.state === "transcribing") {
        this.setState("thinking");
      }
    } else if (this.state === "thinking") {
      this.setState("idle");
    }
  }

  /**
   * Barge-in: stop TTS immediately. The queued synth calls are left to
   * finish silently in the background (their audio is discarded by the
   * renderer, which stops playback); the state flips to idle at once so a
   * new listen can start within ~150 ms.
   */
  stopSpeaking(): void {
    if (this.state === "speaking") this.setState("idle");
  }

  /**
   * Synthesise text to 16 kHz mono WAV bytes. Concurrent calls are queued
   * and run sequentially; each emits speaking → idle around its own run.
   * Throws a clear error when no TTS model is downloaded or text is empty/too long.
   */
  speak(text: string): Promise<Buffer> {
    const run = this.speakTail.then(() => this.doSpeak(text));
    // Keep the queue alive even if one speak() rejects.
    this.speakTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doSpeak(text: string): Promise<Buffer> {
    const modelDir = this.opts.getTtsModelDir();
    if (!modelDir) {
      throw new Error(
        "Voice: no text-to-speech model is downloaded. Download a Kokoro TTS model in Settings → Models first.",
      );
    }
    this.setState("speaking");
    try {
      return await this.tts.speak(text, modelDir);
    } finally {
      this.setState("idle");
    }
  }
}

/** Peak absolute amplitude of an int16-LE PCM buffer. */
function peakInt16(buf: Buffer): number {
  let peak = 0;
  const n = Math.floor(buf.byteLength / 2);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(buf.readInt16LE(i * 2));
    if (v > peak) peak = v;
    if (peak >= SILENCE_PEAK_INT16) break; // early exit — not silent
  }
  return peak;
}
