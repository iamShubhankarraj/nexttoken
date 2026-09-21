/**
 * Sidecar binary resolution + download for Next Token's local-model runtime.
 *
 * Next Token ships no native binaries of its own (electron-builder packaging
 * can't bundle native Node modules, and we don't compile C++). Instead, on
 * first use of a local-model feature, we fetch a prebuilt macOS arm64 binary
 * from the upstream project's GitHub releases, extract it into
 * `<userData>/bin`, and reuse it from there.
 *
 * Asset resolution is dynamic: we query the GitHub releases API for the
 * latest release and match the asset filename against a pattern, so this
 * keeps working as upstream build numbers change. No hardcoded URLs.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export type SidecarName = 'llama-server' | 'whisper-cli' | 'sherpa-tts';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'next-token-local-models';
/** Inactivity (stall) timeout while downloading, and an overall cap. */
const DOWNLOAD_STALL_MS = 120_000;
const DOWNLOAD_TOTAL_MS = 15 * 60_000;
const API_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 10;
/** Sanity floor: a real sidecar binary is never smaller than this. */
const MIN_BINARY_BYTES = 256 * 1024;

interface SidecarSpec {
  /** GitHub repo in "owner/name" form. */
  repo: string;
  /** Asset filename patterns, tried in order against the latest release. */
  assetPatterns: RegExp[];
  /** Expected binary filename inside the extracted archive. */
  binaryName: string;
  /** Human-readable description used in error messages. */
  describe: string;
  /**
   * Exact release asset to download instead of querying the GitHub releases
   * API. Used when the latest release no longer ships a usable macOS
   * desktop archive (sherpa-onnx stopped publishing one after v1.11.0).
   * Verified 2026-09-21: the v1.11.0 universal2 tarball contains
   * bin/sherpa-onnx-offline-tts plus its companion dylibs under lib/.
   */
  pinnedAsset?: {
    url: string;
    file: string;
    binaryName: string;
    /** Archive subdirs whose *.dylib files are installed next to the binary. */
    libSubdirs?: string[];
  };
}

const SPECS: Record<SidecarName, SidecarSpec> = {
  'llama-server': {
    repo: 'ggerganov/llama.cpp',
    // e.g. llama-b7437-bin-macos-arm64.zip (contains build/bin/llama-server)
    assetPatterns: [/^llama-.*-bin-macos-arm64\.zip$/i],
    binaryName: 'llama-server',
    describe: 'llama.cpp server binary (macOS arm64)',
  },
  'whisper-cli': {
    repo: 'ggerganov/whisper.cpp',
    // NOTE (fallback): whisper.cpp does not publish prebuilt macOS binaries
    // in its GitHub releases as of this writing — releases carry source
    // tarballs only. If upstream ever adds one, the patterns below will pick
    // it up automatically; otherwise ensureSidecar throws a descriptive
    // error with manual install steps (see below).
    assetPatterns: [
      /^whisper.*macos.*(arm64|aarch64|universal).*\.(zip|tar\.gz|tgz)$/i,
      /^whisper.*(arm64|aarch64).*(macos|osx).*\.(zip|tar\.gz|tgz)$/i,
    ],
    binaryName: 'whisper-cli',
    describe: 'whisper.cpp CLI binary (macOS arm64)',
  },
  'sherpa-tts': {
    repo: 'k2-fsa/sherpa-onnx',
    // Pinned: upstream stopped shipping a macOS desktop tarball after
    // v1.11.0 (latest releases carry only win/linux/android + JVM jars),
    // so the "latest release" lookup can never match. v1.11.0's
    // osx-universal2-shared tarball is verified to contain
    // bin/sherpa-onnx-offline-tts (Kokoro flags compatible with our tts.ts).
    pinnedAsset: {
      url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.11.0/sherpa-onnx-v1.11.0-osx-universal2-shared.tar.bz2',
      file: 'sherpa-onnx-v1.11.0-osx-universal2-shared.tar.bz2',
      binaryName: 'sherpa-onnx-offline-tts',
      libSubdirs: ['lib'],
    },
    assetPatterns: [
      /^sherpa-onnx-.*-(osx|macos)-arm64\.tar\.bz2$/i,
      /^sherpa-onnx-.*-(osx|macos)-arm64\.tar\.gz$/i,
      // Universal2 desktop archives (e.g. v1.11.0's
      // sherpa-onnx-v1.11.0-osx-universal2-shared.tar.bz2), excluding the
      // -no-tts variants which lack the offline TTS binary.
      /^sherpa-onnx-.*-osx-universal2-shared\.tar\.bz2$/i,
    ],
    binaryName: 'sherpa-onnx-offline-tts',
    describe: 'sherpa-onnx offline TTS binary (macOS arm64)',
  },
};

function githubGet<T>(url: string, redirectsLeft = MAX_REDIRECTS): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // GitHub's API issues redirects (e.g. /repositories/<id>/... ->
        // /repos/<owner>/<name>/...); follow them instead of failing.
        // https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api#follow-redirects
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects for GitHub API request: ${url}`));
            return;
          }
          githubGet<T>(res.headers.location, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (status !== 200) {
            reject(
              new Error(
                `GitHub API request failed (HTTP ${status}): ${body.slice(0, 300)}`
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(new Error(`Could not parse GitHub API response: ${String(e)}`));
          }
        });
      }
    );
    req.setTimeout(API_TIMEOUT_MS, () => {
      req.destroy(new Error('GitHub API request timed out'));
    });
    req.on('error', reject);
  });
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

async function resolveAssetUrl(spec: SidecarSpec): Promise<{ url: string; assetName: string }> {
  let release: Release;
  try {
    release = await githubGet<Release>(`${GITHUB_API}/repos/${spec.repo}/releases/latest`);
  } catch (e) {
    throw new Error(
      `Could not reach the GitHub releases API for ${spec.repo} to find the ${spec.describe}. ` +
        `Check your network connection. (${String(e)})`
    );
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  for (const pattern of spec.assetPatterns) {
    const hit = assets.find((a) => pattern.test(a.name));
    if (hit) return { url: hit.browser_download_url, assetName: hit.name };
  }
  const names = assets.map((a) => a.name).join(', ') || '(no assets)';
  throw new Error(
    `No matching release asset for the ${spec.describe} in the latest ${spec.repo} ` +
      `release (${release.tag_name}). Looked for filenames matching ` +
      `${spec.assetPatterns.map((p) => p.source).join(' / ')}; release contains: ${names}`
  );
}

function downloadFile(url: string, destPath: string, redirectsLeft = MAX_REDIRECTS): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      file.close(() => {
        fs.rm(destPath, { force: true }, () => reject(err));
      });
    };
    const totalTimer = setTimeout(() => {
      fail(new Error(`Download timed out after ${DOWNLOAD_TOTAL_MS / 60000} minutes: ${url}`));
    }, DOWNLOAD_TOTAL_MS);
    // unref so a hung download can't keep the app alive on quit
    (totalTimer as unknown as { unref?: () => void }).unref?.();

    const req = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          // Follow redirects (github.com -> objects.githubusercontent.com).
          res.resume();
          file.close(() => {
            fs.rm(destPath, { force: true }, () => {
              clearTimeout(totalTimer);
              if (redirectsLeft <= 0) {
                reject(new Error(`Too many redirects while downloading ${url}`));
                return;
              }
              downloadFile(res.headers.location as string, destPath, redirectsLeft - 1).then(
                resolve,
                reject
              );
            });
          });
          return;
        }
        if (status !== 200) {
          res.resume();
          fail(new Error(`Download failed with HTTP ${status}: ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          if (settled) return;
          settled = true;
          clearTimeout(totalTimer);
          file.close((err) => (err ? reject(err) : resolve()));
        });
      }
    );
    req.setTimeout(DOWNLOAD_STALL_MS, () => {
      req.destroy();
      fail(new Error(`Download stalled for over ${DOWNLOAD_STALL_MS / 1000}s: ${url}`));
    });
    req.on('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

function execFileAsync(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 120_000 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? '').trim().slice(-500);
        reject(new Error(`Extraction failed (${path.basename(file)}): ${detail || err.message}`));
        return;
      }
      resolve();
    });
  });
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (/\.zip$/i.test(archivePath)) {
    // macOS ships /usr/bin/unzip on every install; pure-JS unzip would need a new dep.
    await execFileAsync('/usr/bin/unzip', ['-q', '-o', archivePath, '-d', destDir], destDir);
  } else {
    // tar auto-detects gzip/bzip2/xz compression.
    await execFileAsync('/usr/bin/tar', ['-xf', archivePath, '-C', destDir], destDir);
  }
}

async function findFile(dir: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 6) return null;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink()) {
      const hit = await findFile(path.join(dir, e.name), name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function installBinary(srcPath: string, destPath: string, sidecar: SidecarName): Promise<void> {
  const stat = await fsp.stat(srcPath);
  if (!stat.isFile()) {
    throw new Error(`Expected a binary at ${srcPath} but found something else.`);
  }
  if (stat.size < MIN_BINARY_BYTES) {
    throw new Error(
      `Downloaded ${sidecar} looks corrupt (only ${stat.size} bytes). Delete ${destPath} and retry.`
    );
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${process.pid}`;
  await fsp.copyFile(srcPath, tmpPath);
  await fsp.chmod(tmpPath, 0o755);
  await fsp.rename(tmpPath, destPath);
  // Verify the installed file is actually executable by us.
  try {
    await fsp.access(destPath, fs.constants.X_OK);
  } catch {
    throw new Error(`Installed ${sidecar} at ${destPath} but it is not executable.`);
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    await fsp.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function whisperManualSteps(binDir: string): string {
  const libDir = path.join(path.dirname(binDir), "lib");
  return (
    `No prebuilt macOS binary for whisper.cpp is published in its GitHub releases, ` +
    `so on-device speech-to-text needs a manual install:\n` +
    `  1. Install whisper.cpp via Homebrew:  brew install whisper-cpp\n` +
    `  2. Copy the whisper-cli binary into place, e.g.:\n` +
    `       cp "$(brew --prefix)/bin/whisper-cli" "${path.join(binDir, "whisper-cli")}"\n` +
    `       chmod +x "${path.join(binDir, "whisper-cli")}"\n` +
    `  3. Copy its companion libraries too — the binary is dynamically linked\n` +
    `     and will not start without them (this was the old missing step):\n` +
    `       mkdir -p "${libDir}"\n` +
    `       cp "$(brew --prefix)"/lib/libwhisper*.dylib "${libDir}/"\n` +
    `       cp "$(brew --prefix)"/lib/libggml*.dylib "${libDir}/"\n` +
    `  (Or build whisper.cpp from source and copy build/bin/whisper-cli plus\n` +
    `   the libwhisper*/libggml* dylibs there.)\n` +
    `Then retry — Next Token will pick the binary up automatically.`
  );
}

/** Dedupe concurrent ensureSidecar calls for the same binary. */
const inflight = new Map<SidecarName, Promise<string>>();

/**
 * Return the path of an executable sidecar binary, downloading it first if needed.
 *
 * - If `<binDir>/<name>` already exists and is executable, it is returned as-is.
 * - Otherwise the latest GitHub release of the upstream project is queried,
 *   the matching macOS arm64 asset is downloaded to a temp dir, extracted with
 *   the macOS-bundled /usr/bin/unzip or /usr/bin/tar (no new dependencies),
 *   and the binary is installed at `<binDir>/<name>` with mode 755.
 *
 * Throws a human-readable Error on any failure. whisper-cli has no prebuilt
 * upstream binary, so it throws with manual install steps instead.
 */
export async function ensureSidecar(name: SidecarName, binDir: string): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(
      `Local-model sidecars are macOS Apple Silicon binaries; ` +
        `cannot provision "${name}" on ${process.platform}/${process.arch}.`
    );
  }

  const dest = path.join(binDir, name);
  if (await isExecutable(dest)) return dest;

  const existing = inflight.get(name);
  if (existing) return existing;

  const job = (async (): Promise<string> => {
    // Re-check after acquiring the logical lock (another caller may have finished).
    if (await isExecutable(dest)) return dest;

    if (name === 'whisper-cli') {
      // Try upstream first in case a prebuilt binary ever appears; otherwise
      // fail with clear manual steps. (Documented fallback.)
      try {
        return await downloadAndInstall(name, binDir, dest);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/no matching release asset/i.test(msg)) {
          throw new Error(whisperManualSteps(binDir));
        }
        throw e;
      }
    }
    if (name === 'sherpa-tts') {
      try {
        return await downloadAndInstall(name, binDir, dest);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/no matching release asset|github releases api/i.test(msg)) {
          throw new Error(
            `Could not obtain the sherpa-onnx TTS binary for macOS arm64 from ` +
              `k2-fsa/sherpa-onnx releases. (${msg}) ` +
              `On-device TTS is unavailable until a compatible release asset exists.`
          );
        }
        throw e;
      }
    }
    return downloadAndInstall(name, binDir, dest);
  })();

  inflight.set(name, job);
  try {
    return await job;
  } finally {
    inflight.delete(name);
  }
}

async function downloadAndInstall(
  name: SidecarName,
  binDir: string,
  dest: string
): Promise<string> {
  const spec = SPECS[name];
  const pinned = spec.pinnedAsset;
  const { url, assetName } = pinned
    ? { url: pinned.url, assetName: pinned.file }
    : await resolveAssetUrl(spec);

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `nt-${name}-`));
  try {
    const ext = /\.zip$/i.test(assetName) ? '.zip' : '.tar';
    const archivePath = path.join(workDir, `pkg${ext}`);
    await downloadFile(url, archivePath);

    const extractDir = path.join(workDir, 'extracted');
    await fsp.mkdir(extractDir, { recursive: true });
    try {
      await extractArchive(archivePath, extractDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/\/usr\/bin\/(unzip|tar)/.test(msg) || /ENOENT/.test(msg)) {
        throw new Error(
          `Could not extract the ${spec.describe}: the macOS system tool ` +
            `/usr/bin/${ext === '.zip' ? 'unzip' : 'tar'} is missing or failed. ${msg}`
        );
      }
      throw e;
    }

    const binaryName = pinned?.binaryName ?? spec.binaryName;
    const found = await findFile(extractDir, binaryName);
    if (!found) {
      throw new Error(
        `Downloaded ${assetName} but could not find ${binaryName} inside it. ` +
          `The upstream release layout may have changed.`
      );
    }
    await installBinary(found, dest, name);
    if (pinned?.libSubdirs?.length) {
      // Companion dynamic libraries (e.g. sherpa's libonnxruntime): the
      // binary resolves them via @rpath relative to its own dir, so they
      // live in <userData>/lib next to whisper's dylibs.
      await installCompanionLibs(extractDir, pinned.libSubdirs, binDir);
    }
    return dest;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

/** Copy *.dylib files from the archive's lib subdirs into <binDir>/../lib. */
async function installCompanionLibs(
  extractDir: string,
  libSubdirs: string[],
  binDir: string
): Promise<void> {
  const libDir = path.join(binDir, '..', 'lib');
  await fsp.mkdir(libDir, { recursive: true });
  for (const sub of libSubdirs) {
    const dir = await findDir(extractDir, sub);
    if (!dir) continue;
    const entries = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const e of entries) {
      if (!/\.dylib$/.test(e)) continue;
      try {
        await fsp.copyFile(path.join(dir, e), path.join(libDir, e));
      } catch {
        /* best effort — a missing companion lib surfaces at engine start */
      }
    }
  }
}

/** Recursively find a directory named `name` under `dir`. */
async function findDir(dir: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 6) return null;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name === name) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink()) {
      const hit = await findDir(path.join(dir, e.name), name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
