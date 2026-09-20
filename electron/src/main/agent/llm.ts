/**
 * Minimal BYOK chat-completion clients.
 * Speaks OpenAI-compatible `/chat/completions` and Anthropic `/v1/messages`
 * with a normalized tool-call interface. No SDKs — plain fetch.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface LlmOpts {
  baseUrl: string;
  api: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  signal?: AbortSignal;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(120_000)
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } | string } | null)?.error;
    const detail = typeof msg === 'string' ? msg : msg?.message ?? text.slice(0, 300);
    throw new Error(`Provider error ${res.status}: ${detail}`);
  }
  return json as Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
}

async function openAiComplete(o: LlmOpts): Promise<LlmResult> {
  const url = o.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers: Record<string, string> = {};
  if (o.apiKey) headers['Authorization'] = `Bearer ${o.apiKey}`;
  const messages = o.messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id, type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args) }
        }))
      };
    }
    return { role: m.role, content: m.content };
  });
  const body = {
    model: o.model,
    messages,
    tools: o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: 'auto'
  };
  const json = await postJson(url, headers, body, o.signal);
  const choice = asRecord((json.choices as unknown[])?.[0]);
  const msg = asRecord(choice.message);
  const toolCalls: LlmToolCall[] = ((msg.tool_calls as unknown[]) ?? []).map((tc) => {
    const r = asRecord(tc); const fn = asRecord(r.function);
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(String(fn.arguments ?? '{}')); } catch { /* keep {} */ }
    return { id: String(r.id ?? ''), name: String(fn.name ?? ''), args };
  });
  return { text: String(msg.content ?? ''), toolCalls };
}

async function anthropicComplete(o: LlmOpts): Promise<LlmResult> {
  const url = o.baseUrl.replace(/\/+$/, '') + '/v1/messages';
  const system = o.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const messages: unknown[] = [];
  for (const m of o.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args });
      messages.push({ role: 'assistant', content });
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }
  const body = {
    model: o.model,
    max_tokens: 2048,
    ...(system ? { system } : {}),
    messages,
    tools: o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  };
  const json = await postJson(
    url,
    { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
    body,
    o.signal
  );
  const blocks = (json.content as unknown[]) ?? [];
  let text = '';
  const toolCalls: LlmToolCall[] = [];
  for (const b of blocks) {
    const r = asRecord(b);
    if (r.type === 'text') text += String(r.text ?? '');
    if (r.type === 'tool_use') {
      toolCalls.push({ id: String(r.id ?? ''), name: String(r.name ?? ''), args: asRecord(r.input) });
    }
  }
  return { text, toolCalls };
}

export async function chatComplete(o: LlmOpts): Promise<LlmResult> {
  if (!o.baseUrl) throw new Error('No provider endpoint configured — add one in Settings.');
  if (!o.model) throw new Error('No model configured — set a model in Settings.');
  return o.api === 'anthropic' ? anthropicComplete(o) : openAiComplete(o);
}

/** Lightweight connection check used by Settings → "Test connection". */
export async function testConnection(o: {
  baseUrl: string; api: 'openai' | 'anthropic'; apiKey: string; model: string;
}): Promise<{ ok: boolean; error?: string; model?: string }> {
  try {
    if (o.api === 'anthropic') {
      const url = o.baseUrl.replace(/\/+$/, '') + '/v1/models';
      const res = await fetch(url, {
        headers: { 'x-api-key': o.apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(20_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, model: o.model };
    }
    const url = o.baseUrl.replace(/\/+$/, '') + '/models';
    const headers: Record<string, string> = {};
    if (o.apiKey) headers['Authorization'] = `Bearer ${o.apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, model: o.model };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
