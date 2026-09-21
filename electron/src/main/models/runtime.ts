/**
 * llama-server process manager for Next Token's local models.
 *
 * Two slots max — 'chat' and 'vision' — each running at most one
 * llama-server child process bound to 127.0.0.1 on a free port. The class is
 * deliberately UI-agnostic: it spawns, health-checks, and kills processes,
 * and exposes base URLs that the agent's LLM layer can call as an
 * OpenAI-compatible endpoint.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ModelEntry } from './types';
import { mmprojPathFor } from './downloader';

export type ServerSlot = 'chat' | 'vision';

export interface LocalServerStatus {
  running: boolean;
  modelId: string | null;
  port: number | null;
}

interface SlotState {
  proc: ChildProcess;
  modelId: string;
  port: number;
  baseUrl: string;
  /** Set false the moment the process exits (or we kill it). */
  alive: boolean;
  /** Last ~2KB of stderr, kept for error reports. */
  stderrTail: string;
}

/** Poll interval and deadline for waiting on /health after spawn. */
const HEALTH_POLL_MS = 250;
const READY_TIMEOUT_MS = 120_000;
/** Grace period for SIGTERM before escalating to SIGKILL. */
const STOP_GRACE_MS = 3_000;
const CTX_SIZE = 8192;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else if (port > 0) resolve(port);
        else reject(new Error('Could not allocate a free local port.'));
      });
    });
  });
}

function healthOk(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}/health`, { timeout: 3_000 }, (res) => {
      res.resume(); // drain; we only care about the status code
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** Graceful kill: SIGTERM, then SIGKILL after a grace period. */
function killProc(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, STOP_GRACE_MS);
    // Never let a stray timer keep the app alive.
    (timer as unknown as { unref?: () => void }).unref?.();
    proc.once('exit', onExit);
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function appendTail(state: SlotState, chunk: Buffer): void {
  state.stderrTail += chunk.toString('utf8');
  if (state.stderrTail.length > 2048) {
    state.stderrTail = state.stderrTail.slice(-2048);
  }
}

/** Module-level registry so a single process 'exit' hook covers every instance. */
const liveInstances = new Set<LlamaServer>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' only allows synchronous work: best-effort SIGKILL of every child.
  process.on('exit', () => {
    for (const inst of liveInstances) {
      inst.killAllSync();
    }
  });
}

export class LlamaServer {
  private readonly binDir: string;
  private readonly modelsDir: string;
  private readonly ensureSidecarFn: (
    name: 'llama-server',
    binDir: string
  ) => Promise<string>;
  private readonly slots = new Map<ServerSlot, SlotState>();
  /** Per-slot promise chain so concurrent start/stop calls serialize. */
  private readonly locks = new Map<ServerSlot, Promise<unknown>>();

  constructor(opts: {
    binDir: string;
    modelsDir: string;
    ensureSidecar: (name: 'llama-server', binDir: string) => Promise<string>;
  }) {
    this.binDir = opts.binDir;
    this.modelsDir = opts.modelsDir;
    this.ensureSidecarFn = opts.ensureSidecar;
    installExitHook();
    liveInstances.add(this);
  }

  private withLock<T>(slot: ServerSlot, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(slot) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(slot, next.catch(() => undefined));
    return next;
  }

  /**
   * Start (or restart) serving `entry` on `slot`.
   * Returns the base URL, e.g. http://127.0.0.1:8080.
   */
  async start(entry: ModelEntry, slot: ServerSlot): Promise<string> {
    const r = await this.withLock(slot, () => this.spawnLocked(entry, slot));
    return r.baseUrl;
  }

  /**
   * Idempotent warm-up: returns the running server when `entry` is already
   * serving on `slot` — no stop, no respawn. A *different* model still
   * replaces the old one (each slot holds exactly one server), so the
   * single-server-per-slot invariant is unchanged; we just stop paying
   * spawn + model-load latency when the right model is already up.
   */
  async ensureWarm(entry: ModelEntry, slot: ServerSlot): Promise<{
    baseUrl: string;
    /** True when the model was already serving — zero spawn/load cost. */
    warm: boolean;
    /** Overhead before the process existed: stop old server, sidecar, port. */
    spawnMs: number;
    /** Model load time: spawn → /health ready. */
    loadMs: number;
  }> {
    return this.withLock(slot, async () => {
      const st = this.slots.get(slot);
      if (st && st.alive && st.proc.exitCode === null && st.modelId === entry.id) {
        return { baseUrl: st.baseUrl, warm: true, spawnMs: 0, loadMs: 0 };
      }
      const r = await this.spawnLocked(entry, slot);
      return { ...r, warm: false };
    });
  }

  private async spawnLocked(
    entry: ModelEntry,
    slot: ServerSlot
  ): Promise<{ baseUrl: string; spawnMs: number; loadMs: number }> {
    const t0 = Date.now();
    const ggufPath = path.join(this.modelsDir, `${entry.id}.gguf`);
    if (!fs.existsSync(ggufPath)) {
      throw new Error(`Model "${entry.name}" is not downloaded`);
    }
    let mmprojPath: string | null = null;
    if (slot === 'vision') {
      mmprojPath = mmprojPathFor(this.modelsDir, entry);
      if (!fs.existsSync(mmprojPath)) {
        throw new Error(
          `Vision projector for model "${entry.name}" is not downloaded ` +
            `(expected ${path.basename(mmprojPath)})`
        );
      }
    }

    // Restart semantics: an occupied slot kills the old server first.
    await this.stopLocked(slot);

    const serverBin = await this.ensureSidecarFn('llama-server', this.binDir);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const args = [
      '-m', ggufPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--ctx-size', String(CTX_SIZE),
      '--threads', String(Math.max(1, os.cpus().length - 1)),
    ];
    // GPU offload: Metal on macOS (Apple Silicon unified memory), CUDA on
    // Linux where a GPU exists. llama.cpp falls back to CPU automatically
    // when there is nothing to offload to, so this is safe on CPU-only
    // machines too.
    if (process.platform === 'darwin' || process.platform === 'linux') {
      args.push('-ngl', '99');
    }
    if (slot === 'vision' && mmprojPath) {
      args.push('--mmproj', mmprojPath);
    }

    const proc = spawn(serverBin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const tSpawned = Date.now();

    const state: SlotState = {
      proc,
      modelId: entry.id,
      port,
      baseUrl,
      alive: true,
      stderrTail: '',
    };
    proc.stderr?.on('data', (d: Buffer) => appendTail(state, d));
    proc.on('error', (err) => {
      appendTail(state, Buffer.from(`spawn error: ${err.message}\n`));
    });
    proc.on('exit', () => {
      state.alive = false;
    });
    this.slots.set(slot, state);

    try {
      await this.waitReady(state, entry);
    } catch (e) {
      state.alive = false;
      this.slots.delete(slot);
      await killProc(proc);
      const tail = state.stderrTail.trim();
      const detail = tail ? `\nllama-server stderr:\n${tail}` : '';
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Failed to start local model "${entry.name}" on slot "${slot}": ${msg}${detail}`);
    }
    const tReady = Date.now();
    return { baseUrl, spawnMs: tSpawned - t0, loadMs: tReady - tSpawned };
  }

  private async waitReady(state: SlotState, entry: ModelEntry): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (!state.alive || state.proc.exitCode !== null) {
        throw new Error(
          `llama-server exited before becoming ready (exit code ${state.proc.exitCode ?? 'unknown'})`
        );
      }
      if (await healthOk(state.baseUrl)) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `llama-server did not become ready within ${READY_TIMEOUT_MS / 1000}s ` +
            `while loading "${entry.name}"`
        );
      }
      await sleep(HEALTH_POLL_MS);
    }
  }

  /** Stop the server on `slot`. No-op if the slot is empty. */
  async stop(slot: ServerSlot): Promise<void> {
    return this.withLock(slot, () => this.stopLocked(slot));
  }

  private async stopLocked(slot: ServerSlot): Promise<void> {
    const state = this.slots.get(slot);
    if (!state) return;
    state.alive = false;
    this.slots.delete(slot);
    await killProc(state.proc);
  }

  /** Stop every running server. Call from app before-quit. */
  async stopAll(): Promise<void> {
    await Promise.all([this.stop('chat'), this.stop('vision')]);
  }

  status(slot: ServerSlot): LocalServerStatus {
    const state = this.slots.get(slot);
    if (!state || !state.alive || state.proc.exitCode !== null) {
      return { running: false, modelId: null, port: null };
    }
    return { running: true, modelId: state.modelId, port: state.port };
  }

  /** Base URL for a running slot, or null if it isn't serving. */
  url(slot: ServerSlot): string | null {
    const state = this.slots.get(slot);
    if (!state || !state.alive || state.proc.exitCode !== null) return null;
    return state.baseUrl;
  }

  /** Synchronous best-effort kill of all children (process 'exit' hook only). */
  killAllSync(): void {
    for (const state of this.slots.values()) {
      state.alive = false;
      try {
        if (state.proc.exitCode === null) state.proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.slots.clear();
  }
}
