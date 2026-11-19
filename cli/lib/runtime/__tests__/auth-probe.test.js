import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { getRuntime } from '../index.js';
import { executeRuntimeSwitch, runtimeCommand } from '../../../commands/runtime.js';

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
  const { auth } = await getRuntime(runtime);
  return { options, auth: { checkAuth: () => auth.checkAuth(options) } };
}

for (const [stream, output] of [['stderr', 'Not logged in'], ['stdout', 'Not logged in']]) {
  test(`Codex exit one with logged-out text on ${stream} confirms failure`, async t => {
    const adapter = await fixture(t, 'codex', { [stream]: output });
    assert.deepEqual(await adapter.auth.checkAuth(), { status: 'failure', reason: 'not_logged_in' });
  });
}

test('Codex failed-command auth classification combines stdout and stderr', async t => {
  const adapter = await fixture(t, 'codex', { stdout: 'Not ', stderr: 'logged in' });
  assert.deepEqual(await adapter.auth.checkAuth(), { status: 'failure', reason: 'not_logged_in' });
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
    assert.deepEqual(await adapter.auth.checkAuth(), { status: 'uncertain', reason: 'codex_login_status_unavailable' });
  });
}

test('Claude exit one with logged-out stdout confirms failure', async t => {
  const adapter = await fixture(t, 'claude', { stdout: 'Not logged in · Please run /login' });
  assert.deepEqual(await adapter.auth.checkAuth(), { status: 'failure', reason: 'cli_probe_not_logged_in' });
});

test('Claude exit one with logged-out stderr confirms failure', async t => {
  const adapter = await fixture(t, 'claude', { stderr: 'Not logged in · Please run /login' });
  assert.deepEqual(await adapter.auth.checkAuth(), { status: 'failure', reason: 'cli_probe_not_logged_in' });
});

const claudeRejections = [
  'Invalid API key · Fix external API key',
  'Invalid auth token · Fix external auth token',
  'Authentication required · Sign in again to continue',
];

for (const output of claudeRejections) {
  for (const stream of ['stdout', 'stderr']) {
    test(`Claude exit one with ${output} on ${stream} confirms failure`, async t => {
      const adapter = await fixture(t, 'claude', { [stream]: output });
      assert.deepEqual(await adapter.auth.checkAuth(), { status: 'failure', reason: 'cli_probe_credentials_rejected' });
    });
  }
  for (const termination of ['signal', 'timeout']) {
    test(`Claude ${output} followed by ${termination} stays uncertain`, async t => {
      const trace = {};
      const adapter = await fixture(t, 'claude', { stdout: output,
        ...(termination === 'signal' ? { signal: 'SIGTERM' } : { wait: true }) },
      { timeout: 1000, trace });
      assert.equal((await adapter.auth.checkAuth()).status, 'uncertain');
      assert.equal(trace.stdout, output, 'rejection text must be captured before interruption');
      assert.equal(typeof trace.code === 'number', false);
      assert.equal(trace.signal, 'SIGTERM');
      if (termination === 'timeout') assert.equal(trace.killed, true);
    });
  }
}

for (const transient of ['api_error', 'rate_limit_error']) {
  test(`Claude explicit rejection mixed with ${transient} remains uncertain`, async t => {
    const adapter = await fixture(t, 'claude', { stdout: claudeRejections[0], stderr: transient });
    assert.deepEqual(await adapter.auth.checkAuth(), { status: 'uncertain', reason: 'cli_probe_uncertain' });
  });
}

for (const transient of ['rate_limit_error', 'api_error']) {
  test(`Claude ${transient} remains transient beside another tool's logged-out text`, async t => {
    const adapter = await fixture(t, 'claude', { stderr: `[mcp] github: Not logged in\n${transient}` });
    assert.deepEqual(await adapter.auth.checkAuth(), { status: 'uncertain', reason: 'cli_probe_uncertain' });
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
      assert.deepEqual(await adapter.auth.checkAuth(), { status: 'uncertain', reason });
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
  ['authentication and API errors', { stderr: 'authentication_error api_error' }, { status: 'failure', reason: 'cli_probe_authentication_error' }],
  ['authentication and rate limit errors', { stderr: 'authentication_error rate_limit_error' }, { status: 'failure', reason: 'cli_probe_authentication_error' }],
]) {
  test(`Claude ${name} preserves its existing result`, async t => {
    const adapter = await fixture(t, 'claude', scenario);
    assert.deepEqual(await adapter.auth.checkAuth(), result);
  });
}

for (const termination of ['signal', 'timeout']) {
  test(`Claude authentication text followed by ${termination} stays uncertain`, async t => {
    const adapter = await fixture(t, 'claude', { stderr: 'authentication_error',
      ...(termination === 'signal' ? { signal: 'SIGTERM' } : { wait: true }) },
    termination === 'timeout' ? { timeout: 1000 } : {});
    const result = await adapter.auth.checkAuth();
    assert.equal(result.status, 'uncertain');
  });
}

async function assertSwitchRejected(target, adapter, status) {
  const original = console.log, previousExit = process.exitCode;
  const lines = [];
  console.log = line => lines.push(line);
  try {
    const result = await runtimeCommand([target, '--json'], {
      execute: (runtime, flags) => executeRuntimeSwitch(runtime, flags, {
        read: () => ({ state: 'ok', config: { runtime: target === 'claude' ? 'codex' : 'claude' } }),
        runtimeFor: () => adapter, exists: () => true, hooksReady: () => ({ ready: true }),
        write: () => assert.fail('rejected auth must not persist the runtime'),
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, status === 'failure' ? 'AUTH_FAILED' : 'AUTH_NOT_CONFIRMED');
    assert.equal(result.error.authStatus, status);
    assert.equal(result.error.message, status === 'failure'
      ? `${target} credentials rejected or not logged in; replace credentials or log in again with zylos auth ${target}`
      : `${target} authentication could not be confirmed; check network/proxy connectivity, then retry zylos runtime ${target}`);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(lines.map(JSON.parse), [result]);
    assert.deepEqual(result.error.persisted, []);
  } finally { console.log = original; process.exitCode = previousExit; }
}

test('Codex API key rejection and unreachable endpoint reach the runtime command unchanged', async t => {
  const adapter = await fixture(t, 'codex', {});
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer fixture-invalid-key');
    res.writeHead(401).end();
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const codexHome = adapter.options.env.CODEX_HOME;
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({
    auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-invalid-key',
  }));
  adapter.options.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  await assertSwitchRejected('codex', adapter, 'failure');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await assertSwitchRejected('codex', adapter, 'uncertain');
});

for (const [output, status] of [['Not logged in', 'failure'], ['rate_limit_error', 'uncertain']]) {
  test(`Claude ${output} reaches the runtime command as ${status}`, async t => {
    const adapter = await fixture(t, 'claude', { stderr: output });
    await assertSwitchRejected('claude', adapter, status);
  });
}

for (const output of claudeRejections) {
  for (const interrupted of [false, true]) {
    const status = interrupted ? 'uncertain' : 'failure';
    test(`Claude ${output}${interrupted ? ' interrupted' : ''} reaches runtime code and remedy as ${status}`, async t => {
      const adapter = await fixture(t, 'claude', { stdout: output,
        ...(interrupted ? { signal: 'SIGTERM' } : {}) });
      await assertSwitchRejected('claude', adapter, status);
    });
  }
}
