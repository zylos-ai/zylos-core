import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
const { main } = await import('../c4-dispatcher.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// this replaces extraction of the retired single-lane loop. Delivery
// semantics are exercised directly in router-delivery{,-tmux,-pure}.test.js.
test('production entry starts one factory and drains before closing DB on repeated signals', async () => {
  const signals = new EventEmitter(), drain = deferred(), events = [];
  const controller = await main({ signals, log() {}, closeDatabase: () => events.push('close'),
    create: () => { events.push('create'); return {
      start: async () => events.push('start'),
      stop: async () => { events.push('stop'); await drain.promise; events.push('drained'); },
    }; } });
  signals.emit('SIGTERM'); signals.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['create','start','stop']);
  drain.resolve(); await controller.shutdown();
  assert.deepEqual(events, ['create','start','stop','drained','close']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('production startup failure stops owned work before closing DB', async () => {
  const signals = new EventEmitter(), events = [];
  await assert.rejects(main({ signals, log() {}, closeDatabase: () => events.push('close'),
    create: () => ({ start: async () => { throw Error('recovery failed'); }, stop: async () => events.push('stop') }),
  }), /recovery failed/);
  assert.deepEqual(events, ['stop','close']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('PM2-style entry auto-starts and malformed stays alive/inert until signal', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), '{broken');
  const pm2Entry = path.join(root, 'ProcessContainerFork.js');
  fs.writeFileSync(pm2Entry, '// PM2 fixture');
  const child = spawn(process.execPath, ['--input-type=module','-e',
    `process.argv[1]=${JSON.stringify(pm2Entry)}; await import(${JSON.stringify(new URL('../c4-dispatcher.js', import.meta.url).href)});`],
  { env: { ...process.env, HOME: root, ZYLOS_DIR: root, C4_DISPATCHER_DISABLE_MAIN: '0' }, stdio: ['ignore','pipe','pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  for (let i=0; i<100 && !output.includes('Router alert: config_unreadable'); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(output, /C4 Session Router Started/, errors);
  assert.match(output, /Router alert: config_unreadable/);
  fs.writeFileSync(path.join(root, '.zylos/config.json'), '{}');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(child.exitCode, null, errors);
  assert.equal(output.match(/Router alert: config_unreadable/g).length, 1);
  assert.doesNotMatch(output, /C4_PENDING_MAX_AGE_SECONDS/);
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0, errors); assert.equal(signal, null);
});

test('signal during failed startup still drains once before closing DB', async () => {
  const signals = new EventEmitter(), gate = deferred(), events = [];
  const starting = main({ signals, log() {}, closeDatabase: () => events.push('close'),
    create: () => ({ start: async () => { await gate.promise; throw Error('late startup failure'); }, stop: async () => events.push('stop') }),
  });
  signals.emit('SIGTERM'); gate.resolve();
  await assert.rejects(starting, /late startup failure/);
  assert.deepEqual(events, ['stop','close']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
