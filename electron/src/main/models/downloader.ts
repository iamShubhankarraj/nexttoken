import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import type { DownloadEvent, ModelEntry } from './types';
import { getHfToken } from './hfToken';

/**
 * Streams model files from direct URLs (HuggingFace `resolve` URLs and
 * GitHub release assets) into `modelsDir`, with resume, redirect-following,
 * retries with backoff on transient failures, throttled progress events,
 * atomic rename, and optional SHA-256 verification. No external dependencies.
 *
 * Layout inside `modelsDir`:
 *   <id>.gguf          chat / vision model file (extension taken from the URL)
 *   <id>.bin           stt model file
 *   <id>.mmproj.gguf   vision mmproj companion
 *   <id>.part          in-progress download, resumed via Range on next run
 *   <id>/              tts bundle directory (kokoro: extracted release
 *                      tarballs — model.onnx, voices.bin, tokens.txt,
 *                      espeak-ng-data/)
 *   <id>/.downloads/   in-progress archive downloads (deleted after extract)
 *
 * For entries with multiple files (vision mmproj, tts archives) the files
 * download sequentially and progress events are emitted under the same `id`.
 */

const MAX_REDIRECTS = 10;
const PROGRESS_THROTTLE_MS = 250; // ~4 progress events/sec
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Archive bundles downloaded + extracted for a tts entry.
 *
 * Kokoro's sherpa-onnx recipe needs model.onnx, voices.bin, tokens.txt AND
 * the espeak-ng-data phonemizer directory. The old catalog pointed at a
 * single kokoro-v1.0.onnx URL that 404s (hexgrad/Kokoro-82M only publishes
 * PyTorch .pth); these release tarballs are the working source, verified
 * HTTP 200 on 2026-09-21. `present` is the marker that proves the archive's
 * contents are already extracted, so re-downloads are skipped.
 */
const TTS_ARCHIVES: Record<string, Array<{ url: string; present: RegExp }>> = {
  'kokoro-82m': [
    {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2',
      present: /\.onnx$/i,
    },
    {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.bz2',
      // The kokoro tarball usually bundles espeak-ng-data already; when it
      // does, this marker is present after the first extraction and the
      // second download is skipped.
      present: /(^|[/\\])espeak-ng-data$/,
    },
  ],
};

interface FileJob {
  url: string;
  target: string;   // final path (without .part)
  sha256?: string;
  /**
   * When set, the download is an archive: after a successful download it is
   * extracted into `extractDir` (macOS /usr/bin/tar or unzip, no new deps)
   * and the archive file is deleted. `present` proves the contents are
   * already there, so the job is skipped on re-runs.
   */
  archive?: { extractDir: string; present: RegExp };
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

/** Final on-disk path for an entry's main file. */
export function targetPathFor(modelsDir: string, entry: ModelEntry): string {
  const base = fileNameFromUrl(entry.url);
  if (entry.task === 'tts') {
    return path.join(modelsDir, entry.id, base);
  }
  const ext = path.extname(base) || (entry.task === 'stt' ? '.bin' : '.gguf');
  return path.join(modelsDir, `${entry.id}${ext}`);
}

/** Final on-disk path for a vision entry's mmproj file. Exported so the
 *  llama-server runtime resolves the exact same path the downloader writes. */
export function mmprojPathFor(modelsDir: string, entry: ModelEntry): string {
  const base = fileNameFromUrl(entry.mmprojUrl!);
  const ext = path.extname(base) || '.gguf';
  return path.join(modelsDir, `${entry.id}.mmproj${ext}`);
}

function jobsFor(modelsDir: string, entry: ModelEntry): FileJob[] {
  // TTS entries download archive bundles (kokoro release tarballs), not the
  // single `entry.url` file — see TTS_ARCHIVES above.
  const ttsArchives = TTS_ARCHIVES[entry.id];
  if (entry.task === 'tts' && ttsArchives) {
    const dir = path.join(modelsDir, entry.id);
    return ttsArchives.map(({ url, present }) => ({
      url,
      target: path.join(dir, '.downloads', fileNameFromUrl(url)),
      archive: { extractDir: dir, present },
    }));
  }
  const jobs: FileJob[] = [{ url: entry.url, target: targetPathFor(modelsDir, entry), sha256: entry.sha256 }];
  if (entry.mmprojUrl) {
    jobs.push({ url: entry.mmprojUrl, target: mmprojPathFor(modelsDir, entry), sha256: entry.mmprojSha256 });
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
   * Download an entry's files (main + mmproj for vision + extracted archives
   * for tts). Files that already exist with a non-zero size are skipped.
   * Resumes from a `<target>.part` file when the server honors Range (206);
   * otherwise the partial file is discarded and the download restarts.
   * Transient failures (network blips, timeouts, HTTP 5xx/429) are retried
   * with exponential backoff; permanent ones (404, 401/403, checksum
   * mismatch) fail fast with a human-readable message.
   */
  async download(entry: ModelEntry): Promise<void> {
    const active: ActiveDownload = { req: null, file: null, cancelled: false };
    if (this.active.has(entry.id)) return; // already downloading
    this.active.set(entry.id, active);
    try {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      for (const job of jobsFor(this.modelsDir, entry)) {
        if (active.cancelled) throw new Error('Download cancelled');
        await this.downloadWithRetry(entry.id, job, active);
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

  /**
   * Download a single archive (target URL) into `target` (inside a
   * `.downloads` dir), extract it into `extractDir`, then delete the
   * archive. Skips everything when `present` already matches inside
   * `extractDir`. Used for one-off repairs like espeak-ng-data — not part
   * of any catalog entry's job list.
   */
  async downloadArchive(
    target: string,
    url: string,
    extractDir: string,
    present: RegExp,
  ): Promise<void> {
    if (archiveMarkerPresent(extractDir, present)) return;
    const id = `repair-${Date.now()}`;
    const active: ActiveDownload = { req: null, file: null, cancelled: false };
    const job: FileJob = { url, target, archive: { extractDir, present } };
    try {
      await this.downloadWithRetry(id, job, active);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Couldn't fetch the missing TTS data (${message})`);
    } finally {
      try { fs.rmSync(path.dirname(target), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** Abort an in-flight download. The partial `.part` file is kept for resume. */
  cancel(id: string): void {
    const active = this.active.get(id);
    if (!active) return;
    active.cancelled = true;
    try { active.req?.destroy(); } catch { /* ignore */ }
    try { active.file?.destroy(); } catch { /* ignore */ }
    // Main's progress map is cleared on any non-progress event; emitting here
    // means a fresh Download click starts over instead of hitting the stale
    // "already downloading" guard. The panel treats 'cancelled' as a quiet
    // state reset, not a red error.
    this.onEvent({ kind: 'error', id, error: 'Download cancelled' });
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

  /**
   * Download one file job, retrying transient failures with exponential
   * backoff (2s, 4s, 8s + jitter, max 4 attempts). Resume picks up from the
   * kept `.part` file, so a retry rarely re-downloads from zero.
   */
  private async downloadWithRetry(id: string, job: FileJob, active: ActiveDownload): Promise<void> {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.downloadFile(id, job, active);
        return;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (active.cancelled || attempt >= MAX_ATTEMPTS || !isTransientDownloadError(e)) {
          throw e;
        }
        const backoffMs = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
        await sleep(backoffMs);
      }
    }
  }

  private downloadFile(id: string, job: FileJob, active: ActiveDownload): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      // Archive jobs: skip when the extracted marker is already present.
      if (job.archive && archiveMarkerPresent(job.archive.extractDir, job.archive.present)) {
        return done();
      }

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
            throw new Error(`Download truncated: received ${received} of ${total} bytes — will retry`);
          }
          if (job.sha256) {
            const digest = hash.digest('hex');
            if (digest.toLowerCase() !== job.sha256.toLowerCase()) {
              try { fs.unlinkSync(partPath); } catch { /* ignore */ }
              throw new Error('SHA-256 checksum mismatch — file deleted');
            }
          }
          fs.renameSync(partPath, job.target); // atomic on the same volume
          if (job.archive) {
            // A corrupt archive can't be repaired by re-extracting: drop it
            // so the retry path downloads it fresh.
            try {
              extractArchiveSync(job.target, job.archive.extractDir);
            } catch (e) {
              try { fs.unlinkSync(job.target); } catch { /* ignore */ }
              throw e;
            }
            try { fs.unlinkSync(job.target); } catch { /* ignore */ }
          }
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
        // Gated Hugging Face repos need the user's token (Settings → Models).
        // Only sent to huggingface.co itself — never to redirect targets
        // (the CDN URLs are signed and don't need it).
        if (parsed.hostname === 'huggingface.co' || parsed.hostname.endsWith('.huggingface.co')) {
          const token = getHfToken();
          if (token) headers['Authorization'] = `Bearer ${token}`;
        }

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
            return done(friendlyHttpError(res.statusCode ?? 0, job.url));
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * URL of the standalone espeak-ng-data tarball (sherpa-onnx tts-models tag).
 * This is the phonemizer data sherpa-onnx's Kokoro engine needs; the kokoro
 * tarball usually bundles it, but manually placed models often lack it —
 * which used to surface as a cryptic TTS failure.
 */
export const ESPEAK_NG_DATA_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.bz2';

/**
 * Make sure `espeak-ng-data/` exists inside a Kokoro model dir (searches
 * recursively, since manually placed models nest it). Downloads + extracts
 * the standalone tarball when missing. No-op when already present.
 * Throws a human-readable error on download failure.
 */
export async function ensureEspeakNgData(modelDir: string): Promise<void> {
  if (archiveMarkerPresent(modelDir, /(^|[/\\])espeak-ng-data$/)) return;
  const target = path.join(modelDir, '.downloads', fileNameFromUrl(ESPEAK_NG_DATA_URL));
  const downloader = new ModelDownloader({ modelsDir: path.dirname(modelDir), onEvent: () => {} });
  await downloader.downloadArchive(target, ESPEAK_NG_DATA_URL, modelDir, /(^|[/\\])espeak-ng-data$/);
}

/**
 * Human-readable errors for HTTP failures. 401/403 almost always means the
 * HuggingFace repo is access-gated (license acceptance + token required) —
 * Next Token has no token support, so say so plainly instead of dumping a
 * raw status code on the user.
 */
function friendlyHttpError(status: number, url: string): Error {
  if (status === 401 || status === 403) {
    return new Error(
      'This model is access-gated on Hugging Face — add an HF token in Settings → Models, or choose an ungated model.'
    );
  }
  if (status === 404) {
    return new Error(
      `Download failed (HTTP 404): file not found at ${url} — the catalog link looks outdated.`
    );
  }
  if (status === 429) {
    return new Error(`Download rate-limited (HTTP 429) — retrying…`);
  }
  if (status >= 500) {
    return new Error(`Download failed (HTTP ${status}): server error — retrying…`);
  }
  return new Error(`Download failed for ${url}: HTTP ${status || 'unknown'}`);
}

/** Retryable: network blips, timeouts, rate limits, 5xx, truncated bodies, bad archives. */
function isTransientDownloadError(e: Error): boolean {
  const m = e.message;
  if (/cancelled/i.test(m)) return false;
  if (/access-gated|file not found at|checksum mismatch|invalid download url|too many redirects/i.test(m)) {
    return false;
  }
  return /network error|timed out|stalled|HTTP 429|HTTP 5\d\d|server error — retrying|truncated|will retry|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|failed to extract/i.test(m);
}

/** Depth-limited recursive walk looking for a path matching `present`. */
function archiveMarkerPresent(dir: string, present: RegExp, depth = 0): boolean {
  if (depth > 4) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name === '.downloads') continue;
    const full = path.join(dir, e.name);
    if (present.test(full)) return true;
  }
  for (const e of entries) {
    if (e.name === '.downloads') continue;
    if (e.isDirectory() && !e.isSymbolicLink()) {
      if (archiveMarkerPresent(path.join(dir, e.name), present, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Extract a tarball/zip with the macOS-bundled tools (same approach as
 * models/binaries.ts — no new dependencies). Throws a clear error; the
 * caller deletes the corrupt archive so a retry downloads it fresh.
 */
function extractArchiveSync(archivePath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const isZip = /\.zip$/i.test(archivePath);
  const tool = isZip ? '/usr/bin/unzip' : '/usr/bin/tar';
  const args = isZip
    ? ['-q', '-o', archivePath, '-d', destDir]
    : ['-xf', archivePath, '-C', destDir];
  try {
    execFileSync(tool, args, { timeout: 300_000 });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to extract ${path.basename(archivePath)} ` +
        `(${isZip ? 'unzip' : 'tar'}): ${detail.slice(-300)} — will retry`
    );
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
