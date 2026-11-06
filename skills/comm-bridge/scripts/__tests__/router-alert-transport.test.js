import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./helpers/repeated-failure-transport-worker.js', import.meta.url));
const stub = fileURLToPath(new URL('./helpers/repeated-failure-channel.js', import.meta.url));
const expected = '[Zylos] 对话「a」连续 5 次没能重启。最后一次的原因：启动报错（TRANSPORT_FAILURE）。系统会继续重试；已在排队的消息可能在恢复前失败。\n' +
  '[Zylos] Conversation "a" could not restart: 5 attempts failed in a row. Last failure: launch error (TRANSPORT_FAILURE). It keeps retrying. Messages already queued for this conversation can fail before it recovers.';

async function run(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-'));
  const home = path.join(root, 'h'), zylos = path.join(home, 'z'), tmp = path.join(root, 't');
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, 'p'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, ALERT_TRANSPORT_MODE: mode, ALERT_TRANSPORT_RECORDS: path.join(root, 'sends.jsonl') };
  for (const key of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(env[key].startsWith(root + '/'));
  }
  const socket = path.join(tmp, 'tmux-1000', 'fixture');
  assert.ok(Buffer.byteLength(socket) < 104);
  assert.ok(env.PM2_HOME.startsWith(home + '/'));
  for (const channel of ['telegram', 'web-console']) {
    const directory = path.join(zylos, '.claude', 'skills', channel);
    fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
    fs.copyFileSync(stub, path.join(directory, 'scripts', 'send.js'));
  }
  fs.mkdirSync(path.join(zylos, '.zylos'));
  fs.writeFileSync(path.join(zylos, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  t.diagnostic(JSON.stringify({ paths: Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR'].map(key => [key, env[key]])), socket }));
  const child = spawn(process.execPath, [worker], { env, detached: true, stdio: ['ignore','pipe','pipe'] });
  let output = '', errors = '', stoppedAt, closed = false;
  const exit = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() }));
    child.once('error', error => { errors += String(error); resolve({ code: null, signal: null, at: Date.now() }); });
  });
  const close = new Promise(resolve => { child.once('close', () => { closed = true; resolve(); }); });
  const killGroup = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const timer = setTimeout(killGroup, 7000);
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.length > 65536) killGroup();
    for (const line of output.split('\n')) {
      try { const value = JSON.parse(line); if (value.stoppedAt) stoppedAt = value.stoppedAt; } catch {}
    }
  });
  child.stderr.on('data', chunk => { errors += chunk; if (errors.length > 65536) killGroup(); });
  t.after(async () => {
    clearTimeout(timer); killGroup(); await exit;
    if (!closed) await close;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const result = await exit;
  clearTimeout(timer);
  killGroup(); await close;
  assert.equal(result.code, 0, errors.slice(0, 4000) + output.slice(0, 4000));
  assert.ok(stoppedAt, 'Worker stopped the dispatcher and closed both private databases');
  assert.ok(result.at - stoppedAt < 1500, `Natural process exit took ${result.at - stoppedAt}ms after stop`);
  const records = fs.readFileSync(env.ALERT_TRANSPORT_RECORDS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.length >= 1 && records.length <= 2);
  for (const record of records) assert.equal(record.message, expected, 'Factory stdin reached real c4-send and the recording channel unchanged');
  assert.deepEqual(records.map(record => [record.channel, record.endpoint]),
    ['configured','destination_hangs'].includes(mode) ? [['telegram','fixture-owner']] : [['telegram','fixture-owner'],['web-console','console']]);
  t.diagnostic(JSON.stringify({ mode, processExitAfterStopMs: result.at - stoppedAt, deliveries: records.length }));
}

// Real transport boundary: factory -> execFile -> c4-send stdin -> private channel
// script. Run for sender path/argv/stdin/fallback changes; skip unrelated UI.
// Official runner plus fixture isolate five paths, SQLite and short private socket;
// no real tmux/PM2/network. Worker group is killed/reaped before directory removal.
for (const mode of ['configured','fallback']) {
  test(`default alert transport delivers through ${mode}`, { timeout: 10000, skip: process.platform === 'win32' }, async t => run(t, mode));
}

// Process lifecycle boundary: actual default sender hangs in configured or fallback
// channel, stop closes private databases and worker must naturally exit promptly.
// Run for abort/stop/default transport changes; skip template-only/UI changes.
// Same isolated paths/readback/private DB/socket; all child processes belong to a
// bounded worker group, forcibly reclaimed and reaped even on timeout/failure.
for (const mode of ['destination_hangs','console_hangs']) {
  test(`default alert transport permits natural process exit when ${mode}`, { timeout: 10000, skip: process.platform === 'win32' }, async t => run(t, mode));
}
