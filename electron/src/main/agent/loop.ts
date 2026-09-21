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

  const history: LlmMessage[] = store.d.agentHistory
    .slice(-20)
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
        signal
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
        emit({ kind: 'tool', runId, name: tc.name, summary: summarizeToolCall(tc.name, tc.args) });
        let outcome: ToolOutcome;
        try {
          outcome = await executeTool(ctx, tc.name, tc.args);
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
          emit({ kind: 'denied', runId, name: tc.name, reason: 'User declined the terminal confirmation.' });
        }
        convo.push({
          role: 'tool',
          toolCallId: tc.id,
          content: outcome.result.slice(0, 6000)
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
