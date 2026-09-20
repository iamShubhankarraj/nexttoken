import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { DownloadEvent, ModelEntry } from './types';

/**
 * Streams model files from direct URLs (HuggingFace `resolve` URLs) into
 * `modelsDir`, with resume, redirect-following, throttled progress events,
 * atomic rename, and optional SHA-256 verification. No external dependencies.
 *
 * Layout inside `modelsDir`:
 *   <id>.gguf          chat / vision model file (extension taken from the URL)
 *   <id>.bin           stt model file
 *   <id>.mmproj.gguf   vision mmproj companion
 *   <id>.part          in-progress download, resumed via Range on next run
 *   <id>/              tts bundle directory (kokoro: onnx + voices + tokens)
 *
 * For entries with multiple files (vision mmproj, tts companions) the files
 * download sequentially and progress events are emitted under the same `id`.
 */

const MAX_REDIRECTS = 10;
const PROGRESS_THROTTLE_MS = 250; // ~4 progress events/sec
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Companion files downloaded alongside the main URL for a tts entry.
 * Resolved against the directory of `entry.url` (same HF repo).
 * sherpa-onnx's kokoro config also needs an espeak-ng-data directory, which
 * is not a single downloadable file; it must be provisioned at runtime.
 */
const TTS_COMPANION_FILES: Record<string, string[]> = {
  'kokoro-82m': ['voices-v1.0.bin', 'tokens.txt'],
};

interface FileJob {
  url: string;
  target: string;   // final path (without .part)
  sha256?: string;
}

interface ActiveDownload {
  req: http.ClientRequest | null;
  file: fs.WriteStream | null;
  cancelled: boolean;
}

function fileNameFromUrl(url: string): string {
  const u = new URL(url);
  const base = path.posix.basename(u.pathname);
  if (!base) throw new Error(`Cannot determine a file name from URL: ${url}`);
  return base;
}

function urlDir(url: string): string {
  const u = new URL(url);
  const dir = path.posix.dirname(u.pathname);
  return `${u.origin}${dir === '/' ? '' : dir}`;
}

/** Final on-disk path for an entry's main file. */
export function targetPathFor(modelsDir: string, entry: ModelEntry): string {
  const base = fileNameFromUrl(entry.url);
  if (entry.task === 'tts') {
    return path.join(modelsDir, entry.id, base);
  }
  const ext = path.extname(base) || (entry.task === 'stt' ? '.bin' : '.gguf');
  return path.join(modelsDir, `${entry.id}${ext}`);
}

function mmprojPathFor(modelsDir: string, entry: ModelEntry): string {
  const base = fileNameFromUrl(entry.mmprojUrl!);
  const ext = path.extname(base) || '.gguf';
  return path.join(modelsDir, `${entry.id}.mmproj${ext}`);
}

function jobsFor(modelsDir: string, entry: ModelEntry): FileJob[] {
  const jobs: FileJob[] = [{ url: entry.url, target: targetPathFor(modelsDir, entry), sha256: entry.sha256 }];
  if (entry.mmprojUrl) {
    jobs.push({ url: entry.mmprojUrl, target: mmprojPathFor(modelsDir, entry), sha256: entry.mmprojSha256 });
  }
  for (const companion of TTS_COMPANION_FILES[entry.id] ?? []) {
    jobs.push({ url: `${urlDir(entry.url)}/${companion}`, target: path.join(modelsDir, entry.id, companion) });
  }
  return jobs;
}

function getClient(url: string): typeof http | typeof https {
  return new URL(url).protocol === 'https:' ? https : http;
}

export class ModelDownloader {
  private readonly modelsDir: string;
  private readonly onEvent: (e: DownloadEvent) => void;
  private readonly active = new Map<string, ActiveDownload>();

  constructor(opts: { modelsDir: string; onEvent: (e: DownloadEvent) => void }) {
    this.modelsDir = opts.modelsDir;
    this.onEvent = opts.onEvent;
  }

  /**
   * Download an entry's files (main + mmproj for vision + companions for tts).
   * Files that already exist with a non-zero size are skipped. Resumes from a
   * `<target>.part` file when the server honors Range (206); otherwise the
   * partial file is discarded and the download restarts.
   */
  async download(entry: ModelEntry): Promise<void> {
    fs.mkdirSync(this.modelsDir, { recursive: true });
    if (this.active.has(entry.id)) return; // already downloading
    const active: ActiveDownload = { req: null, file: null, cancelled: false };
    this.active.set(entry.id, active);
    try {
      for (const job of jobsFor(this.modelsDir, entry)) {
        if (active.cancelled) throw new Error('Download cancelled');
        await this.downloadFile(entry.id, job, active);
      }
      this.onEvent({ kind: 'done', id: entry.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!active.cancelled) {
        this.onEvent({ kind: 'error', id: entry.id, error: message });
      }
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.active.delete(entry.id);
    }
  }

  /** Abort an in-flight download. The partial `.part` file is kept for resume. */
  cancel(id: string): void {
    const active = this.active.get(id);
    if (!active) return;
    active.cancelled = true;
    try { active.req?.destroy(); } catch { /* ignore */ }
    try { active.file?.destroy(); } catch { /* ignore */ }
  }

  /** Delete an entry's files (model, mmproj, tts bundle dir, partials). */
  async remove(id: string): Promise<void> {
    this.cancel(id);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.modelsDir);
    } catch {
      return; // nothing downloaded yet
    }
    for (const name of entries) {
      if (name !== id && !name.startsWith(`${id}.`)) continue;
      await fs.promises.rm(path.join(this.modelsDir, name), { recursive: true, force: true });
    }
  }

  /** Bytes of the partial or complete file(s) currently on disk for `id`. */
  downloadedBytes(id: string): number {
    let total = 0;
    let entries: string[];
    try {
      entries = fs.readdirSync(this.modelsDir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      if (name !== id && !name.startsWith(`${id}.`)) continue;
      const full = path.join(this.modelsDir, name);
      total += dirSizeSync(full);
    }
    return total;
  }

  /** Total bytes under modelsDir (all models, partials included). */
  async diskUsage(): Promise<number> {
    return dirSize(this.modelsDir);
  }

  // -- internals ------------------------------------------------------------

  private downloadFile(id: string, job: FileJob, active: ActiveDownload): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      const partPath = `${job.target}.part`;
      let resumeFrom = 0;
      try {
        const st = fs.statSync(partPath);
        resumeFrom = st.size;
      } catch { /* no partial file */ }

      // Already have the complete file — skip.
      try {
        const st = fs.statSync(job.target);
        if (st.size > 0) return done();
      } catch { /* not present */ }

      fs.mkdirSync(path.dirname(job.target), { recursive: true });

      const finishPart = (hash: crypto.Hash, received: number, total: number | null): void => {
        try {
          if (total !== null && received !== total) {
            throw new Error(`Download truncated: received ${received} of ${total} bytes`);
          }
          if (job.sha256) {
            const digest = hash.digest('hex');
            if (digest.toLowerCase() !== job.sha256.toLowerCase()) {
              try { fs.unlinkSync(partPath); } catch { /* ignore */ }
              throw new Error('SHA-256 checksum mismatch — file deleted');
            }
          }
          fs.renameSync(partPath, job.target); // atomic on the same volume
          done();
        } catch (e) {
          done(e instanceof Error ? e : new Error(String(e)));
        }
      };

      const request = (url: string, redirectsLeft: number, startByte: number): void => {
        if (active.cancelled) return done(new Error('Download cancelled'));
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return done(new Error(`Invalid download URL: ${url}`));
        }

        const headers: Record<string, string> = {
          'User-Agent': 'next-token-model-downloader/1.0',
          'Accept': '*/*',
        };
        if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

        const req = getClient(url).get(url, { headers }, (res) => {
          // Follow redirects (HuggingFace resolve URLs 302 to a CDN).
          if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
            const loc = res.headers.location;
            res.resume();
            if (!loc) return done(new Error(`Redirect with no Location from ${url}`));
            if (redirectsLeft <= 0) return done(new Error(`Too many redirects for ${job.url}`));
            request(new URL(loc, parsed).toString(), redirectsLeft - 1, startByte);
            return;
          }

          if (res.statusCode === 416) {
            // Our partial file is bigger than the remote — start over.
            res.resume();
            try { fs.unlinkSync(partPath); } catch { /* ignore */ }
            request(url, redirectsLeft, 0);
            return;
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return done(new Error(`Download failed for ${job.url}: HTTP ${res.statusCode ?? 'unknown'}`));
          }

          const resumed = res.statusCode === 206;
          if (!resumed && startByte > 0) {
            // Server ignored Range — discard the partial file and restart.
            try { fs.unlinkSync(partPath); } catch { /* ignore */ }
            startByte = 0;
          }
          const contentLength = res.headers['content-length'] ? Number(res.headers['content-length']) : NaN;
          const total = Number.isFinite(contentLength) ? startByte + contentLength : null;

          const hash = crypto.createHash('sha256');
          const file = fs.createWriteStream(partPath, { flags: resumed ? 'a' : 'w' });
          active.file = file;

          let received = startByte;
          let lastEmit = 0;
          const emitProgress = (force = false) => {
            const now = Date.now();
            if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
            lastEmit = now;
            this.onEvent({ kind: 'progress', id, bytesDownloaded: received, totalBytes: total ?? 0 });
          };

          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            hash.update(chunk);
            emitProgress();
          });
          // Pipe streams bytes to disk (with backpressure); 'finish' fires
          // once everything is flushed, which is when we finalize the part.
          res.pipe(file);
          file.on('finish', () => {
            emitProgress(true);
            finishPart(hash, received, total);
          });
          res.on('error', (e) => {
            file.destroy();
            if (active.cancelled) return done(new Error('Download cancelled'));
            done(new Error(`Network error downloading ${job.url}: ${e.message}`));
          });
          file.on('error', (e) => {
            res.destroy();
            if (active.cancelled) return done(new Error('Download cancelled'));
            done(new Error(`Write error for ${job.target}: ${e.message}`));
          });
        });

        req.on('timeout', () => {
          req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${job.url}`));
        });
        req.on('error', (e) => {
          if (active.cancelled) return done(new Error('Download cancelled'));
          done(new Error(`Network error downloading ${job.url}: ${e.message}`));
        });
        req.setTimeout(REQUEST_TIMEOUT_MS);
        active.req = req;
      };

      request(job.url, MAX_REDIRECTS, resumeFrom);
    });
  }
}

function dirSizeSync(p: string): number {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const name of fs.readdirSync(p)) {
      total += dirSizeSync(path.join(p, name));
    }
    return total;
  } catch {
    return 0;
  }
}

async function dirSize(p: string): Promise<number> {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    const names = await fs.promises.readdir(p);
    for (const name of names) {
      total += await dirSize(path.join(p, name));
    }
    return total;
  } catch {
    return 0;
  }
}
