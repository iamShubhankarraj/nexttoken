/**
 * fake-tool-call-test.mjs — regression tests for roleplayed tool calls.
 *
 * A model turn whose text contains a fake ```tool_code block (or bare
 * `name(...)` syntax for a known tool) must NOT be treated as executed:
 * the agent loop routes parseable calls through the real approval-gated
 * executor, or surfaces an honest message when the intent is ambiguous.
 *
 * Also asserts the system prompts carry the no-fake-syntax rule.
 *
 * Run: node scripts/fake-tool-call-test.mjs   (bundles with esbuild)
 */
import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(here, '..');

function esbuild(entry, outfile) {
  execFileSync('npx', ['esbuild', entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`, '--log-level=error'], {
    cwd: electronDir,
    stdio: 'inherit',
  });
}

const KNOWN = ['open_tab', 'navigate', 'run_terminal', 'get_page_snapshot', 'click'];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tool-'));
  const bundleOut = path.join(tmp, 'faketool.cjs');
  esbuild('src/main/agent/fakeToolCall.ts', bundleOut);
  const promptOut = path.join(tmp, 'prompts.cjs');
  esbuild('src/main/agent/prompts.ts', promptOut);
  const require = createRequire(import.meta.url);
  const { detectFakeToolCalls, stripFakeToolCalls, hasUnparsedToolCodeFence } = require(bundleOut);
  const prompts = require(promptOut);

  // --- 1: the exact user-reported shape: fenced tool_code, Python kwargs --
  {
    const text = "Okay, I will open Flipkart.\n\n```tool_code\nrun_terminal(command='flipkart', working_directory='/home/user', confirmation_required=True)\n```";
    const fakes = detectFakeToolCalls(text, KNOWN);
    assert.equal(fakes.length, 1, 'one fake call detected');
    assert.equal(fakes[0].name, 'run_terminal');
    assert.deepEqual(fakes[0].args, { command: 'flipkart', cwd: '/home/user', confirmation_required: true });
    const stripped = stripFakeToolCalls(text);
    assert.ok(!stripped.includes('tool_code'), 'fence stripped from narration');
    assert.ok(stripped.includes('Okay, I will open Flipkart.'), 'narration kept');
    assert.equal(hasUnparsedToolCodeFence(text, KNOWN), false, 'parsed fence is not ambiguous');
    console.log('ok 1: fenced tool_code with Python kwargs detected + stripped');
  }

  // --- 2: bare call syntax in prose ---------------------------------------
  {
    const text = "I'll open it now: open_tab(url='https://flipkart.com')";
    const fakes = detectFakeToolCalls(text, KNOWN);
    assert.equal(fakes.length, 1);
    assert.equal(fakes[0].name, 'open_tab');
    assert.deepEqual(fakes[0].args, { url: 'https://flipkart.com' });
    console.log('ok 2: bare name(...) call in prose detected');
  }

  // --- 3: normal prose is untouched ---------------------------------------
  {
    const text = 'Flipkart is an Indian e-commerce site. I opened the page mentally.';
    assert.deepEqual(detectFakeToolCalls(text, KNOWN), []);
    assert.equal(hasUnparsedToolCodeFence(text, KNOWN), false);
    console.log('ok 3: ordinary prose yields no detections');
  }

  // --- 4: unknown tool names never match; ambiguous fence is honest -------
  {
    const text = '```tool_code\nlaunch_rockets(target="mars")\n```';
    assert.deepEqual(detectFakeToolCalls(text, KNOWN), [], 'unknown tool not detected');
    assert.equal(hasUnparsedToolCodeFence(text, KNOWN), true, 'unparseable fence flagged ambiguous');
    console.log('ok 4: unknown tool ignored, ambiguous fence flagged');
  }

  // --- 5: plain ``` fences (real code samples) are never hijacked ---------
  {
    const text = 'Run this:\n```\nopen_tab(url="x")\n```\nThat is just an example.';
    assert.deepEqual(detectFakeToolCalls(text, KNOWN), [], 'plain fence not treated as tool_code');
    console.log('ok 5: plain code fences untouched');
  }

  // --- 6: positional args do not parse (never executed blind) -------------
  {
    const text = "```tool_code\nrun_terminal('ls -la')\n```";
    assert.deepEqual(detectFakeToolCalls(text, KNOWN), [], 'positional-arg call not executed');
    assert.equal(hasUnparsedToolCodeFence(text, KNOWN), true, 'flagged ambiguous instead');
    console.log('ok 6: positional-arg roleplay not executed');
  }

  // --- 7: commas inside quoted values survive ------------------------------
  {
    const text = '```tool_code\nnavigate(url="https://example.com/?a=1,b=2")\n```';
    const fakes = detectFakeToolCalls(text, KNOWN);
    assert.equal(fakes.length, 1);
    assert.equal(fakes[0].args.url, 'https://example.com/?a=1,b=2');
    console.log('ok 7: quoted commas preserved in args');
  }

  // --- 8: system prompts forbid inventing tool-call syntax -----------------
  {
    for (const [label, prompt] of [
      ['COMPUTER_USE', prompts.COMPUTER_USE_SYSTEM_PROMPT],
      ['PAGE_AGENT', prompts.PAGE_AGENT_SYSTEM_PROMPT],
      ['VOICE', prompts.VOICE_SYSTEM_PROMPT],
    ]) {
      assert.ok(prompt.includes('tool_code'), `${label} prompt names the forbidden fence`);
      assert.ok(
        prompt.includes('tool-call channel') || prompt.includes('TOOL CHANNEL'),
        `${label} prompt states the tool channel rule`
      );
    }
    console.log('ok 8: all agent prompts carry the no-fake-syntax rule');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nfake tool-call tests: 8/8 passed');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
