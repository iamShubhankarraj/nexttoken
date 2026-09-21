/**
 * sanitize-test.mjs — regression tests for the local-model chat sanitizer
 * (src/main/models/sanitize.ts).
 *
 * Reproduces the Gemma 3n E4B failure: llama-server 400s when the Jinja
 * chat template sees non-alternating roles. Asserts the sanitizer's output
 * strictly alternates user/assistant starting with user, for deliberately
 * broken inputs (double user message, leading assistant, system in the
 * middle, tool-call sequences).
 *
 * Run: node scripts/sanitize-test.mjs   (bundles sanitize.ts with esbuild)
 */
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(here, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-sanitize-test-'));
const bundle = path.join(tmpDir, 'sanitize.mjs');

execFileSync(
  path.join(electronDir, 'node_modules', '.bin', 'esbuild'),
  [
    path.join('src', 'main', 'models', 'sanitize.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${bundle}`,
    '--log-level=error',
  ],
  { cwd: electronDir, stdio: 'inherit' }
);

const { sanitizeChatMessages, messagesAlternate, friendlyLocalError } =
  await import(bundle);

function assertAlternating(msgs, label) {
  assert.ok(Array.isArray(msgs) && msgs.length > 0, `${label}: non-empty`);
  assert.equal(msgs[0].role, 'user', `${label}: starts with user`);
  assert.ok(messagesAlternate(msgs), `${label}: messagesAlternate()`);
  for (let i = 1; i < msgs.length; i++) {
    assert.notEqual(msgs[i].role, msgs[i - 1].role, `${label}: no same-role adjacency at ${i}`);
    assert.ok(['user', 'assistant'].includes(msgs[i].role), `${label}: only user/assistant roles`);
  }
}

const texts = (msgs) => msgs.map((m) => m.content).join('\n');

// 1 — the reported Gemma 3n shape: leading assistant, double user,
//     system in the middle, trailing user.
{
  const dirty = [
    { role: 'assistant', content: 'stale opener' },
    { role: 'system', content: 'You are Next Token.' },
    { role: 'user', content: 'open youtube' },
    { role: 'user', content: 'Current tab perception:\n<snapshot/>' },
    { role: 'assistant', content: 'On it.' },
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'now pause the video' },
  ];
  const clean = sanitizeChatMessages(dirty);
  assertAlternating(clean, 'gemma-shape');
  const all = texts(clean);
  for (const t of ['You are Next Token.', 'open youtube', 'Current tab perception:', 'On it.', 'Be concise.', 'now pause the video']) {
    assert.ok(all.includes(t), `gemma-shape: preserves "${t}"`);
  }
  assert.ok(!clean.some((m) => m.role === 'system'), 'gemma-shape: no system role left');
  assert.ok(clean[0].content.startsWith('You are Next Token.'), 'gemma-shape: system folded into first user');
  assert.ok(!clean.some((m) => m.content === 'stale opener'), 'gemma-shape: leading assistant dropped');
  console.log('ok 1 — gemma-shape (leading assistant, double user, mid system)');
}

// 2 — agentic tool-call sequence keeps its toolCalls and alternates.
{
  const dirty = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'open_tab', args: {} }] },
    { role: 'tool', content: 'tab opened', toolCallId: '1' },
    { role: 'user', content: 'Current tab perception:\n<snapshot/>' },
  ];
  const clean = sanitizeChatMessages(dirty);
  assertAlternating(clean, 'tool-sequence');
  const asst = clean.find((m) => m.role === 'assistant');
  assert.ok(asst && asst.toolCalls && asst.toolCalls.length === 1, 'tool-sequence: toolCalls preserved');
  assert.ok(
    clean.some((m) => m.role === 'user' && m.content.includes('[tool result]') && m.content.includes('tab opened')),
    'tool-sequence: tool result kept as user text'
  );
  console.log('ok 2 — tool-call sequence (toolCalls preserved, still alternating)');
}

// 3 — already-clean input passes through unchanged.
{
  const cleanIn = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'bye' },
  ];
  const out = sanitizeChatMessages(cleanIn);
  assert.deepEqual(out, cleanIn, 'clean input unchanged');
  console.log('ok 3 — clean input passes through byte-identical');
}

// 4 — degenerate: only assistant messages → synthesized user turn.
{
  const out = sanitizeChatMessages([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'orphan' },
  ]);
  assertAlternating(out, 'degenerate');
  assert.ok(out[0].content.includes('sys'), 'degenerate: system text kept');
  console.log('ok 4 — assistant-only input synthesizes a user turn');
}

// 5 — friendlyLocalError never leaks raw JSON.
{
  const raw = new Error(
    'Local model error 400: {"error":{"code":400,"message":"Unable to generate parser for this template. Automatic parser generation failed: ... {{ raise_exception(\\"Conversation roles must alternate user...\\") }}"}}'
  );
  const friendly = friendlyLocalError('Gemma 3n E4B', raw);
  assert.ok(!friendly.message.includes('{"error"'), 'no raw JSON in message');
  assert.ok(!friendly.message.includes('raise_exception'), 'no template internals in message');
  assert.ok(friendly.message.includes('Gemma 3n E4B'), 'names the model');
  console.log('ok 5 — friendlyLocalError strips the raw 400 JSON');
  console.log('   →', friendly.message);
}

// 6 — input is never mutated.
{
  const dirty = [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ];
  const snapshot = JSON.parse(JSON.stringify(dirty));
  sanitizeChatMessages(dirty);
  assert.deepEqual(dirty, snapshot, 'input not mutated');
  console.log('ok 6 — input array never mutated');
}

console.log('\nsanitize-test: all 6 passed');
