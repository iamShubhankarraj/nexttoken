import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../../shared/ipc';
import type { TabManager } from '../tabs';
import type { Store } from '../store';
import { type LlmMessage } from './llm';
import { routeChat, type RouterDeps } from './router';
import { COMPUTER_USE_SYSTEM_PROMPT, VOICE_SYSTEM_PROMPT } from './prompts';
import { snapshotPage, formatSnapshot } from './perceive';
import { TOOL_DEFS, executeTool, summarizeToolCall, type ToolCtx, type ToolOutcome } from './tools';
import { isVisionRequiredError } from '../models/task-models';

export interface AgentRuntime {
  win: BrowserWindow;
  tabs: TabManager;
  store: Store;
  emit: (e: AgentEvent) => void;
  router: RouterDeps;
  /**
   * Voice pipeline state for voice-driven runs (drives the toolbar chip):
   * 'thinking' while the model reasons, 'acting' while browser tools run,
   * null when the run settles. Absent for non-voice runs.
   */
  onVoiceState?: (s: 'thinking' | 'acting' | null) => void;
  /** A vision task found the vision slot empty — nudge the model manager. */
  onVisionMissing?: () => void;
}

const activeRuns = new Map<string, AbortController>();
const MAX_STEPS = 12;

/**
 * THE single place tool calls get executed. Used by the outer agent loop for
 * loop-driven models AND as the bridge callback for models with an internal
 * tool loop (Apple Foundation Models): the bridge emits tool_call lines and
 * this runs the real approval-gated executor, so confirmations, sensitive-
 * action rules, and vision-missing handling are identical on both paths.
 * The result is capped at 2000 chars (oversized dumps are the biggest
 * prompt-eval cost on local models).
 */
async function serveToolCall(
  ctx: ToolCtx,
  emit: AgentRuntime['emit'],
  rt: AgentRuntime,
  runId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  emit({ kind: 'tool', runId, name, summary: summarizeToolCall(name, args) });
  let outcome: ToolOutcome;
  try {
    outcome = await executeTool(ctx, name, args);
  } catch (e) {
    // Vision tasks without a downloaded vision model raise a typed
    // error: nudge the model manager and feed the requirement back to
    // the model so its final answer tells the user what to do.
    if (isVisionRequiredError(e)) {
      rt.onVisionMissing?.();
      outcome = {
        ok: false,
        result:
          'VISION_MODEL_REQUIRED: the user has not downloaded a vision model yet. ' +
          'I have opened the vision download page in Settings for them. ' +
          'In your final reply, briefly tell the user that a vision model is required ' +
          'to see the screen, and ask them to download one in Settings → Models → Vision. ' +
          'Do NOT describe or guess at anything on the screen.'
      };
    } else {
      throw e;
    }
  }
  if (outcome.denied) {
    emit({ kind: 'denied', runId, name, reason: 'User declined the terminal confirmation.' });
  }
  return outcome.result.slice(0, 2000);
}

export function cancelAgentRun(runId: string) {
  activeRuns.get(runId)?.abort();
}

export async function startAgentRun(
  userText: string,
  rt: AgentRuntime,
  opts?: { voice?: boolean }
): Promise<string> {
  const runId = randomUUID();
  const ac = new AbortController();
  activeRuns.set(runId, ac);
  rt.emit({ kind: 'started', runId });
  void runLoop(runId, userText, rt, ac.signal, opts?.voice ?? false).finally(() => activeRuns.delete(runId));
  return runId;
}

async function runLoop(runId: string, userText: string, rt: AgentRuntime, signal: AbortSignal, voice: boolean) {
  const { tabs, store, win, emit, router } = rt;
  const err = (error: string) => emit({ kind: 'error', runId, error });

  // Local tiers need no API key; the router falls through to cloud BYOK and
  // raises a clear error there only if no key is configured.
  const SYSTEM_PROMPT = voice ? VOICE_SYSTEM_PROMPT : COMPUTER_USE_SYSTEM_PROMPT;

  store.pushHistory({ id: randomUUID(), role: 'user', text: userText, at: Date.now() });

  // Keep local-model context lean: the last 8 history entries are plenty for
  // continuity, and trimming prompt-eval cost is the cheapest latency win on
  // Apple Silicon (every extra token is re-encoded on each turn).
  const history: LlmMessage[] = store.d.agentHistory
    .slice(-8)
    .map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.text } as LlmMessage));
  // The user message was just pushed; history includes it — avoid duplication.
  const base: LlmMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const convo: LlmMessage[] = [...base, ...history.slice(0, -1), { role: 'user', content: userText }];

  const ctx: ToolCtx = { win, tabs, store, router };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) { emit({ kind: 'done', runId }); return; }

      const snap = await snapshotPage(tabs.activeWebContents());
      const perception = snap
        ? `Current tab perception:\n${formatSnapshot(snap)}`
        : 'Current tab perception: (no active tab or page not readable — you can open_tab or navigate first)';

      // Unified routing: the Agent tab's active model serves the turn, with
      // a visible fallback chain. Never silently swap — the note names the
      // model that actually answered.
      if (voice) rt.onVoiceState?.('thinking');
      const routed = await routeChat(router, {
        task: 'chat',
        messages: [...convo, { role: 'user', content: perception }],
        tools: TOOL_DEFS,
        signal,
        // Local models stream tokens; the panel already accumulates
        // done:false deltas, so the reply paints as it's generated.
        onToken: (t) => emit({ kind: 'message', runId, text: t, done: false }),
        // Models with an internal tool loop (Apple Foundation Models via
        // the bridge) run tool calls here — the same approval-gated path
        // as the outer loop below, so their results are final and never
        // re-executed.
        toolExecutor: async (name, argsJson) => {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(argsJson) as Record<string, unknown>;
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              throw new Error('not a JSON object');
            }
          } catch (e) {
            throw new Error(`invalid tool arguments JSON for ${name}: ${e instanceof Error ? e.message : String(e)}`);
          }
          return serveToolCall(ctx, emit, rt, runId, name, args);
        },
      });
      const { text, toolCalls } = routed.result;

      if (toolCalls.length === 0) {
        const final = text.trim() || '(no response)';
        const withNote = routed.fallbackNote ? `${final}\n\n_(${routed.fallbackNote})_` : final;
        emit({ kind: 'message', runId, text: withNote, done: true });
        store.pushHistory({ id: randomUUID(), role: 'assistant', text: withNote, at: Date.now() });
        convo.push({ role: 'assistant', content: final });
        if (voice) rt.onVoiceState?.(null);
        emit({ kind: 'done', runId });
        return;
      }

      // Act on each tool call, then loop to verify.
      if (voice) rt.onVoiceState?.('acting');
      const assistantMsg: LlmMessage = { role: 'assistant', content: text, toolCalls };
      convo.push(assistantMsg);
      for (const tc of toolCalls) {
        if (signal.aborted) break;
        // Same serveToolCall the Apple FM bridge uses for its internal
        // tool loop — one execution path everywhere.
        const content = await serveToolCall(ctx, emit, rt, runId, tc.name, tc.args);
        convo.push({
          role: 'tool',
          toolCallId: tc.id,
          content
        });
      }
    }
    const msg = 'I used all 12 steps without finishing. Here is where things stand — tell me how to proceed.';
    emit({ kind: 'message', runId, text: msg, done: true });
    if (voice) rt.onVoiceState?.(null);
    emit({ kind: 'done', runId });
  } catch (e) {
    if (voice) rt.onVoiceState?.(null);
    if (signal.aborted) { emit({ kind: 'done', runId }); return; }
    err(e instanceof Error ? e.message : String(e));
    emit({ kind: 'done', runId });
  }
}
