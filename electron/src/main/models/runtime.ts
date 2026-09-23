/**
 * llama-server process manager for Next Token's local models.
 *
 * Two slots max — 'chat' and 'vision' — each running at most one
 * llama-server child process bound to 127.0.0.1 on a free port. The class is
 * deliberately UI-agnostic: it spawns, health-checks, and kills processes,
 * and exposes base URLs that the agent's LLM layer can call as an
 * OpenAI-compatible endpoint.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ModelEntry } from './types';
import { mmprojPathFor } from './downloader';

export type ServerSlot = 'chat' | 'vision';

/** Resident-RAM priority when memory pressure forces unloads: chat outlives vision. */
const PRESSURE_ORDER: ServerSlot[] = ['vision', 'chat'];

/**
 * Why a slot is currently down. A user pause is a sticky state — the model
 * never auto-resumes (only the user, or an explicit turn-time prompt,
 * re-arms it); idle/pressure unloads re-warm transparently on next use.
 */
export type SlotDownReason = 'never' | 'user-paused' | 'idle-unloaded' | 'memory-pressure';

export interface LocalServerStatus {
  running: boolean;
  modelId: string | null;
  port: number | null;
  /** Why the slot is down right now ('never' when up or untouched). */
  downReason: SlotDownReason;
  /** Wall-clock ms of the most recent spawn→ready model load. */
  lastLoadMs: number;
}

interface SlotState {
  proc: ChildProcess;
  modelId: string;
  port: number;
  baseUrl: string;
  /** Set false the moment the process exits (or we kill it). */
  alive: boolean;
  /** Last ensureWarm() call — drives the idle-unload sweeper. */
  lastUsedAt: number;
  /** Last ~2KB of stderr, kept for error reports. */
  stderrTail: string;
}

/** Poll interval and deadline for waiting on /health after spawn. */
const HEALTH_POLL_MS = 250;
const READY_TIMEOUT_MS = 120_000;
/** Grace period for SIGTERM before escalating to SIGKILL. */
const STOP_GRACE_MS = 3_000;
const CTX_SIZE = 8192;
/** A warmed server with no ensureWarm() call for this long is stopped to free RAM. */
const IDLE_STOP_MS = 15 * 60_000;
/** Swap-in pressure threshold: free percent of total RAM below which we force-unload. */
const PRESSURE_FREE_PCT = 12;
/** Pressure checks at most this often. */
const PRESSURE_POLL_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Best-effort available RAM on macOS. os.freemem() is misleading on Darwin
 * (inactive pages count as used), so prefer the OS's own memory_pressure
 * tool, which reports the system-wide free percentage; fall back to
 * os.freemem() elsewhere or when the tool is unavailable.
 */
async function memFreeBytes(): Promise<number> {
  if (process.platform === 'darwin') {
    try {
      const out = await new Promise<string>((resolve) => {
        execFile('memory_pressure', ['-Q'], { timeout: 3000 }, (err, stdout) =>
          resolve(err ? '' : String(stdout ?? '')),
        );
      });
      const pct = /free percentage:\s*(\d+)/i.exec(out)?.[1];
      if (pct !== undefined) return (os.totalmem() * parseInt(pct, 10)) / 100;
    } catch {
      /* fall through to freemem */
    }
  }
  return os.freemem();
}

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
  /** Why each slot is down (survives while the slot has no live server). */
  private readonly downReason = new Map<ServerSlot, SlotDownReason>();
  /** Most recent spawn→ready load time per slot, for honest UI copy. */
  private readonly lastLoadMs = new Map<ServerSlot, number>();
  /** Models the user explicitly paused — sticky, never auto-resumed. */
  private readonly userPaused = new Set<string>();
  private pressureTimer: NodeJS.Timeout | null = null;

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
    this.startPressureWatcher();
  }

  /**
   * Poll free RAM; when it drops under PRESSURE_FREE_PCT of total, force-
   * unload lowest-priority slots (vision first, chat last) and log it. The
   * goal is to unload BEFORE macOS starts compressing/swapping and the UI
   * beachballs. Router/chat are never unloaded by pressure when they were
   * the only thing left — the last slot standing keeps the machine useful.
   */
  private startPressureWatcher(): void {
    if (this.pressureTimer || process.platform !== 'darwin') return;
    this.pressureTimer = setInterval(() => {
      void this.checkMemoryPressure().catch(() => {
        /* watcher must never throw */
      });
    }, PRESSURE_POLL_MS);
    this.pressureTimer.unref?.();
  }

  private async checkMemoryPressure(): Promise<void> {
    const total = os.totalmem();
    const free = await memFreeBytes();
    if (free <= 0 || free / total > PRESSURE_FREE_PCT / 100) return;
    for (const slot of PRESSURE_ORDER) {
      if (free / total > PRESSURE_FREE_PCT / 100) break;
      const st = this.slots.get(slot);
      if (!st || !st.alive) continue;
      console.warn(
        `[local-model] memory pressure: unloading slot=${slot} model=${st.modelId} ` +
          `(free ${(free / total * 100).toFixed(1)}% of ${(total / 2 ** 30).toFixed(1)} GB)`,
      );
      this.downReason.set(slot, 'memory-pressure');
      await this.stop(slot).catch(() => {});
    }
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
   *
   * Returns the same shape as start(), plus `warm`.
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
        st.lastUsedAt = Date.now();
        return { baseUrl: st.baseUrl, warm: true, spawnMs: 0, loadMs: 0 };
      }
      // A user-paused model must not silently come back: only an explicit
      // resumeModel() or a start() call from the user's own action re-arms it.
      if (this.downReason.get(slot) === 'user-paused') {
        throw new Error(`Model "${entry.name}" is paused — resume it in Settings → Models to use it.`);
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
      lastUsedAt: Date.now(),
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
    const loadMs = tReady - tSpawned;
    this.lastLoadMs.set(slot, loadMs);
    this.downReason.delete(slot);
    return { baseUrl, spawnMs: tSpawned - t0, loadMs };
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

  /**
   * USER PAUSE: unload the model from RAM (frees everything, including the
   * Metal buffers) but keep it downloaded. A user-paused model never
   * auto-resumes — ensureWarm() refuses with an honest error and the UI
   * shows a Paused pill until the user hits Resume.
   */
  async pauseModel(modelId: string): Promise<{ ok: boolean; freedMs?: number }> {
    for (const slot of ['chat', 'vision'] as ServerSlot[]) {
      const st = this.slots.get(slot);
      if (st && st.alive && st.modelId === modelId) {
        this.userPaused.add(modelId);
        this.downReason.set(slot, 'user-paused');
        const t0 = Date.now();
        await this.stop(slot);
        return { ok: true, freedMs: Date.now() - t0 };
      }
    }
    // Not currently loaded: just mark it so the next ensureWarm refuses.
    this.userPaused.add(modelId);
    return { ok: true };
  }

  /**
   * Resume a user-paused model by loading it back onto its natural slot.
   * Returns the load time so the UI can show "resumed in 2.3 s".
   */
  async resumeModel(entry: ModelEntry, slot: ServerSlot): Promise<{ ok: boolean; loadMs: number }> {
    this.userPaused.delete(entry.id);
    this.downReason.delete(slot);
    await this.withLock(slot, () => this.spawnLocked(entry, slot));
    return { ok: true, loadMs: this.lastLoadMs.get(slot) ?? 0 };
  }

  /** True when the user explicitly paused this model id. */
  isUserPaused(modelId: string): boolean {
    return this.userPaused.has(modelId);
  }

  /** Model ids the user explicitly paused (sticky until resumed). */
  listUserPaused(): string[] {
    return [...this.userPaused];
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

  /**
   * Stop servers that have seen no ensureWarm() call for IDLE_STOP_MS.
   * Every real inference path goes through ensureWarm() first, so an idle
   * server is by definition unused — the next turn re-warms transparently.
   */
  async sweepIdle(): Promise<void> {
    const now = Date.now();
    const idle: ServerSlot[] = [];
    for (const [slot, state] of this.slots) {
      if (state.alive && state.proc.exitCode === null && now - state.lastUsedAt > IDLE_STOP_MS) {
        idle.push(slot);
      }
    }
    for (const slot of idle) {
      console.log(`[local-model] idle-stop slot=${slot} after ${IDLE_STOP_MS / 60000}min without use`);
      this.downReason.set(slot, 'idle-unloaded');
      await this.stop(slot).catch(() => {
        /* best effort */
      });
    }
  }

  status(slot: ServerSlot): LocalServerStatus {
    const state = this.slots.get(slot);
    if (!state || !state.alive || state.proc.exitCode !== null) {
      return {
        running: false,
        modelId: null,
        port: null,
        downReason: this.downReason.get(slot) ?? 'never',
        lastLoadMs: this.lastLoadMs.get(slot) ?? 0,
      };
    }
    return {
      running: true,
      modelId: state.modelId,
      port: state.port,
      downReason: 'never',
      lastLoadMs: this.lastLoadMs.get(slot) ?? 0,
    };
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
