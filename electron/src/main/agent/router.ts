/**
 * Agent tier router — compatibility layer.
 *
 * All routing now lives in the unified ModelRouter
 * (src/main/models/router.ts), which serves every LLM call in the app from
 * the user's ACTIVE model (the Agent tab switcher). This module keeps the
 * existing call sites (agent/loop.ts, brain/orchestrator.ts) working with
 * the same signature.
 */

import { ModelRouter, type RouterDeps } from '../models/router';
import type { LlmMessage, LlmResult, LlmToolDef } from './llm';

/** Assignment sentinel refs — must match the ModelsPanel UI constants. */
export const APPLE_FM_REF = 'apple-fm';
export const CLOUD_REF = 'cloud';

export type { RouterDeps };

export type AgentTask = 'chat' | 'vision';

export interface RouteResult {
  result: LlmResult;
  /** Human-readable source of the turn, e.g. "OpenAI · gpt-5". */
  via: string;
  /** Machine ref of the model that actually answered. */
  viaRef: string;
  /** Set when the active model failed and a fallback answered — show it to the user. */
  fallbackNote?: string;
}

/**
 * Run one chat turn through the unified router.
 * Throws only when every candidate failed, with all errors joined.
 */
export async function routeChat(
  deps: RouterDeps,
  opts: { task: AgentTask; messages: LlmMessage[]; tools: LlmToolDef[]; signal?: AbortSignal; onToken?: (delta: string) => void; toolExecutor?: (name: string, argsJson: string) => Promise<string> }
): Promise<RouteResult> {
  const router = new ModelRouter(deps);
  const r = await router.complete({
    task: opts.task,
    messages: opts.messages,
    tools: opts.tools,
    signal: opts.signal,
    onToken: opts.onToken,
    toolExecutor: opts.toolExecutor,
  });
  return {
    result: { text: r.text, toolCalls: r.toolCalls },
    via: r.via,
    viaRef: r.viaRef,
    fallbackNote: r.fallbackNote
  };
}
