import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import { AgyAdapter } from '../agy.js';
import { openTmuxConnection } from '../tmux-connection.js';
import { resolveSessionTarget } from '../session-target.js';

// Integration boundary: real agy adapter launch, environment, identity and paste
// through a private tmux socket, using a synthetic CLI and no model/API calls.
// Run when agy launch or transport changes; unrelated UI/history changes may skip.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR. This case reads
// back every target path before launch; teardown closes clients, kills its own
// server and reaps its fake runtime. No database, live runtime or PM2 is used.
test('agy session launches and receives all lines inside one bracketed paste', { timeout: 10000 }, async t => {
  let connection;
  const f = isolatedTmux(t, { prefix: 'agy-session-', beforeCleanup: () => connection?.close() });
  const env = { HOME: f.dir, ZYLOS_DIR: f.dir, PM2_HOME: path.join(f.dir, 'pm2'), TMPDIR: f.dir,
    PATH: process.env.PATH, AGY_BIN: path.join(f.dir, 'agy'), GEMINI_API_KEY: 'isolated-fake-key' };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(env[key] === f.dir || env[key].startsWith(f.dir + path.sep), key);
  assert.equal(f.socketPath, path.join(f.dir, 's'));
  console.log('isolated agy launch paths', JSON.stringify({ ...Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(k => [k, env[k]])), socketPath: f.socketPath }));
  const source = await fs.readFile(new URL('./fixtures/agy-cli.js', import.meta.url), 'utf8');
  await fs.writeFile(env.AGY_BIN, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  await fs.writeFile(path.join(f.dir, 'AGENTS.md'), '# Isolated test instructions\n');
  const tmuxName = 'isolated-agy';
  const adapter = new AgyAdapter({ root: f.dir, env, tmux: { binary: f.binary, socketPath: f.socketPath, configFile: '/dev/null' }, paths: { tmuxNameForGroup: () => tmuxName } });
  const launched = await adapter.launch({ sessionGroup: null, runId: 'agy-test-run', launchConfig: { runtime: 'agy', mode: 'default' }, sessionMode: 'single' });
  assert.equal(launched.tmuxName, tmuxName);
  const deadline = performance.now() + 2000;
  let observed;
  while (!observed && performance.now() < deadline) {
    try { observed = JSON.parse(await fs.readFile(path.join(f.dir, 'agy-launch.json'), 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(observed, 'Fake runtime must start before transport testing');
  assert.equal(observed.home, f.dir);
  assert.equal(observed.root, f.dir);
  assert.equal(observed.apiKeyPresent, true);
  assert.equal(observed.autoUpdate, 'true');
  assert.equal(observed.runId, 'agy-test-run');
  assert.equal(observed.group, undefined);
  assert.deepEqual(JSON.parse(observed.args[observed.args.indexOf('--settings') + 1]), { modelProvider: 'gemini', trustedWorkspaces: [f.dir] });
  assert.ok(observed.args.includes('-i'));
  connection = await openTmuxConnection({ binary: f.binary, socketPath: f.socketPath });
  const target = await resolveSessionTarget({ connection, tmuxName, readReady: async () => null });
  assert.equal(target.runtime, 'agy');
  const text = 'first line\nsecond line\nthird line';
  await adapter.sendText({ target, connection, text, bracketedPaste: false });
  await adapter.sendKeys({ target, connection, keys: ['Enter'] });
  let received = '';
  const inputDeadline = performance.now() + 2000;
  while (!received.endsWith('\r') && performance.now() < inputDeadline) {
    try { received = await fs.readFile(path.join(f.dir, 'agy-input.txt'), 'utf8'); } catch {}
    if (!received.endsWith('\r')) await new Promise(resolve => setTimeout(resolve, 20));
  }
  // tmux translates LF to CR even in bracketed mode; the surrounding markers
  // tell the CLI these internal newlines belong to one paste, not submissions.
  assert.equal(received, `\x1b[200~${text.replaceAll('\n', '\r')}\x1b[201~\r`);
});
