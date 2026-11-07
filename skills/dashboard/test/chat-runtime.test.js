import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

// Claude: real Supervisor admission, Core receive/router/delivery and native
// Claude session, then Dashboard questions/answers and same-group continuation.
// Codex: the same path with a real Codex session, interleaved with a Claude
// canary group. Both require route/protocol/hook/answer/projection changes.
// TTL: native Claude session reclaimed by Supervisor TTL before answering;
// a fresh session receives the self-contained answer and historical reply route.
// Startup/lifecycle changes require it. CSS-only changes may skip all three.
// Every case skips BEFORE DB, HTTP or runtime allocation unless BOTH switches
// are enabled and a dedicated account fixture has been explicitly supplied.
// No live auth/home/history discovery occurs. ZYLOS_CHAT_RUNTIME_AUTH_DIR is an
// absolute dedicated directory containing claude/.credentials.json and
// codex/auth.json. Only those files are copied; history/settings stay behind.
// Set ZYLOS_CHAT_TMUX_BINARY to an absolute tmux executable. Optional absolute
// ZYLOS_CHAT_CLAUDE_BINARY / ZYLOS_CHAT_CODEX_BINARY select the native CLIs.
// Example (dedicated test Unix user only):
// ZYLOS_CHAT_INTEGRATION=1 ZYLOS_CHAT_RUNTIME=1 \
// ZYLOS_CHAT_RUNTIME_AUTH_DIR=/private/test-auth \
// ZYLOS_CHAT_TMUX_BINARY=/usr/bin/tmux node scripts/run-node-tests.js \
// skills/dashboard/test/chat-runtime.test.js
const enabled = chatEnabled(process.env, { runtime: true });
const authDirectory = process.env.ZYLOS_CHAT_RUNTIME_AUTH_DIR;
const driver = fileURLToPath(new URL('./helpers/chat-runtime-driver.js', import.meta.url));

for (const [name, scenario, accounts] of [
  ['Claude conversation completes the real structured answer chain', 'claude', ['claude']],
  ['Codex conversation completes the real chain without crossing the Claude group', 'codex', ['claude', 'codex']],
  ['TTL recovery keeps answer summary and historical reply in the original group', 'ttl', ['claude', 'codex']],
]) test(name, { skip: !enabled, timeout: 660_000 }, async t => {
  if (!authDirectory) { t.skip('Dedicated runtime authentication directory is not supplied'); return; }
  assert.ok(path.isAbsolute(authDirectory), 'Dedicated authentication directory must be absolute');
  const fixture = { tmuxBinary: process.env.ZYLOS_CHAT_TMUX_BINARY };
  assert.ok(fixture.tmuxBinary && path.isAbsolute(fixture.tmuxBinary), 'Set an absolute ZYLOS_CHAT_TMUX_BINARY');
  for (const runtime of accounts) {
    const directory = path.join(authDirectory, runtime);
    const filename = path.join(directory, runtime === 'claude' ? '.credentials.json' : 'auth.json');
    if (!fs.existsSync(filename)) { t.skip(`Dedicated ${runtime} authentication file is not supplied`); return; }
    assert.ok(fs.statSync(filename).isFile(), 'Dedicated authentication must be a regular file');
    const binary = process.env[`ZYLOS_CHAT_${runtime.toUpperCase()}_BINARY`];
    if (binary) assert.ok(path.isAbsolute(binary), 'Native CLI override must be absolute');
    fixture[runtime] = { authDirectory: directory, ...(binary ? { binary } : {}) };
  }
  const sandbox = createChatSandbox(t, { runtime: true });
  const tmux = fixture.tmuxBinary;
  // A model CLI can outlive its launcher if it is held by a tmux daemon. The
  // parent owns this exact private socket even when the driver is timed out.
  sandbox.addCleanup(() => {
    const result = spawnSync(tmux, ['-S', sandbox.paths.socket, 'kill-server'], { env: sandbox.env,
      cwd: sandbox.paths.zylos, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.ok(result.status === 0 || /no server running|No such file|error connecting/.test(result.stderr || ''), 'Private tmux cleanup confirmed');
  });
  await sandbox.runCase(async () => {
    const child = sandbox.startChild(process.execPath, [driver, scenario, JSON.stringify(fixture), sandbox.root], {
      timeoutMs: 620_000, maxOutputBytes: 524288,
    });
    child.stdin.end();
    const result = await child.completion;
    assert.equal(result.code, 0, result.stderr.slice(-12000));
    assert.equal(result.outputExceeded, false);
    const line = result.stdout.split('\n').find(line => line.startsWith('CHAT_RUNTIME_RESULT '));
    assert.ok(line, 'Driver returned an actual completed-chain receipt');
    const receipt = JSON.parse(line.slice('CHAT_RUNTIME_RESULT '.length));
    assert.equal(receipt.scenario, scenario);
    assert.ok(receipt.answers >= 4, 'All supported question action types traversed the real model chain');
    assert.ok(receipt.assertions > 0);
    assert.equal(receipt.crossGroupWrites, 0);
    assert.equal(receipt.runtime, scenario === 'codex' ? 'codex' : 'claude');
    if (scenario === 'ttl') assert.equal(receipt.reclaimed, true);
    t.diagnostic(JSON.stringify(receipt));
  }, { timeoutMs: 630_000 });
});
