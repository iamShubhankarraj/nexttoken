/**
 * Client for the applefm-bridge sidecar (native/applefm): a Swift executable
 * that wraps Apple's FoundationModels framework (on-device LLM, macOS 26+).
 *
 * Lifecycle is deliberately simple: the bridge is spawned fresh for every
 * operation (--probe for probe(), one request/response for chat()) and torn
 * down immediately. No long-lived child process to leak or wedgify.
 *
 * Graceful degradation: on non-macOS platforms, or when no candidate binary
 * exists/executes, probe() reports available:false and chat() throws — the
 * caller falls back to BYOK cloud providers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants } from 'node:fs';
import os from 'node:os';

export interface AppleFmProbe {
  available: boolean;
  reason?: string;
}

export interface AppleFmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AppleFmChatOpts {
  /** per-call timeout; default 120_000ms. */
  timeoutMs?: number;
  /** caller-supplied system prompt, sent as the bridge's top-level "system" field. */
  system?: string;
}

const PROBE_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 120_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024; // 4MB response cap

interface BridgeChatResponse {
  id: unknown;
  text?: string;
  error?: string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The executable bit can be lost when the bridge is copied into the packaged
 * app. If the file exists but isn't executable, try to repair it once.
 */
function ensureExecutable(path: string): boolean {
  if (isExecutable(path)) return true;
  try {
    accessSync(path, constants.F_OK);
  } catch {
    return false;
  }
  try {
    chmodSync(path, 0o755);
  } catch {
    /* repair failed — fall through */
  }
  return isExecutable(path);
}

export class AppleFmClient {
  private readonly binaryCandidates: string[];
  private probeCache: AppleFmProbe | null = null;
  private nextId = 1;

  /** binaryCandidates: paths to try in order (e.g. packaged resourcesPath sidecar, then the dev repo copy). */
  constructor(opts: { binaryCandidates: string[] }) {
    this.binaryCandidates = opts.binaryCandidates;
  }

  /** Spawn the bridge with --probe. Result is cached; probe() is cheap to re-run. */
  async probe(): Promise<AppleFmProbe> {
    if (os.platform() !== 'darwin') {
      this.probeCache = { available: false, reason: 'Apple Foundation Models requires macOS' };
      return this.probeCache;
    }
    const binary = this.findBinary();
    if (!binary) {
      this.probeCache = { available: false, reason: 'applefm-bridge binary not found' };
      return this.probeCache;
    }

    const child = spawn(binary, ['--probe'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = await this.readFirstJsonLine<BridgeProbeOutput>(child, PROBE_TIMEOUT_MS);
    this.probeCache = result.ok
      ? { available: result.json.available, reason: result.json.reason }
      : { available: false, reason: result.reason };
    return this.probeCache;
  }

  /**
   * Run one tool-free chat turn through the on-device model.
   *
   * NOTE: Apple Foundation Models does NOT support tool calling — the router
   * must only route tool-free turns here. Requested tools/prompt are the only
   * inputs; the response is plain text.
   */
  async chat(messages: AppleFmMessage[], opts?: AppleFmChatOpts): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? CHAT_TIMEOUT_MS;
    if (os.platform() !== 'darwin') {
      throw new Error('Apple Foundation Models unavailable: requires macOS');
    }
    const binary = this.findBinary();
    if (!binary) {
      throw new Error('Apple Foundation Models unavailable: applefm-bridge binary not found');
    }
    if (messages.length === 0) {
      throw new Error('Apple Foundation Models unavailable: no messages provided');
    }

    const id = this.nextId++;
    const request = JSON.stringify({
      id,
      op: 'chat',
      system: opts?.system ?? '',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const writeErr = await new Promise<string | null>((resolve) => {
      child.stdin!.write(request + '\n', (err) => resolve(err ? String(err) : null));
    });
    child.stdin!.end();
    if (writeErr) {
      this.kill(child);
      throw new Error(`Apple Foundation Models unavailable: failed to write request (${writeErr})`);
    }

    const result = await this.readFirstJsonLine<BridgeChatResponse>(child, timeoutMs);
    if (!result.ok) {
      throw new Error(`Apple Foundation Models unavailable: ${result.reason}`);
    }
    const json = result.json;
    if (json.id !== id) {
      // Defensive: the bridge is request-sequential, so a mismatched id means corruption.
      throw new Error('Apple Foundation Models unavailable: bridge returned a mismatched response id');
    }
    if (typeof json.error === 'string') {
      throw new Error(`Apple Foundation Models unavailable: ${json.error}`);
    }
    if (typeof json.text !== 'string') {
      throw new Error('Apple Foundation Models unavailable: bridge returned no text');
    }
    return json.text;
  }

  /** Whether chat() can be called right now (true only after a successful probe). */
  get ready(): boolean {
    return this.probeCache?.available === true;
  }

  private findBinary(): string | null {
    for (const candidate of this.binaryCandidates) {
      if (candidate && ensureExecutable(candidate)) return candidate;
    }
    return null;
  }

  private kill(child: ChildProcess): void {
    try {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  /**
   * Reads stdout until the first complete newline-terminated JSON line, parses
   * it, then kills the child. Resolves ok:false on timeout, non-zero exit
   * without a line, spawn failure, or unparseable output.
   */
  private readFirstJsonLine<T>(child: ChildProcess, timeoutMs: number): Promise<ReadResult<T>> {
    return new Promise((resolve) => {
      let buf = '';
      let settled = false;
      let spawnErr: string | null = null;

      const finish = (r: ReadResult<T>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.kill(child);
        resolve(r);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, reason: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref?.();

      child.on('error', (err) => {
        spawnErr = String((err as Error)?.message ?? err);
      });
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        if (buf.length > MAX_LINE_BYTES) {
          finish({ ok: false, reason: 'response exceeded 4MB' });
          return;
        }
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          const line = buf.slice(0, nl);
          try {
            finish({ ok: true, json: JSON.parse(line) as T });
          } catch {
            finish({ ok: false, reason: 'bridge returned invalid JSON' });
          }
        }
      });
      child.on('close', (code) => {
        if (spawnErr) {
          finish({ ok: false, reason: spawnErr });
        } else {
          finish({ ok: false, reason: code === 0 ? 'bridge exited without responding' : `bridge exited with code ${code}` });
        }
      });
    });
  }
}

interface BridgeProbeOutput {
  available: boolean;
  reason?: string;
}

type ReadResult<T> =
  | { ok: true; json: T }
  | { ok: false; reason: string };
