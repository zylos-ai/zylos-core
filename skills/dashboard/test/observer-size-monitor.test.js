import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/lib/config.js';
import { ObserverSizeMonitor, parseObserverSize } from '../src/lib/observer-size-monitor.js';
import { ObserverUpstream } from '../src/lib/observer-upstream.js';

const active = { target: 'claude-main', tmuxPath: '/usr/bin/tmux', tmuxSocket: '/tmp/agent-socket' };
test('read-only size query uses exact session target with colon, validated status and dimensions', async (t) => {
  const changes = [];
  let output = '100 29 on\n';
  const monitor = new ObserverSizeMonitor({ exec: async (file, args) => {
    assert.equal(file, active.tmuxPath);
    assert.deepEqual(args, ['-N', '-S', active.tmuxSocket, 'display-message', '-p', '-t', '=claude-main:', '#{window_width} #{window_height} #{status}']);
    return { stdout: output };
  }, onChange: (size) => changes.push(size) });
  t.after(() => monitor.stop());
  assert.deepEqual(await monitor.start(active), { cols: 100, rows: 30 });
  await monitor.poll();
  assert.equal(changes.length, 1);
  for (const invalid of ['', '100 29 unknown', 'NaN 29 on', '501 29 on', '100 200 on', '19 5 off', '100 3 off', '100.5 20 off']) {
    output = invalid;
    assert.deepEqual(await monitor.poll(), { cols: 100, rows: 30 });
  }
  output = '140 40 3';
  assert.deepEqual(await monitor.poll(), { cols: 140, rows: 43 });
  assert.equal(changes.length, 2);
  assert.deepEqual(parseObserverSize('100 29 off'), { cols: 100, rows: 29 });
});

test('monitor shares initial query, falls back on failure, fences late results and stops polling', async () => {
  let calls = 0;
  let resolve;
  const changes = [];
  const monitor = new ObserverSizeMonitor({ exec: () => {
    calls++;
    return new Promise((done) => { resolve = done; });
  }, onChange: (size) => changes.push(size) });
  const first = monitor.start(active);
  assert.equal(monitor.start(active), first);
  assert.equal(calls, 1);
  monitor.stop();
  assert.equal(monitor.active, null);
  assert.equal(monitor.timer, null);
  resolve({ stdout: '100 29 on' });
  await first;
  assert.deepEqual(monitor.size, { cols: 80, rows: 24 });
  assert.equal(changes.length, 0);
  await monitor.poll();
  assert.equal(calls, 1);
  monitor.exec = async () => { throw new Error('missing socket'); };
  await monitor.start(active);
  assert.deepEqual(monitor.size, { cols: 80, rows: 24 });
  monitor.stop();
});

test('new generation ignores old query even after its own query completes', async () => {
  let finishOld;
  const newer = { ...active, generation: 2 };
  const monitor = new ObserverSizeMonitor({ exec: () => new Promise((resolve) => { finishOld = resolve; }) });
  const old = monitor.start(active);
  monitor.exec = async () => ({ stdout: '140 39 on' });
  await monitor.start(newer);
  finishOld({ stdout: '100 29 on' });
  await old;
  assert.deepEqual(monitor.size, { cols: 140, rows: 40 });
  monitor.stop();
});

test('upstream emits only validated TerminalResize objects and ignores removed preset names', () => {
  const messages = [];
  const upstream = new ObserverUpstream({ active: {} });
  upstream.control = { sendText: (text) => { messages.push(JSON.parse(text)); return true; } };
  upstream.webClientId = 'viewer';
  assert.equal(upstream.resize({ cols: 100, rows: 30 }), true);
  assert.deepEqual(messages, [{ web_client_id: 'viewer', payload: { type: 'TerminalResize', rows: 30, cols: 100 } }]);
  for (const size of ['standard', { cols: 501, rows: 30 }, { cols: 100.1, rows: 30 }, { cols: 100, rows: 201 }]) {
    assert.equal(upstream.resize(size), false);
  }
  assert.equal(messages.length, 1);
});


test('obsolete defaultPreset config is tolerated without mutation or a default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-config-'));
  const previous = process.env.ZYLOS_DIR;
  try {
    const directory = path.join(root, 'components/dashboard');
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, 'config.json');
    const original = JSON.stringify({ observer: { defaultPreset: 'obsolete-and-invalid', enabled: true } });
    fs.writeFileSync(filename, original);
    process.env.ZYLOS_DIR = root;
    assert.equal(loadConfig().observer.enabled, true);
    assert.equal(fs.readFileSync(filename, 'utf8'), original);
    fs.writeFileSync(filename, '{}');
    assert.equal(Object.hasOwn(loadConfig().observer, 'defaultPreset'), false);
  } finally {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed asynchronous size application retries and cannot publish after stop', async () => {
  let attempts = 0;
  let finish;
  const monitor = new ObserverSizeMonitor({
    exec: async () => ({ stdout: '140 40 on' }),
    onChange: async () => { if (++attempts === 1) throw new Error('private resize failed'); await new Promise((resolve) => { finish = resolve; }); },
  });
  await monitor.start(active);
  assert.deepEqual(monitor.size, { cols: 80, rows: 24 });
  const retry = monitor.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  monitor.stop();
  finish();
  await retry;
  assert.deepEqual(monitor.size, { cols: 80, rows: 24 });
});
