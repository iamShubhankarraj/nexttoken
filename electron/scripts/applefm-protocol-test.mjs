/**
 * applefm-protocol-test.mjs — regression tests for the Apple FM tool-calling
 * protocol between src/main/models/applefm.ts and native/applefm.
 *
 * The real bridge needs a Mac (FoundationModels, macOS 26+), so the test
 * uses a fake bridge executable (a node script made executable) that speaks
 * the documented JSON-lines protocol:
 *
 *   probe:   argv --probe  -> {"available":true,"toolCalling":true}
 *   tool turn: reads the chat request line, asserts the tools array arrived,
 *              emits {"id","tool_call":{...}}, reads the tool_result line,
 *              asserts the callId matches, then emits {"id","text":"..."}.
 *
 * Cases:
 *   1. probe reports toolCalling:true and the client exposes it.
 *   2. a full tool turn runs onToolCall exactly once and returns the final text.
 *   3. tool executor throwing still resolves: the client feeds "Error: ..."
 *      back as the tool result (the turn must not die).
 *   4. bridge returning mismatched id fails the turn loudly.
 *   5. old bridge (probe WITHOUT toolCalling) -> client reports false,
 *      never claims support.
 *
 * Run: node scripts/applefm-protocol-test.mjs   (bundles applefm.ts with esbuild)
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

// The client gates on os.platform() === 'darwin'. Same module object, so
// patching here affects the esbuild bundle too.
const realPlatform = os.platform;
os.platform = () => 'darwin';
process.on('exit', () => { os.platform = realPlatform; });

function esbuild(entry, outfile) {
  execFileSync('npx', ['esbuild', entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`, '--log-level=error'], {
    cwd: electronDir,
    stdio: 'inherit',
  });
}

function writeFakeBridge(dir, mode) {
  const p = path.join(dir, 'applefm-bridge');
  let body = '';
  if (mode === 'tools') {
    body = `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv.includes('--probe')) {
  console.log(JSON.stringify({ available: true, toolCalling: true }));
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
let done = false;
rl.on('line', (line) => {
  if (done || !line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.op !== 'chat') return; // tool_result lines are handled by rl.once
  if (!Array.isArray(req.tools) || req.tools.length === 0) {
    console.log(JSON.stringify({ id: req.id, error: 'expected tools' }));
    done = true; process.exit(0);
  }
  const callId = 1;
  const args = JSON.stringify({ path: '/tmp' });
  console.log(JSON.stringify({ id: req.id, tool_call: { callId, name: req.tools[0].name, arguments: args } }));
  rl.once('line', (resLine) => {
    const res = JSON.parse(resLine);
    const tr = res.tool_result;
    if (!tr || tr.callId !== callId) {
      console.log(JSON.stringify({ id: req.id, error: 'callId mismatch' }));
      done = true; process.exit(0);
    }
    console.log(JSON.stringify({ id: req.id, text: 'list done: ' + tr.result }));
    done = true; process.exit(0);
  });
});
`;
  } else if (mode === 'mismatch') {
    body = `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv.includes('--probe')) {
  console.log(JSON.stringify({ available: true, toolCalling: true }));
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  console.log(JSON.stringify({ id: 'WRONG-ID', text: 'nope' }));
  process.exit(0);
});
`;
  } else {
    // old bridge: probe predates the toolCalling field
    body = `#!/usr/bin/env node
if (process.argv.includes('--probe')) {
  console.log(JSON.stringify({ available: true }));
  process.exit(0);
}
`;
  }
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'applefm-proto-'));
  const bundleOut = path.join(tmp, 'applefm.cjs');
  esbuild('src/main/models/applefm.ts', bundleOut);
  const require = createRequire(import.meta.url);
  const { AppleFmClient } = require(bundleOut);
  const clientFor = (bridgePath) => new AppleFmClient({ binaryCandidates: [bridgePath] });
  const tools = [{ name: 'list_files', description: 'list files', parameters: { type: 'object' } }];

  // --- case 1+2: probe handshake + full tool turn -------------------------
  const bridgeTools = writeFakeBridge(tmp, 'tools');
  {
    const client = clientFor(bridgeTools);
    const probe = await client.probe();
    assert.equal(probe.available, true, 'probe available');
    assert.equal(probe.toolCalling, true, 'probe toolCalling');
    assert.equal(client.toolCallingSupported, true, 'client exposes toolCalling');

    const calls = [];
    const text = await client.chatWithTools(
      [{ role: 'user', content: 'list /tmp' }],
      tools,
      {
        timeoutMs: 15000,
        onToolCall: async (name, argsJson) => {
          calls.push({ name, argsJson });
          return 'RESULT-OK';
        },
      }
    );
    assert.equal(calls.length, 1, 'onToolCall ran exactly once');
    assert.equal(calls[0].name, 'list_files');
    assert.deepEqual(JSON.parse(calls[0].argsJson), { path: '/tmp' });
    assert.match(text, /RESULT-OK/, 'final text carries the tool result');
    console.log('ok 1+2: probe handshake + full tool turn');
  }

  // --- case 3: executor throwing -> "Error: ..." fed back -----------------
  {
    const client = clientFor(bridgeTools);
    const text = await client.chatWithTools(
      [{ role: 'user', content: 'go' }],
      tools,
      {
        timeoutMs: 15000,
        onToolCall: async () => { throw new Error('denied by user'); },
      }
    );
    assert.match(text, /Error: denied by user/, 'executor failure fed back as Error text');
    console.log('ok 3: executor throw -> Error result text');
  }

  // --- case 4: mismatched response id fails loudly -----------------------
  {
    const client = clientFor(writeFakeBridge(tmp, 'mismatch'));
    await assert.rejects(
      () => client.chatWithTools(
        [{ role: 'user', content: 'go' }],
        tools,
        { timeoutMs: 15000, onToolCall: async () => 'x' }
      ),
      /mismatched response id/,
      'mismatched id throws'
    );
    console.log('ok 4: mismatched response id throws');
  }

  // --- case 5: old bridge without toolCalling field ----------------------
  {
    const client = clientFor(writeFakeBridge(tmp, 'old'));
    const probe = await client.probe();
    assert.equal(probe.available, true, 'old probe still available');
    assert.equal(probe.toolCalling, false, 'missing field -> false, never assumed');
    assert.equal(client.toolCallingSupported, false);
    console.log('ok 5: old bridge reports no tool calling');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\napplefm protocol tests: 5/5 passed');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
