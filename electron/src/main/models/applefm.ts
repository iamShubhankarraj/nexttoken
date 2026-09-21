/**
 * Client for the applefm-bridge sidecar (native/applefm): a Swift executable
 * that wraps Apple's FoundationModels framework (on-device LLM, macOS 26+).
 *
 * Lifecycle: the bridge is spawned fresh for every operation and torn down
 * immediately. No long-lived child process to leak or wedgify.
 *
 * Tool calling: bridges built with tool support report `toolCalling: true`
 * from --probe. chatWithTools() keeps the child alive for the turn: the
 * bridge emits {"id","tool_call":{...}} lines, the caller's onToolCall
 * executes the real tool, and the result is written back as
 * {"id","tool_result":{...}} until the final {"id","text":"..."} arrives.
 * The plain chat() path stays one-shot and tool-free.
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
  reason?: string;  /**
   * True when the ONLY problem is the missing sidecar binary — i.e. the user
   * can fix this themselves by running native/applefm/build.sh on their Mac.
   * The UI renders a "one-time setup required" card instead of an error.
   */
  setupRequired?: boolean;
  /**
   * True when the bridge binary supports tool calling (reported by --probe).
   * Bridges built before tool calling existed omit it — treated as false,
   * and the router skips Apple FM for tool-bearing turns with an honest
   * message instead of claiming it is "unavailable".
   */
  toolCalling?: boolean;
}

export interface AppleFmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** One tool definition forwarded to the bridge (mirrors LlmToolDef). */
export interface AppleFmToolDef {
  name: string;
  description: string;
  /** JSON-schema-ish parameters object; stringified for the bridge. */
  parameters: Record<string, unknown>;
}

export interface AppleFmChatOpts {
  /** per-call timeout; default 120_000ms. */
  timeoutMs?: number;
  /** caller-supplied system prompt, sent as the bridge's top-level "system" field. */
  system?: string;
}

export interface AppleFmToolChatOpts extends AppleFmChatOpts {
  /** per-line timeout; default 120_000ms. */
  timeoutMs?: number;
  /** abort the turn (kills the bridge child). */
  signal?: AbortSignal;
  /**
   * Executes a tool the model requested. Must resolve with the result text;
   * rejections are converted to "Error: ..." result text so the model can
   * react instead of the turn dying.
   */
  onToolCall: (name: string, argsJson: string) => Promise<string>;
}

/** One step of an Apple FM diagnostic run (Settings → Models → Run diagnostics). */
export interface AppleFmDiagStep {
  /** Machine key: 'environment' | 'probe' | 'inference'. */
  name: string;
  /** Human label: 'Environment', 'Bridge probe', 'Test inference'. */
  label: string;
  ok: boolean;
  /** Wall-clock milliseconds this step took. */
  ms: number;
  /**
   * Human-readable detail. On failure this is the REAL underlying text —
   * bridge stderr, exit codes, timeouts — never a generic "unavailable".
   */
  detail: string;
}

/** Full result of AppleFmClient.diagnose(). */
export interface AppleFmDiagnosis {
  ok: boolean;
  summary: string;
  steps: AppleFmDiagStep[];
}

const PROBE_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 120_000;
const DIAG_INFERENCE_TIMEOUT_MS = 90_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024; // 4MB response cap
const MAX_STDERR_BYTES = 64 * 1024; // 64KB stderr cap for diagnostics

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
      this.probeCache = {
        available: false,
        reason: 'applefm-bridge binary not found — one-time setup required',
        setupRequired: true,
      };
      return this.probeCache;
    }

    const child = spawn(binary, ['--probe'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Defensive: the bridge child must never surface a console/Terminal
      // window on macOS.
      windowsHide: true,
    });
    const result = await this.readFirstJsonLine<BridgeProbeOutput>(child, PROBE_TIMEOUT_MS);
    this.probeCache = result.ok
      ? {
          available: result.json.available,
          reason: result.json.reason,
          // Old bridge builds predate the handshake field — absence means no
          // tool calling, never assume support.
          toolCalling: result.json.toolCalling === true,
        }
      : { available: false, reason: result.reason };
    return this.probeCache;
  }

  /** True when the last probe reported tool-calling support (false until a successful probe). */
  get toolCallingSupported(): boolean {
    return this.probeCache?.toolCalling === true;
  }

  /**
   * Run one tool-free chat turn through the on-device model.
   *
   * For turns that carry tools, use chatWithTools() instead — it keeps the
   * bridge alive for the turn and services tool_call round-trips.
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

    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Defensive: the bridge child must never surface a console/Terminal
      // window on macOS.
      windowsHide: true,
    });
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

  /** Resolved bridge binary path, or null when none of the candidates exists. */
  binaryPath(): string | null {
    return this.findBinary();
  }

  /**
   * Step-by-step diagnostic run for Settings → Models → "Run diagnostics".
   *
   * Unlike probe()/chat(), every step is timed and failures carry the REAL
   * underlying text: the bridge's stderr output, exit codes, and exactly
   * which phase timed out. This exists to diagnose the live failure mode
   * where --probe reports available:true but chat() times out waiting for
   * the bridge — stderr capture is the key signal there, because the normal
   * chat path pipes stderr and never reads it.
   */
  async diagnose(): Promise<AppleFmDiagnosis> {
    const steps: AppleFmDiagStep[] = [];
    const step = (name: string, label: string, t0: number, ok: boolean, detail: string) => {
      steps.push({ name, label, ok, ms: Date.now() - t0, detail });
    };

    // -- step 1: environment -------------------------------------------------
    {
      const t0 = Date.now();
      if (os.platform() !== 'darwin') {
        step('environment', 'Environment', t0, false,
          `Apple Foundation Models requires macOS; this machine reports platform "${os.platform()}".`);
        return this.summarize(steps);
      }
      const binary = this.findBinary();
      if (!binary) {
        step('environment', 'Environment', t0, false,
          'No applefm-bridge binary found in any candidate location. ' +
          `Tried:\n${this.binaryCandidates.map((c) => `  • ${c || '(empty)'}`).join('\n')}\n` +
          'Fix: build the bridge on this Mac (Settings → Models shows the one-time setup steps).');
        return this.summarize(steps);
      }
      let sizeNote = '';
      try {
        const { statSync } = await import('node:fs');
        sizeNote = ` (${Math.round(statSync(binary).size / 1024)} KB)`;
      } catch { /* size is best-effort */ }
      step('environment', 'Environment', t0, true,
        `macOS ${os.release()}, ${os.arch()}. Bridge binary: ${binary}${sizeNote}.`);
    }

    // -- step 2: probe --------------------------------------------------------
    let probeOk = false;
    {
      const t0 = Date.now();
      try {
        // Bypass the cache: diagnostics must test the bridge right now.
        this.probeCache = null;
        const probe = await this.probe();
        probeOk = probe.available;
        step('probe', 'Bridge probe', t0, probe.available,
          probe.available
            ? `--probe answered in ${Date.now() - t0}ms: available=true, toolCalling=${probe.toolCalling === true}.`
            : `--probe failed: ${probe.reason ?? 'unknown reason'}.`);
      } catch (e) {
        step('probe', 'Bridge probe', t0, false,
          `probe() threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!probeOk) return this.summarize(steps);
    }

    // -- step 3: tiny inference with stderr capture ---------------------------
    {
      const t0 = Date.now();
      try {
        const r = await this.runInferenceCapture(
          [{ role: 'user', content: 'Reply with exactly: ok' }],
          DIAG_INFERENCE_TIMEOUT_MS
        );
        step('inference', 'Test inference', t0, true,
          `Bridge answered in ${r.ms}ms (first byte after ${r.firstByteMs}ms): "${r.text.slice(0, 200)}"` +
          (r.stderr ? `\nBridge stderr (informational):\n${r.stderr.slice(0, 2000)}` : ''));
      } catch (e) {
        const err = e as { message?: string; stderr?: string; phase?: string };
        step('inference', 'Test inference', t0, false,
          `${err.phase ? `[${err.phase}] ` : ''}${err.message ?? String(e)}` +
          (err.stderr ? `\n\nBridge stderr:\n${err.stderr.slice(0, 4000)}` : '\n\nBridge stderr: (empty — the bridge printed nothing before failing)'));
      }
    }

    return this.summarize(steps);
  }

  private summarize(steps: AppleFmDiagStep[]): AppleFmDiagnosis {
    const ok = steps.every((s) => s.ok);
    const failed = steps.filter((s) => !s.ok);
    return {
      ok,
      steps,
      summary: ok
        ? 'All checks passed — the bridge probes and answers inference.'
        : `Failed at: ${failed.map((s) => s.label).join(', ')}. See step details below.`,
    };
  }

  /**
   * Minimal chat turn used ONLY by diagnose(): spawns the bridge, sends one
   * request, and — unlike chat() — captures stderr so the real failure text
   * survives. Throws an Error with .phase ('spawn'|'write'|'wait'|'parse')
   * and .stderr attached.
   */
  private runInferenceCapture(
    messages: AppleFmMessage[],
    timeoutMs: number
  ): Promise<{ text: string; stderr: string; ms: number; firstByteMs: number }> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const binary = this.findBinary();
      if (!binary) {
        const e = new Error('bridge binary disappeared between probe and inference') as Error & { phase: string };
        e.phase = 'spawn';
        reject(e);
        return;
      }
      const id = this.nextId++;
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      let firstByteAt = 0;
      let settled = false;

      const fail = (phase: string, message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.kill(child);
        const e = new Error(message) as Error & { phase: string; stderr: string };
        e.phase = phase;
        e.stderr = stderr;
        reject(e);
      };
      const done = (text: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.kill(child);
        resolve({ text, stderr, ms: Date.now() - t0, firstByteMs: firstByteAt ? firstByteAt - t0 : Date.now() - t0 });
      };

      const timer = setTimeout(() => {
        fail('wait',
          `timed out after ${timeoutMs}ms waiting for the bridge ` +
          `(child ${child.exitCode === null && !child.killed ? 'still running' : 'already exited'}; ` +
          `stdout so far: ${stdout.length} bytes, stderr so far: ${stderr.length} bytes). ` +
          'This is the live failure mode: the bridge accepts the request but never answers. ' +
          'Common causes: Apple Intelligence disabled, the on-device model still downloading, ' +
          'or the bridge hanging in session creation — check the stderr text above.');
      }, timeoutMs);
      timer.unref?.();

      child.on('error', (err) => fail('spawn', `failed to spawn bridge: ${(err as Error)?.message ?? String(err)}`));
      child.stdout!.on('data', (d: Buffer) => {
        if (!firstByteAt) firstByteAt = Date.now();
        stdout += d.toString('utf8');
        if (stdout.length > MAX_LINE_BYTES) {
          fail('wait', 'bridge response exceeded 4MB');
          return;
        }
        const nl = stdout.indexOf('\n');
        if (nl >= 0) {
          try {
            const json = JSON.parse(stdout.slice(0, nl)) as BridgeChatResponse;
            if (typeof json.error === 'string') fail('parse', `bridge returned error: ${json.error}`);
            else if (typeof json.text === 'string') done(json.text);
            else fail('parse', 'bridge returned a JSON line with no "text" or "error" field');
          } catch {
            fail('parse', `bridge returned invalid JSON: ${stdout.slice(0, 200)}`);
          }
        }
      });
      child.stderr!.on('data', (d: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += d.toString('utf8').slice(0, MAX_STDERR_BYTES - stderr.length);
      });
      child.on('close', (code) => {
        fail('wait', code === 0
          ? 'bridge exited (code 0) without answering — it likely crashed before writing a response line'
          : `bridge exited with code ${code} without answering`);
      });

      const request = JSON.stringify({ id, op: 'chat', system: '', messages }) + '\n';
      child.stdin!.write(request, (err) => {
        if (err) fail('write', `failed to write request to bridge: ${String(err)}`);
        else child.stdin!.end();
      });
    });
  }

  /**
   * Run one tool-bearing chat turn. The bridge child stays alive for the
   * turn: it emits {"id","tool_call":{callId,name,arguments}} lines, this
   * method executes opts.onToolCall for each, writes back
   * {"id","tool_result":{callId,result}}, and resolves with the final text.
   * The child is always killed before resolving or throwing.
   */
  async chatWithTools(
    messages: AppleFmMessage[],
    tools: AppleFmToolDef[],
    opts: AppleFmToolChatOpts
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
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
    if (tools.length === 0) {
      throw new Error('Apple Foundation Models: chatWithTools needs at least one tool — use chat() for tool-free turns');
    }

    const id = this.nextId++;
    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = new ChildLineReader(child);
    const writeLine = (obj: unknown): void => {
      try {
        child.stdin!.write(JSON.stringify(obj) + '\n');
      } catch {
        /* child going away — the read side will surface it */
      }
    };
    writeLine({
      id,
      op: 'chat',
      system: opts.system ?? '',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: JSON.stringify(t.parameters ?? {}),
      })),
    });

    const onAbort = () => this.kill(child);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const raw = await lines.nextLine(timeoutMs);
        let msg: BridgeToolTurnLine;
        try {
          msg = JSON.parse(raw) as BridgeToolTurnLine;
        } catch {
          throw new Error('Apple Foundation Models unavailable: bridge returned invalid JSON');
        }
        if (msg.id !== id) {
          throw new Error('Apple Foundation Models unavailable: bridge returned a mismatched response id');
        }
        if (msg.tool_call) {
          const call = msg.tool_call;
          let result: string;
          try {
            result = await opts.onToolCall(call.name, typeof call.arguments === 'string' ? call.arguments : '{}');
          } catch (e) {
            // Never let a tool executor exception kill the turn — feed the
            // failure back as result text so the model can react to it.
            result = `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
          writeLine({ id, tool_result: { callId: call.callId, result } });
          continue;
        }
        if (typeof msg.error === 'string') {
          throw new Error(`Apple Foundation Models unavailable: ${msg.error}`);
        }
        if (typeof msg.text === 'string') {
          return msg.text;
        }
        throw new Error('Apple Foundation Models unavailable: bridge returned an unrecognized line');
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        child.stdin!.end();
      } catch {
        /* already gone */
      }
      this.kill(child);
    }
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
  /** Absent on bridge builds that predate tool calling — never assume support. */
  toolCalling?: boolean;
}

/** One line of a tool-bearing turn: a tool_call, the final text, or an error. */
interface BridgeToolTurnLine {
  id: unknown;
  tool_call?: { callId: number; name: string; arguments?: string };
  text?: string;
  error?: string;
}

/**
 * Buffered newline reader over a child's stdout. The tool turn reads many
 * lines; a shared buffer guarantees no byte is lost between reads.
 */
class ChildLineReader {
  private buf = '';
  private lines: string[] = [];
  private waiters: Array<{ resolve: (line: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  private ended = false;

  constructor(child: ChildProcess) {
    child.stdout!.on('data', (d: Buffer) => this.feed(d.toString('utf8')));
    const end = () => this.feed(null);
    child.on('close', end);
    child.on('error', end);
  }

  private feed(chunk: string | null): void {
    if (chunk === null) {
      this.ended = true;
    } else {
      if (this.buf.length + chunk.length > MAX_LINE_BYTES * 4) {
        this.failAll(new Error('Apple Foundation Models unavailable: bridge output exceeded buffer cap'));
        return;
      }
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        this.lines.push(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
      }
    }
    this.pump();
  }

  private pump(): void {
    while (this.waiters.length > 0 && this.lines.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.resolve(this.lines.shift()!);
    }
    if (this.ended) {
      this.failAll(new Error('Apple Foundation Models unavailable: bridge closed the connection'));
    }
  }

  private failAll(e: Error): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  nextLine(timeoutMs: number): Promise<string> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.ended) return Promise.reject(new Error('Apple Foundation Models unavailable: bridge closed the connection'));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`Apple Foundation Models unavailable: timed out after ${timeoutMs}ms waiting for the bridge`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
  }
}

type ReadResult<T> =
  | { ok: true; json: T }
  | { ok: false; reason: string };
