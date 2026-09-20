/**
 * On-device speech-to-text via the whisper.cpp `whisper-cli` sidecar.
 *
 * Verified CLI flags (ggml-org/whisper.cpp README and usage examples):
 *   -m <model>   path to the ggml .bin model
 *   -f <wav>     16 kHz mono WAV input
 *   -otxt        write a plain-text transcript file
 *   -of <base>   output base name — with -otxt the transcript lands at <base>.txt
 *   --no-timestamps  plain text, no [00:00:00.000 --> ...] prefixes
 *   -np          suppress progress prints on stderr/stdout
 *   -t <n>       thread count
 *
 * Note: the task brief suggested `--output-txt` / `--output-file`; those
 * flags do not exist in whisper.cpp — `-otxt` / `-of` are the real ones.
 * If the transcript file is ever missing (older/newer binary behaviour),
 * we fall back to parsing the timestamped lines whisper.cpp prints to
 * stdout.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Structural copy of the contract in src/main/models/binaries.ts
 * (owned by the models agent). Kept local so this module typechecks
 * independently; the real `ensureSidecar` is assignable to it.
 */
export type EnsureSidecarFn = (
  name: "llama-server" | "whisper-cli" | "sherpa-tts",
  binDir: string,
) => Promise<string>;

export interface SttOptions {
  binDir: string;
  modelsDir: string;
  ensureSidecar: EnsureSidecarFn;
}

/** Hard ceiling for one transcription run (whisper.cpp is CPU-bound). */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export class SttEngine {
  constructor(private readonly opts: SttOptions) {}

  /**
   * Transcribe a 16 kHz mono WAV file with the given ggml model.
   * @param wavPath   absolute path to the input WAV
   * @param modelFile absolute path to the ggml .bin model
   * @returns trimmed transcript (may be "" when nothing was recognised)
   */
  async transcribe(wavPath: string, modelFile: string): Promise<string> {
    try {
      const st = await fs.stat(wavPath);
      if (!st.isFile()) throw new Error(`not a file: ${wavPath}`);
    } catch (e) {
      throw new Error(`STT: audio file not found: ${wavPath}`);
    }
    try {
      const st = await fs.stat(modelFile);
      if (!st.isFile()) throw new Error(`not a file: ${modelFile}`);
    } catch {
      throw new Error(
        `STT: whisper model not found: ${modelFile}. Download an STT model in Settings → Models first.`,
      );
    }

    let bin: string;
    try {
      bin = await this.opts.ensureSidecar("whisper-cli", this.opts.binDir);
    } catch (e) {
      throw new Error(`STT: whisper-cli sidecar unavailable: ${msg(e)}`);
    }
    try {
      await fs.access(bin);
    } catch {
      throw new Error(`STT: whisper-cli binary missing at ${bin}. Re-run sidecar setup.`);
    }

    const outBase = path.join(os.tmpdir(), `nt-whisper-${randomUUID()}`);
    const outTxt = `${outBase}.txt`;
    try {
      const threads = String(Math.max(1, Math.min(8, os.cpus().length)));
      const { stdout } = await execFileAsync(
        bin,
        [
          "-m", modelFile,
          "-f", wavPath,
          "-otxt",
          "-of", outBase,
          "--no-timestamps",
          "-np",
          "-t", threads,
        ],
        { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      );

      try {
        const text = (await fs.readFile(outTxt, "utf8")).trim();
        if (text) return text;
        // Empty file: fall through to stdout parsing rather than
        // returning silence for a non-silent clip.
      } catch {
        /* transcript file missing — parse stdout instead */
      }
      return parseWhisperStdout(stdout ?? "");
    } catch (err) {
      throw normaliseExecError(err, "STT");
    } finally {
      await fs.rm(outTxt, { force: true }).catch(() => {});
    }
  }
}

/**
 * Parse whisper.cpp's stdout into plain text. Handles the timestamped
 * segment lines it prints, e.g.
 *   [00:00:00.000 --> 00:00:02.340]  hello world
 */
function parseWhisperStdout(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*(.*)$/);
    if (m && m[1].trim()) parts.push(m[1].trim());
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Map execFile failures (incl. timeout kill) to clear, user-facing errors. */
export function normaliseExecError(err: unknown, prefix: string): Error {
  const e = err as { killed?: boolean; signal?: string; code?: number | string; message?: string };
  if (e && (e.killed || e.signal === "SIGTERM")) {
    return new Error(`${prefix}: timed out after ${TRANSCRIBE_TIMEOUT_MS / 1000}s — the model may be too large for this machine.`);
  }
  if (e && typeof e.code === "number" && e.code !== 0) {
    return new Error(`${prefix}: engine exited with code ${e.code}: ${e.message ?? "no output"}`);
  }
  return new Error(`${prefix}: engine failed: ${msg(err)}`);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
