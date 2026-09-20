/**
 * ModelRouter — the single place that resolves "which model answers" and
 * performs the completion.
 *
 * Every LLM call in the app funnels through complete():
 *   - agent panel chat (src/main/agent/loop.ts, via routeChat)
 *   - slash commands + skills (same agent pipeline)
 *   - writing help / follow-up suggestions (they send agent chat messages)
 *   - page summarization (same agent pipeline)
 *   - the brain / voice pipeline's text side (src/main/brain/orchestrator.ts,
 *     via createRouterChat)
 *
 * The ACTIVE model (chosen in the Agent tab switcher, persisted in
 * store.d.models.activeModel) is always tried first:
 *   local-applefm -> Apple Foundation Models sidecar
 *   local:<modelId> -> downloaded GGUF via the llama.cpp server
 *   cloud:<providerId> -> the provider's endpoint + key from the OS keychain
 *
 * Fallback chain (never silent — the caller is told which model answered):
 *   other enabled cloud providers -> Apple FM (no tool calls) ->
 *   first downloaded GGUF chat model -> clear error listing every failure.
 *
 * The 'vision' task keeps its legacy per-task assignment
 * (store.d.models.assignment.vision); everything else uses the active model.
 */

import type { Store, ProviderPersist } from '../store';
import type { AppleFmClient, AppleFmMessage } from './applefm';
import type { LlamaServer, ServerSlot } from './runtime';
import { MODEL_CATALOG, type ModelEntry } from './index';
import { PROVIDER_PRESETS } from '../../shared/ipc';
import type {
  ActiveModelRef, ModelChoice, ProviderValidateInput
} from '../../shared/ipc';
import {
  chatComplete, testConnection,
  type LlmMessage, type LlmResult, type LlmToolCall, type LlmToolDef
} from '../agent/llm';

export interface RouterDeps {
  store: Store;
  appleFm: AppleFmClient;
  llama: LlamaServer;
}

export interface CompleteOpts {
  /** 'chat' (default) uses the active model; 'vision' uses the vision assignment. */
  task?: 'chat' | 'vision';
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  toolCalls: LlmToolCall[];
  /** Human-readable source, e.g. "OpenAI · gpt-5". */
  via: string;
  /** Machine ref of the model that actually answered. */
  viaRef: string;
  /** True when the active model's attempt failed and a fallback answered. */
  fallbackUsed: boolean;
  /** Human sentence explaining the fallback — surface it in the UI. */
  fallbackNote?: string;
}

interface Attempt {
  label: string;
  viaRef: string;
  run: () => Promise<LlmResult>;
}

function failing(label: string, viaRef: string, message: string): Attempt {
  return { label, viaRef, run: () => Promise.reject(new Error(message)) };
}

function catalogEntry(id: string | undefined): ModelEntry | undefined {
  if (!id) return undefined;
  return MODEL_CATALOG.find((e) => e.id === id);
}

/** Does this provider's preset require an API key (Ollama doesn't)? */
export function providerNeedsKey(p: { presetId: string }): boolean {
  return PROVIDER_PRESETS.find((x) => x.id === p.presetId)?.needsKey ?? true;
}

export class ModelRouter {
  constructor(private readonly deps: RouterDeps) {}

  // -- selection ------------------------------------------------------------

  getActive(): ActiveModelRef {
    return { ...this.deps.store.d.models.activeModel };
  }

  setActive(ref: ActiveModelRef): ActiveModelRef {
    const kind = ref?.kind;
    if (kind !== 'local-applefm' && kind !== 'local' && kind !== 'cloud') {
      throw new Error('Unknown model selection.');
    }
    if (kind === 'local' && !catalogEntry(ref.id)) {
      throw new Error(`Unknown model "${ref.id ?? ''}".`);
    }
    if (kind === 'cloud' && !this.providerById(ref.id)) {
      throw new Error('Provider not found.');
    }
    this.deps.store.d.models.activeModel = kind === 'local-applefm' ? { kind } : { kind, id: ref.id };
    this.deps.store.saveSoon();
    return this.getActive();
  }

  /** Every selectable model, grouped for the Agent tab switcher. */
  async listChoices(): Promise<ModelChoice[]> {
    const store = this.deps.store;
    const out: ModelChoice[] = [];

    // -- Local --------------------------------------------------------------
    let probe: { available: boolean; reason?: string } = { available: false, reason: 'unavailable' };
    try {
      probe = await this.deps.appleFm.probe();
    } catch {
      probe = { available: false, reason: 'probe failed' };
    }
    out.push({
      ref: { kind: 'local-applefm' },
      label: 'Apple Foundation Models',
      detail: 'On-device · macOS',
      group: 'local',
      available: probe.available,
      unavailableReason: probe.available ? undefined : (probe.reason ?? 'Unavailable on this device')
    });
    for (const e of MODEL_CATALOG) {
      if (e.task !== 'chat') continue;
      if (!store.d.models.downloaded[e.id]) continue;
      out.push({
        ref: { kind: 'local', id: e.id },
        label: e.name,
        detail: `On-device · ${e.params} ${e.quant}`,
        group: 'local',
        available: true
      });
    }

    // -- Cloud --------------------------------------------------------------
    for (const p of store.d.providers) {
      if (!p.enabled) continue;
      const usable = this.providerUsable(p);
      out.push({
        ref: { kind: 'cloud', id: p.id },
        label: p.name,
        detail: p.model || 'no model set',
        group: 'cloud',
        available: usable,
        unavailableReason: usable ? undefined : (providerNeedsKey(p) ? 'No API key saved' : 'Not configured')
      });
    }
    return out;
  }

  // -- completion -----------------------------------------------------------

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const tools = opts.tools ?? [];
    const task = opts.task ?? 'chat';
    const primary = await this.primaryAttempt(task, opts.messages, tools, opts.signal);
    const fallbacks = this.fallbackAttempts(task, primary.viaRef, tools, opts.messages, opts.signal);
    const errors: string[] = [];
    const attempts = [primary, ...fallbacks];
    for (let i = 0; i < attempts.length; i++) {
      try {
        const r = await attempts[i].run();
        const fallbackUsed = i > 0;
        return {
          text: r.text,
          toolCalls: r.toolCalls,
          via: attempts[i].label,
          viaRef: attempts[i].viaRef,
          fallbackUsed,
          fallbackNote: fallbackUsed
            ? `“${primary.label}” unavailable (${errors[0]}); answered by ${attempts[i].label}.`
            : undefined
        };
      } catch (e) {
        // A user cancel is final — never cascade an explicit abort through fallbacks.
        if (opts.signal?.aborted) throw e;
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    throw new Error(`All models failed: ${errors.join(' | ')}`);
  }

  /** Validate a saved provider or a set of unsaved fields (Test button). */
  async validateProvider(input: ProviderValidateInput): Promise<{ ok: boolean; message: string }> {
    const store = this.deps.store;
    let baseUrl = input.baseUrl?.trim() ?? '';
    let api: 'openai' | 'anthropic' = input.api ?? 'openai';
    let model = input.model?.trim() ?? '';
    let apiKey = input.apiKey?.trim() ?? '';
    if (input.id) {
      const p = this.providerById(input.id);
      if (!p) return { ok: false, message: 'Provider not found.' };
      if (!baseUrl) baseUrl = p.baseUrl;
      if (!input.api) api = p.api;
      if (!model) model = p.model;
      if (!apiKey) apiKey = store.getProviderKey(p.id) ?? '';
    }
    if (!baseUrl) return { ok: false, message: 'Enter a base URL first.' };
    if (!model) return { ok: false, message: 'Enter a model id first.' };
    const t = await testConnection({ baseUrl, api, apiKey, model });
    return {
      ok: t.ok,
      message: t.ok ? `Connected${t.model ? ` · ${t.model}` : ''}.` : `Failed: ${t.error ?? 'unknown error'}`
    };
  }

  // -- attempt builders -----------------------------------------------------

  private providerById(id: string | undefined): ProviderPersist | undefined {
    if (!id) return undefined;
    return this.deps.store.d.providers.find((p) => p.id === id);
  }

  private providerUsable(p: ProviderPersist): boolean {
    if (!p.enabled) return false;
    if (!p.baseUrl || !p.model) return false;
    if (providerNeedsKey(p) && !this.deps.store.providerKeyConfigured(p.id)) return false;
    return true;
  }

  private async primaryAttempt(
    task: 'chat' | 'vision',
    messages: LlmMessage[],
    tools: LlmToolDef[],
    signal?: AbortSignal
  ): Promise<Attempt> {
    if (task === 'vision') return this.visionPrimary(messages, tools, signal);
    const active = this.deps.store.d.models.activeModel ?? { kind: 'local-applefm' as const };
    switch (active.kind) {
      case 'local-applefm':
        return {
          label: 'Apple Foundation Models', viaRef: 'local-applefm',
          run: () => this.appleFmTurn(messages, tools, signal)
        };
      case 'local': {
        const entry = catalogEntry(active.id);
        if (entry && this.deps.store.d.models.downloaded[active.id!]) {
          return {
            label: entry.name, viaRef: `local:${entry.id}`,
            run: () => this.localTurn(entry, task, messages, tools, signal)
          };
        }
        return failing(active.id ?? 'model', `local:${active.id ?? ''}`,
          `Model “${active.id ?? 'unknown'}” is not downloaded — open Settings → Models to download it.`);
      }
      case 'cloud': {
        const p = this.providerById(active.id);
        if (!p) return failing('provider', `cloud:${active.id ?? ''}`, 'Cloud provider not found — pick another model.');
        if (!p.enabled) {
          return failing(p.name, `cloud:${p.id}`, `${p.name} is disabled — enable it in Settings → Providers.`);
        }
        return {
          label: `${p.name} · ${p.model}`, viaRef: `cloud:${p.id}`,
          run: () => this.cloudTurn(p, messages, tools, signal)
        };
      }
    }
  }

  /** The vision task keeps its dedicated per-task assignment. */
  private visionPrimary(messages: LlmMessage[], tools: LlmToolDef[], signal?: AbortSignal): Attempt {
    const ref = this.deps.store.d.models.assignment.vision ?? 'cloud';
    if (ref === 'apple-fm' || ref === 'applefm') {
      return {
        label: 'Apple Foundation Models', viaRef: 'local-applefm',
        run: () => this.appleFmTurn(messages, tools, signal)
      };
    }
    if (ref !== 'cloud') {
      const entry = catalogEntry(ref);
      if (entry && this.deps.store.d.models.downloaded[ref]) {
        return {
          label: entry.name, viaRef: `local:${entry.id}`,
          run: () => this.localTurn(entry, 'vision', messages, tools, signal)
        };
      }
    }
    const p = this.deps.store.d.providers.find((x) => x.enabled && this.providerUsable(x));
    if (!p) {
      return failing('cloud', 'cloud', 'No usable cloud provider for the vision task — configure one in Settings → Providers.');
    }
    return {
      label: `${p.name} · ${p.model}`, viaRef: `cloud:${p.id}`,
      run: () => this.cloudTurn(p, messages, tools, signal)
    };
  }

  private fallbackAttempts(
    task: 'chat' | 'vision',
    excludeViaRef: string,
    tools: LlmToolDef[],
    messages: LlmMessage[],
    signal?: AbortSignal
  ): Attempt[] {
    const out: Attempt[] = [];
    // 1. Other enabled cloud providers with keys.
    for (const p of this.deps.store.d.providers) {
      if (`cloud:${p.id}` === excludeViaRef) continue;
      if (!this.providerUsable(p)) continue;
      out.push({
        label: `${p.name} · ${p.model}`, viaRef: `cloud:${p.id}`,
        run: () => this.cloudTurn(p, messages, tools, signal)
      });
    }
    // 2. Apple FM — text only, never for tool-bearing turns.
    if (tools.length === 0 && excludeViaRef !== 'local-applefm') {
      out.push({
        label: 'Apple Foundation Models', viaRef: 'local-applefm',
        run: () => this.appleFmTurn(messages, [], signal)
      });
    }
    // 3. First downloaded GGUF chat model.
    const dl = this.firstDownloaded('chat');
    if (dl && `local:${dl.id}` !== excludeViaRef) {
      out.push({
        label: dl.name, viaRef: `local:${dl.id}`,
        run: () => this.localTurn(dl, task, messages, tools, signal)
      });
    }
    return out;
  }

  private firstDownloaded(task: 'chat' | 'vision'): ModelEntry | null {
    const dl = this.deps.store.d.models.downloaded;
    for (const e of MODEL_CATALOG) {
      if (e.task === task && dl[e.id]) return e;
    }
    return null;
  }

  // -- turn implementations ---------------------------------------------------

  private async appleFmTurn(messages: LlmMessage[], tools: LlmToolDef[], signal?: AbortSignal): Promise<LlmResult> {
    if (tools.length > 0) {
      throw new Error('Apple Foundation Models has no tool calling — trying the next model');
    }
    const probe = await this.deps.appleFm.probe();
    if (!probe.available) {
      throw new Error(`Apple Foundation Models unavailable: ${probe.reason ?? 'unknown reason'}`);
    }
    if (signal?.aborted) throw new Error('Aborted');
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest: AppleFmMessage[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        rest.push({ role: 'user', content: `[tool result] ${m.content}` });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        rest.push({ role: 'assistant', content: m.content });
        continue;
      }
      rest.push({ role: m.role, content: m.content });
    }
    const text = await this.deps.appleFm.chat(rest, { system });
    return { text, toolCalls: [] };
  }

  private async localTurn(
    entry: ModelEntry,
    task: 'chat' | 'vision',
    messages: LlmMessage[],
    tools: LlmToolDef[],
    signal?: AbortSignal
  ): Promise<LlmResult> {
    const slot: ServerSlot = task === 'vision' ? 'vision' : 'chat';
    const st = this.deps.llama.status(slot);
    let base = this.deps.llama.url(slot);
    if (!base || st.modelId !== entry.id) {
      base = await this.deps.llama.start(entry, slot);
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

  private async cloudTurn(
    p: ProviderPersist,
    messages: LlmMessage[],
    tools: LlmToolDef[],
    signal?: AbortSignal
  ): Promise<LlmResult> {
    const key = providerNeedsKey(p) ? (this.deps.store.getProviderKey(p.id) ?? '') : '';
    if (providerNeedsKey(p) && !key) {
      throw new Error(`No API key saved for ${p.name} — add one in Settings → Providers.`);
    }
    if (!p.baseUrl) throw new Error(`${p.name}: no endpoint URL configured.`);
    if (!p.model) throw new Error(`${p.name}: no model configured.`);
    return chatComplete({
      baseUrl: p.baseUrl,
      api: p.api,
      apiKey: key,
      model: p.model,
      messages,
      tools,
      signal
    });
  }
}
