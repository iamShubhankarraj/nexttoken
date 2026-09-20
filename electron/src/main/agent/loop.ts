import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../../shared/ipc';
import type { TabManager } from '../tabs';
import type { Store } from '../store';
import { type LlmMessage } from './llm';
import { routeChat, type RouterDeps } from './router';
import { COMPUTER_USE_SYSTEM_PROMPT, VOICE_SYSTEM_PROMPT } from './prompts';
import { snapshotPage, formatSnapshot } from './perceive';
import { TOOL_DEFS, executeTool, summarizeToolCall, type ToolCtx } from './tools';

export interface AgentRuntime {
  win: BrowserWindow;
  tabs: TabManager;
  store: Store;
  emit: (e: AgentEvent) => void;
  router: RouterDeps;
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

  const ctx: ToolCtx = { win, tabs, store };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) { emit({ kind: 'done', runId }); return; }

      const snap = await snapshotPage(tabs.activeWebContents());
      const perception = snap
        ? `Current tab perception:\n${formatSnapshot(snap)}`
        : 'Current tab perception: (no active tab or page not readable — you can open_tab or navigate first)';

      // Tiered routing: Apple FM → local llama-server → cloud BYOK.
      const { text, toolCalls } = (await routeChat(router, {
        task: 'chat',
        messages: [...convo, { role: 'user', content: perception }],
        tools: TOOL_DEFS,
        signal
      })).result;

      if (toolCalls.length === 0) {
        const final = text.trim() || '(no response)';
        emit({ kind: 'message', runId, text: final, done: true });
        store.pushHistory({ id: randomUUID(), role: 'assistant', text: final, at: Date.now() });
        convo.push({ role: 'assistant', content: final });
        emit({ kind: 'done', runId });
        return;
      }

      // Act on each tool call, then loop to verify.
      const assistantMsg: LlmMessage = { role: 'assistant', content: text, toolCalls };
      convo.push(assistantMsg);
      for (const tc of toolCalls) {
        if (signal.aborted) break;
        emit({ kind: 'tool', runId, name: tc.name, summary: summarizeToolCall(tc.name, tc.args) });
        const outcome = await executeTool(ctx, tc.name, tc.args);
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
    emit({ kind: 'done', runId });
  } catch (e) {
    if (signal.aborted) { emit({ kind: 'done', runId }); return; }
    err(e instanceof Error ? e.message : String(e));
    emit({ kind: 'done', runId });
  }
}
