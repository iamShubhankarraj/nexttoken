/**
 * On-device text-to-speech via the sherpa-onnx `sherpa-onnx-offline-tts`
 * sidecar with a Kokoro model.
 *
 * Verified CLI flags (k2-fsa/sherpa-onnx docs, "Kokoro" page):
 *   --kokoro-model=<model.onnx>
 *   --kokoro-voices=<voices.bin>
 *   --kokoro-tokens=<tokens.txt>
 *   --kokoro-data-dir=<espeak-ng-data/>      (optional but recommended)
 *   --kokoro-dict-dir=<dict/>                (optional, multi-lang packs)
 *   --kokoro-lexicon=<a.txt,b.txt>           (optional, comma-separated)
 *   --num-threads=<n>
 *   --sid=<speaker id>                       (default 0)
 *   --output-filename=<out.wav>
 *   <text>                                   (final positional argument)
 *
 * Kokoro emits 24 kHz mono WAV; we resample to 16 kHz mono WAV bytes.
 * Long text is split into ~400-char sentence chunks, each synthesised
 * separately, then concatenated. Input is capped at 2000 chars.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { concatWav, decodePcm16, encodeWav, resamplePcm16 } from "./wav";
import { normaliseExecError, type EnsureSidecarFn } from "./stt";

const execFileAsync = promisify(execFile);

export interface TtsOptions {
  binDir: string;
  modelsDir: string;
  ensureSidecar: EnsureSidecarFn;
}

/** Refuse anything longer — synthesis time and RAM grow with input. */
const MAX_TTS_CHARS = 2000;
/** Chunk target: keeps each sherpa invocation fast and bounded. */
const CHUNK_CHARS = 400;
/** Per-chunk synthesis ceiling. */
const CHUNK_TIMEOUT_MS = 120_000;
/** We always return 16 kHz mono, matching the STT side. */
const OUT_SAMPLE_RATE = 16_000;

export class TtsEngine {
  constructor(private readonly opts: TtsOptions) {}

  /**
   * Synthesise text to 16 kHz mono WAV bytes.
   * @param text     text to speak (1–2000 chars after trimming)
   * @param modelDir absolute path to the downloaded Kokoro model dir
   * @param signal   optional abort: barge-in kills the in-flight synth child
   */
  async speak(text: string, modelDir: string, signal?: AbortSignal): Promise<Buffer> {
    const clean = text.trim().replace(/\s+/g, " ");
    if (!clean) {
      throw new Error("TTS: nothing to speak (empty text).");
    }
    if (clean.length > MAX_TTS_CHARS) {
      throw new Error(
        `TTS: text is ${clean.length} chars, over the ${MAX_TTS_CHARS}-char limit. Split it into smaller pieces.`,
      );
    }

    const files = await resolveKokoroFiles(modelDir);

    let bin: string;
    try {
      bin = await this.opts.ensureSidecar("sherpa-tts", this.opts.binDir);
    } catch (e) {
      throw new Error(`TTS: sherpa-onnx sidecar unavailable: ${msg(e)}`);
    }
    try {
      await fs.access(bin);
    } catch {
      throw new Error(`TTS: sherpa-onnx TTS binary missing at ${bin}. Re-run sidecar setup.`);
    }

    const chunks = splitIntoChunks(clean, CHUNK_CHARS);
    const tempFiles: string[] = [];
    try {
      const wavs: Buffer[] = [];
      for (const chunk of chunks) {
        signal?.throwIfAborted();
        const outWav = path.join(os.tmpdir(), `nt-tts-${randomUUID()}.wav`);
        tempFiles.push(outWav);
        await synthChunk(bin, files, chunk, outWav, signal);
        const raw = await fs.readFile(outWav);
        const { pcm, sampleRate } = decodePcm16(raw);
        if (pcm.length === 0) {
          throw new Error("TTS: engine produced empty audio for a chunk.");
        }
        wavs.push(encodeWav(resamplePcm16(pcm, sampleRate, OUT_SAMPLE_RATE), OUT_SAMPLE_RATE));
      }
      return concatWav(wavs);
    } finally {
      await Promise.all(tempFiles.map((f) => fs.rm(f, { force: true }).catch(() => {})));
    }
  }
}

/** Resolved Kokoro model files inside a downloaded model directory. */
interface KokoroFiles {
  model: string;
  voices: string;
  tokens: string;
  dataDir: string;
  dictDir?: string;
  lexicons: string[];
}

/**
 * Locate the files the sherpa-onnx Kokoro recipe needs inside the model
 * dir. Searches recursively because the catalog may preserve the upstream
 * archive layout. Throws a clear error naming the missing piece.
 */
async function resolveKokoroFiles(dir: string): Promise<KokoroFiles> {
  let entries: Array<{ p: string; isDir: boolean }>;
  try {
    entries = await walk(dir);
  } catch {
    throw new Error(
      `TTS: model directory not found: ${dir}. Download a Kokoro TTS model in Settings → Models first.`,
    );
  }
  const files = entries.filter((e) => !e.isDir).map((e) => e.p);
  const pick = (re: RegExp, label: string): string => {
    const hit = files.find((p) => re.test(p));
    if (!hit) {
      throw new Error(
        `TTS: ${label} not found under ${dir} — the downloaded model looks incomplete. Re-download the Kokoro TTS model.`,
      );
    }
    return hit;
  };

  // Prefer the canonical name, fall back to any .onnx (e.g. model.int8.onnx).
  const model =
    files.find((p) => /(^|\/)model\.onnx$/.test(p)) ?? pick(/\.onnx$/i, "Kokoro ONNX model (*.onnx)");
  const voices = pick(/(^|\/)voices[^/]*\.bin$/i, "Kokoro voices file (voices*.bin)");
  const tokens = pick(/(^|\/)tokens\.txt$/i, "Kokoro tokens file (tokens.txt)");

  // GAP (documented 2026-09-21): sherpa-onnx's Kokoro engine also needs the
  // espeak-ng-data directory (phonemizer data), but the model downloader
  // only fetches single files (kokoro-v1.0.onnx, voices-v1.0.bin,
  // tokens.txt) — never this directory. Until the downloader ships it,
  // fail here with a clear, human-readable error instead of letting the
  // sidecar die cryptically on a missing --kokoro-data-dir.
  const dataDirEntry = entries.find((e) => e.isDir && /(^|\/)espeak-ng-data$/.test(e.p));
  if (!dataDirEntry) {
    throw new Error(
      `TTS: the espeak-ng-data directory is missing under ${dir}. ` +
        `sherpa-onnx's Kokoro engine needs these phonemizer data files, and the model downloader does not fetch them yet. ` +
        `To fix: download a Kokoro model tarball from the sherpa-onnx releases (k2-fsa/sherpa-onnx, tts-models tag), ` +
        `copy its espeak-ng-data folder to ${path.join(dir, "espeak-ng-data")}, and try again.`,
    );
  }
  const dataDir = dataDirEntry.p;
  const dictDir = entries.find((e) => e.isDir && /(^|\/)dict$/.test(e.p))?.p;
  const lexicons = files.filter((p) => /(^|\/)lexicon[^/]*\.txt$/i.test(p));

  return { model, voices, tokens, dataDir, dictDir, lexicons };
}

/** Recursive directory walk returning absolute paths. */
async function walk(dir: string): Promise<Array<{ p: string; isDir: boolean }>> {
  const out: Array<{ p: string; isDir: boolean }> = [];
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ p, isDir: true });
      out.push(...(await walk(p)));
    } else if (e.isFile()) {
      out.push({ p, isDir: false });
    }
  }
  return out;
}

async function synthChunk(
  bin: string,
  files: KokoroFiles,
  text: string,
  outWav: string,
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    `--kokoro-model=${files.model}`,
    `--kokoro-voices=${files.voices}`,
    `--kokoro-tokens=${files.tokens}`,
    `--kokoro-data-dir=${files.dataDir}`,
    "--num-threads=2",
    "--sid=0",
    `--output-filename=${outWav}`,
  ];
  if (files.dictDir) args.push(`--kokoro-dict-dir=${files.dictDir}`);
  if (files.lexicons.length > 0) args.push(`--kokoro-lexicon=${files.lexicons.join(",")}`);
  args.push(text);

  try {
    // The abort signal kills the sherpa-onnx child on barge-in — no zombie
    // synth keeps the CPU busy after the user interrupted.
    await execFileAsync(bin, args, {
      timeout: CHUNK_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw normaliseExecError(err, "TTS");
  }
  try {
    await fs.access(outWav);
  } catch {
    throw new Error("TTS: engine ran but produced no output WAV.");
  }
}

/**
 * Split text into chunks of at most maxLen chars, preferring sentence
 * boundaries; over-long sentences are split at word boundaries.
 */
export function splitIntoChunks(text: string, maxLen: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];

  const sentences = normalized.split(/(?<=[.!?…])\s+/);
  const chunks: string[] = [];
  let cur = "";

  const pushChunk = (s: string) => {
    const t = s.trim();
    if (!t) return;
    if (t.length <= maxLen) {
      chunks.push(t);
      return;
    }
    // Over-long sentence: hard-split at word boundaries.
    const words = t.split(" ");
    let w = "";
    for (const word of words) {
      const candidate = w ? `${w} ${word}` : word;
      if (candidate.length > maxLen) {
        if (w) chunks.push(w);
        w = word;
      } else {
        w = candidate;
      }
    }
    if (w) chunks.push(w);
  };

  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    const candidate = cur ? `${cur} ${t}` : t;
    if (candidate.length <= maxLen) {
      cur = candidate;
    } else {
      pushChunk(cur);
      cur = t;
    }
  }
  pushChunk(cur);
  return chunks;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
