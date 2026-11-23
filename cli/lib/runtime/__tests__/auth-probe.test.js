import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { getRuntime } from '../index.js';

for (const name of ['CLAUDE.md', 'AGENTS.md']) {
  await fs.writeFile(path.join(process.env.ZYLOS_DIR, name), 'Legacy fixture instructions\n');
}

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
  const rt = await getRuntime(runtime);
  return {
    ...rt,
    options,
    identity: { ...rt.identity, findExecutable: () => missing ? null : command },
    auth: { ...rt.auth, checkAuth: () => rt.auth.checkAuth(options) },
  };
}

for (const [stream, output] of [['stderr', 'Not logged in'], ['stdout', 'Not logged in']]) {
  test(`Codex exit one with logged-out text on ${stream} confirms failure`, async t => {
    const adapter = await fixture(t, 'codex', { [stream]: output });
    assert.deepEqual(await adapter.auth.checkAuth(), { status: 'failure', reason: 'not_logged_in' });
  });
}

test('Claude exit one with logged-out stdout confirms failure', async t => {
  const adapter = await fixture(t, 'claude', { stdout: 'Not logged in · Please run /login' });
  assert.deepEqual(await adapter.auth.checkAuth(), { status: 'failure', reason: 'cli_probe_not_logged_in' });
});

const claudeRejections = [
  'Invalid API key · Fix external API key',
  'Invalid auth token · Fix external auth token',
  'Authentication required · Sign in again to continue',
];

for (const transient of ['api_error', 'rate_limit_error']) {
  test(`Claude explicit rejection mixed with ${transient} remains uncertain`, async t => {
    const adapter = await fixture(t, 'claude', { stdout: claudeRejections[0], stderr: transient });
    assert.deepEqual(await adapter.auth.checkAuth(), { status: 'uncertain', reason: 'cli_probe_uncertain' });
  });
}
