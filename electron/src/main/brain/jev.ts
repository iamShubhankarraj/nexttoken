/**
 * Typed client for Jev — TypeSafe AI's System One decision model.
 *
 * Jev takes application state + typed questions and returns calibrated
 * probabilistic decisions (choices, scores, yes/no probabilities) in
 * ~70–500ms, far faster/cheaper than an LLM round-trip. It never generates
 * text, so it can never hallucinate a value outside the schema we define.
 *
 * API shape reference: src/main/brain/docs/jev-api.md
 *
 * Design notes:
 * - The client never throws for transport/API problems. It returns
 *   `{ ok: false, reason }` so callers can degrade gracefully to local
 *   heuristics or LLM routing. It throws only for programmer errors
 *   (invalid question construction).
 * - Key handling: the runtime path resolves the key on every call from the
 *   OS keychain via JevCredentialStore (credentials.ts) through the
 *   `keyProvider` callback — the raw key is never held in app state longer
 *   than a single request and never appears in logs or error messages.
 *   `config.apiKey` exists only for transient flows (the Settings Validate
 *   button, tests) and is never persisted by this client.
 * - Timeout is short on purpose: Jev should answer in milliseconds; anything
 *   slower than ~2s is treated as a failure, not waited on.
 */

export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const JEV_DEFAULT_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 2000;
const JEV_MAX_RETRIES = 2;
/** Backoff between retries: 250ms, then 1s. */
const RETRY_DELAYS_MS = [250, 1000];

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

export interface JevChoiceQuestion {
  type: 'choice';
  /** What the model is deciding, e.g. "Primary intent of this voice command". */
  instructions: string;
  /** option key -> human description. Include an 'other' option. */
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** 2–10 ordered levels, low to high. Index 0 is the first entry. */
  criteria: string[];
}

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

/** State is whatever the decision needs: text, a JSON object, or an array of strings. */
export type JevState = string | Record<string, unknown> | unknown[];

// ---------------------------------------------------------------------------
// Answer types
// ---------------------------------------------------------------------------

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevScoreAnswer {
  type: 'score';
  /** Probability-weighted mean of level indices; can land between levels. */
  score: number;
  legend: Record<string, string>;
  /** Keyed by index as strings: "0", "1", ... */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: 'noul';
  /** Probability the answer is "yes". No confidence field by design. */
  noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type JevUnavailableReason =
  | 'no-key'
  | 'unreachable'
  | 'auth'
  | 'bad-request'
  | 'rate-limited';

export interface JevUnavailable {
  ok: false;
  reason: JevUnavailableReason;
  /** Safe to log; never contains the API key. */
  message: string;
}

export interface JevDecision {
  ok: true;
  answers: Record<string, JevAnswer>;
  latencyMs: number;
  model: string;
}

export type JevCall = JevDecision | JevUnavailable;

export interface JevConfig {
  /**
   * TypeSafe API key for transient use only (the Settings "Validate" button
   * flow, tests). It is never persisted by this client.
   * The runtime path must use `keyProvider` -> JevCredentialStore instead.
   */
  apiKey?: string;
  /**
   * Runtime key source: called on every decide() so saving/rotating the key
   * in the OS keychain takes effect immediately without reconstructing the
   * client. Wiring: () => jevCredentialStore.loadKey().
   * Takes precedence over `apiKey` when it returns a non-empty key.
   */
  keyProvider?: () => string | null;
  baseUrl?: string;
  model?: string;
  /** Per-attempt timeout. Default 2000ms. */
  timeoutMs?: number;
  /** Retries on network errors / 5xx. Default 2. */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Validation (programmer errors -> throw before any network call)
// ---------------------------------------------------------------------------

function validateQuestions(questions: Record<string, JevQuestion>): void {
  const names = Object.keys(questions);
  if (names.length === 0) throw new Error('Jev: at least one question is required');
  if (names.length > 100) throw new Error('Jev: too many questions in one call');
  for (const name of names) {
    const q = questions[name];
    if (!q || typeof q.instructions !== 'string' || q.instructions.trim().length === 0) {
      throw new Error(`Jev: question "${name}" needs non-empty instructions`);
    }
    if (q.type === 'choice') {
      const opts = Object.keys(q.criteria ?? {});
      if (opts.length === 0) throw new Error(`Jev: choice "${name}" needs at least one option`);
      if (opts.length > 255) throw new Error(`Jev: choice "${name}" exceeds 255 options`);
    } else if (q.type === 'score') {
      const levels = q.criteria ?? [];
      if (levels.length < 2 || levels.length > 10) {
        throw new Error(`Jev: score "${name}" needs 2–10 rubric levels`);
      }
    } else if (q.type !== 'noul') {
      throw new Error(`Jev: question "${name}" has unknown type`);
    }
  }
}

// ---------------------------------------------------------------------------
// Response parsing (defensive: accept official + known proxy envelopes)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseAnswer(raw: unknown): JevAnswer | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  if (raw.type === 'choice' && typeof raw.choice === 'string') {
    return {
      type: 'choice',
      choice: raw.choice,
      confidence: asNumber(raw.confidence),
      probabilities: isRecord(raw.probabilities)
        ? Object.fromEntries(Object.entries(raw.probabilities).map(([k, v]) => [k, asNumber(v)]))
        : {}
    };
  }
  if (raw.type === 'score') {
    return {
      type: 'score',
      score: asNumber(raw.score),
      legend: isRecord(raw.legend)
        ? Object.fromEntries(Object.entries(raw.legend).map(([k, v]) => [k, String(v)]))
        : {},
      probabilities: isRecord(raw.probabilities)
        ? Object.fromEntries(Object.entries(raw.probabilities).map(([k, v]) => [k, asNumber(v)]))
        : {},
      confidence: asNumber(raw.confidence)
    };
  }
  if (raw.type === 'noul') {
    return { type: 'noul', noul: asNumber(raw.noul) };
  }
  return null;
}

function extractAnswers(body: unknown): Record<string, JevAnswer> | null {
  if (!isRecord(body)) return null;
  const candidates: unknown[] = [
    body.answers,
    isRecord(body.data) ? body.data.answers : undefined,
    Array.isArray(body.results) && body.results.length > 0 && isRecord(body.results[0])
      ? body.results[0].answers
      : undefined
  ];
  for (const c of candidates) {
    if (!isRecord(c)) continue;
    const answers: Record<string, JevAnswer> = {};
    let any = false;
    for (const [k, v] of Object.entries(c)) {
      const a = parseAnswer(v);
      if (a) {
        answers[k] = a;
        any = true;
      }
    }
    if (any) return answers;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class JevClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private apiKey: string;
  private keyProvider: (() => string | null) | null;

  constructor(config: JevConfig) {
    this.apiKey = (config.apiKey ?? '').trim();
    this.keyProvider = config.keyProvider ?? null;
    this.baseUrl = (config.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = config.model ?? JEV_DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? JEV_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? JEV_MAX_RETRIES;
  }

  /** Swap the transient key at runtime (e.g. the Validate-button flow). */
  setApiKey(apiKey: string): void {
    this.apiKey = (apiKey ?? '').trim();
  }

  /** Swap the runtime key source (e.g. after the credential store is ready). */
  setKeyProvider(provider: (() => string | null) | null): void {
    this.keyProvider = provider;
  }

  /** Resolve the key for this call: secure store first, transient key second. */
  private resolveKey(): string | null {
    try {
      const fromStore = this.keyProvider?.();
      if (fromStore && fromStore.trim().length > 0) return fromStore.trim();
    } catch {
      /* a failing provider must not break the call path */
    }
    return this.apiKey.length > 0 ? this.apiKey : null;
  }

  get configured(): boolean {
    return this.resolveKey() !== null;
  }

  /**
   * Evaluate a batch of typed questions against state in one parallel call.
   * Never throws for transport/API problems — returns { ok: false } instead.
   */
  async decide(
    questions: Record<string, JevQuestion>,
    state: JevState,
    opts?: { signal?: AbortSignal }
  ): Promise<JevCall> {
    validateQuestions(questions);
    const key = this.resolveKey();
    if (!key) {
      return { ok: false, reason: 'no-key', message: 'Jev API key is not configured' };
    }

    const started = Date.now();
    const body = JSON.stringify({ state, questions, model: this.model });

    let lastError = 'unknown error';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (opts?.signal?.aborted) {
        return { ok: false, reason: 'unreachable', message: 'Jev call aborted' };
      }
      if (attempt > 0) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      const onAbort = () => ac.abort();
      opts?.signal?.addEventListener('abort', onAbort);
      try {
        const res = await fetch(`${this.baseUrl}/v1/systemone`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // The key lives only in this header and the keychain; it is never logged.
            Authorization: `Bearer ${key}`
          },
          body,
          signal: ac.signal
        });

        if (res.status === 401 || res.status === 403) {
          return { ok: false, reason: 'auth', message: 'Jev rejected the API key (401/403)' };
        }
        if (res.status === 429) {
          return { ok: false, reason: 'rate-limited', message: 'Jev rate limit reached (429)' };
        }
        if (res.status === 400) {
          const detail = await safeErrorDetail(res);
          return { ok: false, reason: 'bad-request', message: `Jev rejected the request: ${detail}` };
        }
        if (res.status >= 500) {
          lastError = `Jev upstream error ${res.status}`;
          continue; // retry
        }
        if (!res.ok) {
          return { ok: false, reason: 'unreachable', message: `Jev returned HTTP ${res.status}` };
        }

        const parsed: unknown = await res.json().catch(() => null);
        const answers = extractAnswers(parsed);
        if (!answers) {
          return { ok: false, reason: 'bad-request', message: 'Jev returned an unrecognized response shape' };
        }
        const model =
          (isRecord(parsed) && typeof parsed.model === 'string' && parsed.model) || this.model;
        const latencyMs =
          (isRecord(parsed) && asNumber((parsed as Record<string, unknown>).latency_ms, -1) >= 0
            ? asNumber((parsed as Record<string, unknown>).latency_ms)
            : Date.now() - started);
        return { ok: true, answers, latencyMs, model };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        // Network failure / timeout -> retry while attempts remain.
      } finally {
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onAbort);
      }
    }
    return { ok: false, reason: 'unreachable', message: `Jev unreachable: ${lastError}` };
  }

  // -- convenience one-question calls ----------------------------------------

  async classify(
    state: JevState,
    instructions: string,
    criteria: Record<string, string>,
    opts?: { signal?: AbortSignal }
  ): Promise<
    | { ok: true; choice: string; confidence: number; probabilities: Record<string, number> }
    | JevUnavailable
  > {
    const r = await this.decide({ intent: { type: 'choice', instructions, criteria } }, state, opts);
    if (!r.ok) return r;
    const a = r.answers.intent;
    if (!a || a.type !== 'choice') {
      return { ok: false, reason: 'bad-request', message: 'Jev did not return a choice answer' };
    }
    return { ok: true, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  }

  async booleanCheck(
    state: JevState,
    instructions: string,
    opts?: { signal?: AbortSignal }
  ): Promise<{ ok: true; probability: number } | JevUnavailable> {
    const r = await this.decide({ check: { type: 'noul', instructions } }, state, opts);
    if (!r.ok) return r;
    const a = r.answers.check;
    if (!a || a.type !== 'noul') {
      return { ok: false, reason: 'bad-request', message: 'Jev did not return a noul answer' };
    }
    return { ok: true, probability: a.noul };
  }

  async score(
    state: JevState,
    instructions: string,
    levels: string[],
    opts?: { signal?: AbortSignal }
  ): Promise<{ ok: true; score: number; legend: Record<string, string> } | JevUnavailable> {
    const r = await this.decide({ grade: { type: 'score', instructions, criteria: levels } }, state, opts);
    if (!r.ok) return r;
    const a = r.answers.grade;
    if (!a || a.type !== 'score') {
      return { ok: false, reason: 'bad-request', message: 'Jev did not return a score answer' };
    }
    return { ok: true, score: a.score, legend: a.legend };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && typeof body.error === 'string' && body.error.length > 0) {
      return body.error.slice(0, 200);
    }
  } catch {
    /* fall through */
  }
  return `HTTP ${res.status}`;
}

/** Type-narrowing helpers for answer records. */
export function asChoice(a: JevAnswer | undefined): JevChoiceAnswer | null {
  return a && a.type === 'choice' ? a : null;
}
export function asScore(a: JevAnswer | undefined): JevScoreAnswer | null {
  return a && a.type === 'score' ? a : null;
}
export function asNoul(a: JevAnswer | undefined): JevNoulAnswer | null {
  return a && a.type === 'noul' ? a : null;
}
