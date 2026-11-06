import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-config-'));
  let connection, child, exited;
  t.after(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        let timer;
        try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000); })]); }
        finally { clearTimeout(timer); }
        await exited;
      }
    } finally {
      connection?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const bin = path.join(root, 'bin'), tmp = path.join(root, 'tmp');
  for (const dir of [bin, tmp, path.join(zylos, '.zylos'), path.join(zylos, 'comm-bridge')]) fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(zylos, '.zylos', 'config.json');
  const valid = JSON.stringify({ runtime: 'claude', session_mode: 'multi' });
  fs.writeFileSync(configFile, valid);
  fs.writeFileSync(path.join(zylos, '.env'), '');
  // An empty observation represents an absent target; this binary cannot start tmux.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}\nif (!process.argv.includes('display-message')) process.exit(71);\n`, { mode: 0o755 });
  connection = new Database(path.join(zylos, 'comm-bridge', 'c4.db'));
  guardDatabase(connection, schema);
  const store = createStore(connection, { validateComponent: () => true });
  store.registerChannelNamespace('web-console', 'console');
  const port = await freePort();
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, PATH: bin, ZYLOS_PACKAGE_ROOT: repository,
    WEB_CONSOLE_BIND: '127.0.0.1', WEB_CONSOLE_PORT: String(port), WEB_CONSOLE_SKILLS_DIR: path.join(repository, 'skills') };
  for (const key of Object.keys(env)) {
    if (key === 'TMUX' || /(?:TOKEN|SECRET|PASSWORD|API_KEY)/.test(key) ||
      ['ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID'].includes(key)) delete env[key];
  }
  assert.ok(root.startsWith(`${os.tmpdir()}${path.sep}`));
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(env[key].startsWith(`${root}${path.sep}`));
  console.log('Console isolation:', JSON.stringify(Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH', 'WEB_CONSOLE_BIND'].map(key => [key, env[key]]))));
  child = spawn(process.execPath, [path.join(repository, 'skills/web-console/scripts/server.js')], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '', overflow = false;
  const capture = data => {
    output += data.toString();
    if (output.length > 65536) { output = output.slice(-65536); overflow = true; child.kill('SIGKILL'); }
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  exited = once(child, 'exit');
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(overflow, false, 'Server output limit exceeded');
    assert.equal(child.exitCode, null, output);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
      assert.fail(`Server returned ${response.status} while starting: ${output}`);
    } catch (error) {
      if (error.code === 'ERR_ASSERTION') throw error;
    }
    await wait(25);
  }
  assert.ok(ready, output);
  return { configFile, valid, url, connection, output: () => output };
}

function dom() {
  const dot = { className: '', classList: { add(value) { dot.className += ` ${value}`; } } };
  const text = { textContent: '', set innerHTML(_) { assert.fail('Status must use textContent'); } };
  return { statusDot: dot, statusText: text };
}

let consoleClass;
async function frontend() {
  if (!consoleClass) {
    const old = globalThis.document;
    globalThis.document = { addEventListener() {} };
    try { ({ ZylosConsole: consoleClass } = await import('../../public/app.js')); }
    finally { if (old === undefined) delete globalThis.document; else globalThis.document = old; }
  }
  return consoleClass;
}

// Real HTTP server, status reader and private SQLite; no messages, PM2, runtime
// or tmux are started. Run for status/config-reader or browser status wiring
// changes; unrelated attachment/chat edits may skip this case. The official
// runner and fixture both isolate paths; teardown owns server and both DBs.
test('HTTP status explains corrupt configuration and clears it after repair', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const ZylosConsole = await frontend();
  const display = dom();
  async function read() {
    const response = await fetch(`${f.url}/api/status`, { signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 200);
    return response.json();
  }
  const baseline = await read();
  assert.deepEqual(baseline, { state: 'not_running', reason: 'not_running', sessionGroup: 'console' });
  assert.equal('configurationIssue' in baseline, false);
  const index = await (await fetch(`${f.url}/`)).text();
  assert.match(index, /<script[^>]*type="module"[^>]*src="app\.js[^" ]*"/);
  for (const [source, reason] of [
    ['{', /JSON|position|property name/],
    ['{"runtime":"unsupported","session_mode":"multi"}', /Unsupported runtime: unsupported/],
    ['{"runtime":"claude","session_mode":"wrong"}', /session_mode/]
  ]) {
    fs.writeFileSync(f.configFile, source);
    const status = await read();
    assert.equal(status.state, 'error');
    assert.equal(status.configurationIssue.code, 'CONFIG_UNREADABLE');
    assert.match(status.configurationIssue.message, reason);
    assert.match(status.configurationIssue.notice, /Origin/);
    assert.match(status.configurationIssue.notice, /automatically/);
    assert.equal(status.message, status.configurationIssue.notice);
    ZylosConsole.prototype.updateStatusDisplay.call(display, status);
    assert.equal(display.statusText.textContent, status.configurationIssue.notice);
    assert.match(display.statusDot.className, /offline/);
    assert.equal(fs.readFileSync(f.configFile, 'utf8'), source, 'Status must not repair configuration');
    fs.writeFileSync(f.configFile, f.valid);
    const repaired = await read();
    assert.deepEqual(repaired, baseline);
    ZylosConsole.prototype.updateStatusDisplay.call(display, repaired);
    assert.doesNotMatch(display.statusText.textContent, /CONFIG_UNREADABLE|configuration|Origin/);
  }
  assert.equal(f.connection.prepare('SELECT count(*) AS n FROM conversations').get().n, 0, 'Status must never send a chat message');
  assert.equal(f.connection.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0, 'Status must never enqueue a control');
});

test('browser status renders the configuration reason as literal text and restores healthy display', async () => {
  const ZylosConsole = await frontend();
  const display = dom();
  const notice = 'Instance configuration unreadable [CONFIG_UNREADABLE]: <img onerror=alert(1)>; all groups including Origin cannot start; repair recovers automatically.';
  ZylosConsole.prototype.updateStatusDisplay.call(display, { state: 'error', message: notice, configurationIssue: { code: 'CONFIG_UNREADABLE', message: '<img onerror=alert(1)>', notice } });
  assert.equal(display.statusText.textContent, notice);
  assert.match(display.statusDot.className, /offline/);
  for (const [state, text, cls] of [['idle', 'Claude is ready', 'online'], ['busy', 'Claude is busy', 'busy'], ['offline', 'Claude is offline', 'offline']]) {
    ZylosConsole.prototype.updateStatusDisplay.call(display, { state });
    assert.equal(display.statusText.textContent, text);
    assert.equal(display.statusDot.className, `status-dot ${cls}`);
  }
});
