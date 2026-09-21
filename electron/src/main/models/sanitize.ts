/**
 * sanitize.ts — message-shape repair for local GGUF chat templates.
 *
 * llama-server's OpenAI-compatible endpoint runs each GGUF's Jinja chat
 * template, and some templates (notably Gemma 3n's) hard-raise with
 * HTTP 400 when conversation roles don't strictly alternate
 * user/assistant ("Conversation roles must alternate user..."). The app's
 * agent loop legitimately produces non-alternating shapes — e.g. a tool
 * result (mapped to user) followed by the next perception prompt (also
 * user) — so every local turn is passed through sanitizeChatMessages()
 * before it reaches llama-server:
 *
 *   1. `tool` messages become `user` messages (`[tool result] …`), the
 *      same mapping the Apple FM path already uses.
 *   2. `system` messages are folded into the first user message (many
 *      strict templates have no system slot at all).
 *   3. Consecutive same-role messages merge (text joined with blank
 *      lines; images and toolCalls concatenated).
 *   4. Leading non-user messages are dropped, so the array starts with
 *      user and strictly alternates user/assistant from there.
 *
 * Assistant toolCalls are preserved untouched, so tool-capable local
 * models (Qwen3 et al.) keep their agentic loop. Pure functions — safe
 * to unit test without Electron.
 */
import type { LlmMessage } from '../agent/llm';

function textOf(m: LlmMessage): string {
  return (m.content ?? '').trim();
}

function isEmpty(m: LlmMessage): boolean {
  return !textOf(m) && !(m.images?.length ?? 0) && !(m.toolCalls?.length ?? 0);
}

function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n${b}`;
}

/**
 * Repair a messages array so it strictly alternates user/assistant
 * starting with user. Never mutates the input.
 */
export function sanitizeChatMessages(messages: LlmMessage[]): LlmMessage[] {
  const systems: string[] = [];
  // 1-2: normalize roles, collect system prompts, drop empties.
  const norm: LlmMessage[] = [];
  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      const t = textOf(m);
      if (t) systems.push(t);
      continue;
    }
    if (isEmpty(m)) continue;
    if (m.role === 'tool') {
      norm.push({
        role: 'user',
        content: `[tool result] ${textOf(m)}`.trim(),
        ...(m.images?.length ? { images: [...m.images] } : {}),
      });
      continue;
    }
    norm.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content ?? '',
      ...(m.images?.length ? { images: [...m.images] } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => ({ ...t })) } : {}),
    });
  }

  // 3: merge consecutive same-role messages.
  const merged: LlmMessage[] = [];
  for (const m of norm) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = joinText(prev.content, m.content);
      if (m.images?.length) prev.images = [...(prev.images ?? []), ...m.images];
      if (m.toolCalls?.length) prev.toolCalls = [...(prev.toolCalls ?? []), ...m.toolCalls];
      continue;
    }
    merged.push({ ...m });
  }

  // 4: the array must start with a user message.
  let firstUser = merged.findIndex((m) => m.role === 'user');
  if (firstUser === -1) {
    // Nothing salvageable as conversation — synthesize a user turn from
    // the system prompt so the request is still well-formed.
    const sys = systems.join('\n\n').trim();
    return [{ role: 'user', content: sys || '(no input)' }];
  }
  const out = merged.slice(firstUser);
  if (systems.length > 0) {
    out[0] = { ...out[0], content: joinText(systems.join('\n\n'), out[0].content) };
  }
  return out;
}

/** True when a messages array already strictly alternates user/assistant from user. */
export function messagesAlternate(messages: LlmMessage[]): boolean {
  if (!messages.length || messages[0].role !== 'user') return false;
  for (let i = 1; i < messages.length; i++) {
    const r = messages[i].role;
    if (r !== 'user' && r !== 'assistant') return false;
    if (r === messages[i - 1].role) return false;
  }
  return true;
}

const TEMPLATE_ERROR_RE =
  /chat template|roles must alternate|conversation roles|automatic parser|raise_exception/i;
const RAW_JSON_ERROR_RE = /\{\s*"error"\s*:/s;

/**
 * Never surface llama-server's raw JSON 400 body to the user. Template /
 * alternation failures get a friendly line; the router's fallback chain
 * then tries the next model per priority (Apple FM → GGUF → BYOK) and the
 * fallback note names what answered.
 */
export function friendlyLocalError(modelLabel: string, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  if (TEMPLATE_ERROR_RE.test(raw) || RAW_JSON_ERROR_RE.test(raw)) {
    return new Error(
      `${modelLabel} couldn't take this conversation shape ` +
        `(its chat template needs strictly alternating user/assistant messages) — ` +
        `trying the next model…`
    );
  }
  // Strip any other JSON blob down to a readable line.
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length > 220 || /^\s*\{/.test(oneLine)) {
    return new Error(`${modelLabel} failed: ${oneLine.slice(0, 220)}`);
  }
  return err instanceof Error ? err : new Error(oneLine || `${modelLabel} failed.`);
}
