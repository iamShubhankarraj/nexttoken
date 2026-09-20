/**
 * Tier router for the Next Token agent's LLM calls.
 *
 * Priority: on-device first, cloud BYOK as fallback.
 *   tier 1 — Apple Foundation Models (free, private, always on-device)
 *   tier 2 — local llama-server (downloaded GGUF models, OpenAI-compatible)
 *   tier 3 — cloud BYOK (the user's configured provider)
 *
 * The per-task assignment ('apple-fm' | 'cloud' | <modelId>) is chosen in
 * Settings → Models and stored in store.d.models.assignment. The router
 * degrades gracefully: if the assigned tier can't serve (binary missing,
 * model not downloaded, Apple FM unavailable, no tool support), it falls
 * through to the next tier instead of failing the run.
 *
 * Apple Foundation Models has no tool calling, so tool-bearing turns skip
 * tier 1 automatically.
 */

import type { Store } from '../store';
import { MODEL_CATALOG, type ModelEntry } from '../models';
import type { AppleFmClient, AppleFmMessage } from '../models/applefm';
import type { LlamaServer, ServerSlot } from '../models/runtime';
import { chatComplete, type LlmMessage, type LlmResult, type LlmToolDef } from './llm';

/** Assignment sentinel refs — must match the ModelsPanel UI constants. */
export const APPLE_FM_REF = 'apple-fm';
export const CLOUD_REF = 'cloud';

export type AgentTask = 'chat' | 'vision';

export interface RouterDeps {
  store: Store;
  appleFm: AppleFmClient;
  llama: LlamaServer;
}

export interface RouteResult {
  result: LlmResult;
  /** Which tier served the turn: 'apple-fm' | 'local:<modelId>' | 'cloud'. */
  via: string;
}

/** Tolerate the pre-standardisation 'applefm' spelling from early installs. */
function normalizeRef(ref: string): string {
  return ref === 'applefm' ? APPLE_FM_REF : ref;
}

function catalogEntry(id: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((e) => e.id === id);
}

function isDownloaded(store: Store, id: string): boolean {
  return !!store.d.models.downloaded[id];
}

function firstDownloaded(store: Store, task: 'chat' | 'vision'): ModelEntry | null {
  for (const e of MODEL_CATALOG) {
    if (e.task === task && isDownloaded(store, e.id)) return e;
  }
  return null;
}

function slotFor(task: AgentTask): ServerSlot {
  return task === 'vision' ? 'vision' : 'chat';
}

async function appleFmTurn(
  deps: RouterDeps,
  messages: LlmMessage[],
  signal?: AbortSignal
): Promise<LlmResult> {
  const probe = await deps.appleFm.probe();
  if (!probe.available) {
    throw new Error(`Apple Foundation Models unavailable: ${probe.reason ?? 'unknown reason'}`);
  }
  if (signal?.aborted) throw new Error('Aborted');
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest: AppleFmMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      rest.push({ role: 'user', content: `[tool result] ${m.content}` });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      // Shouldn't happen (we skip this tier for tool turns), but stay safe.
      rest.push({ role: 'assistant', content: m.content });
      continue;
    }
    rest.push({ role: m.role, content: m.content });
  }
  const text = await deps.appleFm.chat(rest, { system });
  return { text, toolCalls: [] };
}

async function localTurn(
  deps: RouterDeps,
  entry: ModelEntry,
  task: AgentTask,
  messages: LlmMessage[],
  tools: LlmToolDef[],
  signal?: AbortSignal
): Promise<LlmResult> {
  const slot = slotFor(task);
  const st = deps.llama.status(slot);
  let base = deps.llama.url(slot);
  if (!base || st.modelId !== entry.id) {
    base = await deps.llama.start(entry, slot);
  }
  return chatComplete({
    baseUrl: base,
    api: 'openai',
    apiKey: '',
    model: entry.id,
    messages,
    tools,
    signal
  });
}

async function cloudTurn(
  deps: RouterDeps,
  messages: LlmMessage[],
  tools: LlmToolDef[],
  signal?: AbortSignal
): Promise<LlmResult> {
  const p = deps.store.d.provider;
  const apiKey = deps.store.getApiKey() ?? '';
  if (p.presetId !== 'ollama' && !apiKey) {
    throw new Error(
      'No API key configured and no local model available. ' +
        'Open Settings → AI Provider to add a key, or Settings → Models to download an on-device model.'
    );
  }
  return chatComplete({
    baseUrl: p.baseUrl,
    api: p.api,
    apiKey,
    model: p.model,
    messages,
    tools,
    signal
  });
}

/**
 * Run one chat turn through the tier chain for `task`.
 * Throws only when every tier failed, with all tier errors joined.
 */
export async function routeChat(
  deps: RouterDeps,
  opts: { task: AgentTask; messages: LlmMessage[]; tools: LlmToolDef[]; signal?: AbortSignal }
): Promise<RouteResult> {
  const rawRef = deps.store.d.models.assignment[opts.task] ?? (opts.task === 'chat' ? APPLE_FM_REF : CLOUD_REF);
  const ref = normalizeRef(rawRef);
  const errors: string[] = [];

  type Attempt = () => Promise<RouteResult>;
  const attempts: Attempt[] = [];
  const appleFmAttempt: Attempt = async () => {
    if (opts.tools.length > 0) throw new Error('Apple Foundation Models has no tool calling — skipping tier');
    return { result: await appleFmTurn(deps, opts.messages, opts.signal), via: APPLE_FM_REF };
  };
  const localAttempt = (entry: ModelEntry): Attempt => async () => ({
    result: await localTurn(deps, entry, opts.task, opts.messages, opts.tools, opts.signal),
    via: `local:${entry.id}`
  });
  const cloudAttempt: Attempt = async () => ({
    result: await cloudTurn(deps, opts.messages, opts.tools, opts.signal),
    via: CLOUD_REF
  });

  if (ref === APPLE_FM_REF) {
    attempts.push(appleFmAttempt);
    const dl = firstDownloaded(deps.store, opts.task === 'vision' ? 'vision' : 'chat');
    if (dl) attempts.push(localAttempt(dl));
    attempts.push(cloudAttempt);
  } else if (ref === CLOUD_REF) {
    attempts.push(cloudAttempt);
  } else {
    const entry = catalogEntry(ref);
    if (entry && isDownloaded(deps.store, ref)) {
      attempts.push(localAttempt(entry));
    } else {
      errors.push(`Assigned model "${ref}" is not downloaded`);
    }
    attempts.push(cloudAttempt);
  }

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(`All model tiers failed: ${errors.join(' | ')}`);
}
