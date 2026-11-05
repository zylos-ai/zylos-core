import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CodexAdapter } from '../codex.js';
import { ClaudeAdapter } from '../claude.js';

// Integration boundary: real adapters and execFile with a private fake CLI.
// Run for CLI auth-result parsing changes; skip unrelated session lifecycle.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR. Each
// case uses only its own executable and empty auth/config root, with no real
// runtime, network, database, tmux, or PM2 access. execFile awaits/reaps the child;
// its timeout also bounds a stuck fixture, before teardown removes private files.
async function fixture(t, runtime, scenario, { missing = false, timeout, killAfterOutput = false, trace } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-probe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = path.join(root, 'runtime.mjs');
  if (!missing) {
    const source = await fs.readFile(new URL('./helpers/auth-probe-cli.js', import.meta.url), 'utf8');
    await fs.writeFile(command, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  }
  const env = {
    HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: root, TMUX_TMPDIR: root, CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    [runtime === 'codex' ? 'CODEX_BIN' : 'CLAUDE_BIN']: command,
    TEST_AUTH_PROBE_SCENARIO: JSON.stringify({
      args: runtime === 'codex' ? 'login status' : '-p ping --max-turns 1',
      exitCode: 1, ...scenario,
    }),
  };
  const options = { root, env };
  if (timeout || killAfterOutput || trace) {
    options.execFile = (file, args, values) => new Promise((resolve, reject) => {
      const child = execFile(file, args, { ...values, timeout: timeout ?? 1000 }, (error, stdout, stderr) => {
        if (trace) Object.assign(trace, { stdout, stderr, code: error?.code, killed: error?.killed, signal: error?.signal });
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
      if (killAfterOutput) {
        let output = '';
        child.stderr.on('data', chunk => {
          output += chunk;
          if (output.includes('Not logged in')) child.kill('SIGTERM');
        });
      }
    });
  }
  return runtime === 'codex' ? new CodexAdapter(options) : new ClaudeAdapter(options);
}

for (const [stream, output] of [['stderr', 'Not logged in'], ['stdout', 'Not logged in']]) {
  test(`Codex exit one with logged-out text on ${stream} confirms failure`, async t => {
    const adapter = await fixture(t, 'codex', { [stream]: output });
    assert.deepEqual(await adapter.checkAuth(), { status: 'failure', reason: 'not_logged_in' });
  });
}

test('Codex failed-command auth classification combines stdout and stderr', async t => {
  const adapter = await fixture(t, 'codex', { stdout: 'Not ', stderr: 'logged in' });
  assert.deepEqual(await adapter.checkAuth(), { status: 'failure', reason: 'not_logged_in' });
});

for (const [name, scenario, options] of [
  ['logged-in text with exit one', { stderr: 'Logged in using ChatGPT' }],
  ['empty output with exit one', {}],
  ['missing command', {}, { missing: true }],
  ['killed command', { signal: 'SIGTERM' }],
  ['timed-out command', { wait: true }, { timeout: 100 }],
]) {
  test(`Codex ${name} remains uncertain`, async t => {
    const adapter = await fixture(t, 'codex', scenario, options);
    assert.deepEqual(await adapter.checkAuth(), { status: 'uncertain', reason: 'codex_login_status_unavailable' });
  });
}

test('Claude exit one with logged-out stdout confirms failure', async t => {
  const adapter = await fixture(t, 'claude', { stdout: 'Not logged in · Please run /login' });
  assert.deepEqual(await adapter.checkAuth(), { status: 'failure', reason: 'cli_probe_not_logged_in' });
});

test('Claude exit one with logged-out stderr confirms failure', async t => {
  const adapter = await fixture(t, 'claude', { stderr: 'Not logged in · Please run /login' });
  assert.deepEqual(await adapter.checkAuth(), { status: 'failure', reason: 'cli_probe_not_logged_in' });
});

for (const transient of ['rate_limit_error', 'api_error']) {
  test(`Claude ${transient} remains transient beside another tool's logged-out text`, async t => {
    const adapter = await fixture(t, 'claude', { stderr: `[mcp] github: Not logged in\n${transient}` });
    assert.deepEqual(await adapter.checkAuth(), { status: 'uncertain', reason: 'cli_probe_uncertain' });
  });
}

for (const runtime of ['codex', 'claude']) {
  for (const termination of ['self signal', 'external signal', 'timeout']) {
    test(`${runtime} logged-out text followed by ${termination} remains uncertain`, async t => {
      const trace = {};
      const scenario = { stderr: 'Not logged in', ...(termination === 'self signal' ? { signal: 'SIGTERM' } : { wait: true }) };
      const adapter = await fixture(t, runtime, scenario, { trace,
        killAfterOutput: termination === 'external signal', timeout: 1000 });
      const reason = runtime === 'codex' ? 'codex_login_status_unavailable'
        : termination === 'self signal' ? 'cli_probe_unexpected_error' : 'cli_probe_uncertain';
      assert.deepEqual(await adapter.checkAuth(), { status: 'uncertain', reason });
      assert.equal(trace.stderr, 'Not logged in', 'the child printed the auth text before termination');
      assert.equal(trace.signal, 'SIGTERM');
      assert.equal(trace.killed, termination !== 'self signal');
      assert.notEqual(typeof trace.code, 'number');
    });
  }
}

for (const [name, scenario, result] of [
  ['rate limit', { stderr: 'rate_limit_error' }, { status: 'uncertain', reason: 'cli_probe_uncertain' }],
  ['unknown error', { stderr: 'unknown failure' }, { status: 'uncertain', reason: 'cli_probe_unexpected_error' }],
  ['authentication error', { stderr: 'authentication_error' }, { status: 'failure', reason: 'cli_probe_authentication_error' }],
]) {
  test(`Claude ${name} preserves its existing result`, async t => {
    const adapter = await fixture(t, 'claude', scenario);
    assert.deepEqual(await adapter.checkAuth(), result);
  });
}
