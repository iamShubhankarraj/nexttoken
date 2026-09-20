/**
 * VoiceEngine — orchestrates the on-device voice pipeline for the main process.
 *
 * The renderer streams 16 kHz mono int16 PCM via pushAudio() while in the
 * `listening` state; stopListening() writes it to a temp WAV, runs whisper,
 * and returns the transcript. speak() runs sherpa-onnx Kokoro and returns
 * 16 kHz mono WAV bytes.
 *
 * State machine: idle → listening → transcribing → idle for STT;
 * idle → speaking → idle for TTS (always restored in `finally`).
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

export type VoiceEngineState = "idle" | "listening" | "transcribing" | "speaking";

export interface VoiceEngineEvents {
  onState(s: VoiceEngineState): void;
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
}

const SAMPLE_RATE = 16_000;
/** Clips shorter than this are returned as "" without invoking whisper. */
const MIN_LISTEN_SECONDS = 0.4;
const MIN_LISTEN_BYTES = Math.floor(SAMPLE_RATE * MIN_LISTEN_SECONDS) * 2;

export class VoiceEngine {
  private state: VoiceEngineState = "idle";
  private pcm = Buffer.alloc(0);
  private readonly stt: SttEngine;
  private readonly tts: TtsEngine;
  /** Serialises concurrent speak() calls so audio never overlaps. */
  private speakTail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: VoiceEngineOptions) {
    this.stt = new SttEngine(opts);
    this.tts = new TtsEngine(opts);
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
   * Stop capture, transcribe, and return the transcript.
   * Returns "" for clips under 0.4 s without invoking whisper.
   * Throws a clear error when no STT model is downloaded.
   */
  async stopListening(): Promise<string> {
    if (this.state !== "listening") return "";
    const audio = this.pcm;
    this.pcm = Buffer.alloc(0);

    if (audio.length < MIN_LISTEN_BYTES) {
      this.setState("idle");
      return "";
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
      return await this.stt.transcribe(wavPath, modelFile);
    } finally {
      await fs.rm(wavPath, { force: true }).catch(() => {});
      this.setState("idle");
    }
  }

  /** Discard captured audio and return to idle. In-flight transcription (if any) is left to finish. */
  cancelListening(): void {
    if (this.state !== "listening") return;
    this.pcm = Buffer.alloc(0);
    this.setState("idle");
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
