import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { deliveryFixture } from './helpers/session-delivery-fixture.js';
import { createLane } from '../router/lane.js';

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

// Integration boundary: real detector, delivery and private conditional ledger;
// terminal I/O supplied by the fixture. Run for input verification changes,
// skip unrelated work. Outer private HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR and
// private socket/DB paths are mandatory; all delivery work is drained by t.after.
test('disputed empty gets one extra Enter and settles without repasting', async t => {
  for (const sequence of [['disputed_empty','empty'], ['disputed_empty','disputed_empty'], ['has_content','has_content','disputed_empty']]) {
    await t.test(sequence.join(' then '), async t => {
      const f = deliveryFixture(t), row = f.message(); f.verdicts.push(...sequence);
      assert.equal((await f.delivery.deliverConversation(row)).delivered, true);
      const saved = f.db.prepare('SELECT status, retry_count FROM conversations WHERE id=?').get(row.id);
      assert.equal(saved.status, 'delivered'); assert.equal(saved.retry_count, 0);
      assert.equal(f.calls.filter(call => call[0] === 'paste').length, 1);
      assert.equal(f.events.filter(event => event.event === 'enter_sent' && event.kind === 'dispute_retry').length, 1);
      assert.ok(f.events.some(event => event.event === 'input_check' && event.verdict === 'disputed_empty'));
    });
  }
});

// Same isolation as above. Run for periodic deadline or group-routing changes;
// no real tmux, background loop, model, transport or live database is used.
test('a new paste carries its group deadline across settled deliveries and normal Enters', async t => {
  const f = deliveryFixture(t), first = f.message('alpha');
  await f.delivery.deliverConversation(first);
  f.time(4000); const second = f.message('alpha'); await f.delivery.deliverConversation(second);
  f.time(5000); await f.delivery.maybePeriodicEnter('alpha');
  const attempt = f.events.find(event => event.event === 'periodic_attempt');
  assert.equal(attempt.itemId, second.id); assert.equal(attempt.session_group, 'alpha');
  assert.equal(f.calls.filter(call => call[0] === 'keys').length, 3);
  assert.equal(f.calls.filter(call => call[0] === 'paste').length, 2);
});

test('periodic budgets are group-local and a new attempt binds the current group runtime', async t => {
  const f = deliveryFixture(t);
  await f.delivery.deliverConversation(f.message('alpha'));
  f.time(4000); await f.delivery.deliverConversation(f.message('beta'));
  f.time(5000); f.run('run-2');
  await f.delivery.maybePeriodicEnter('beta');
  assert.equal(f.events.some(event => event.event === 'periodic_attempt'), false);
  await f.delivery.maybePeriodicEnter('alpha');
  assert.deepEqual(f.calls.at(-1), ['keys','alpha','run-2']);
  assert.equal(f.events.filter(event => event.event === 'periodic_attempt').length, 1);
  await f.delivery.stop(); f.time(20000); await f.delivery.maybePeriodicEnter('beta');
  assert.equal(f.events.filter(event => event.event === 'periodic_attempt').length, 1);
});

test('a lane awaits its group periodic operation before claiming the next message', async () => {
  let release, claimed = false;
  const gate = new Promise(resolve => { release = resolve; });
  const state = { mode: 'single', stopped: false, live: new Map([[null, { present:true, ready:true, runId:'run', sessionId:'session' }]]), activations:new Map() };
  const lane = createLane({ state, now:()=>0, options:{pendingMaxAgeSeconds:100}, diagnostic() {},
    capacityWaits:{clear() {}}, deps:{
      maybePeriodicEnter: async group => { assert.equal(group,null); await gate; },
      readCurrentSession: async () => ({runId:'run',sessionId:'session',startupControlIds:[]}),
      db:{getNextPendingControl:()=>null,getNextPending:()=>({id:1}),expirePending:()=>false,claimConversation:()=>{claimed=true;return true;}},
      deliverConversation:async()=>{},
    } }, null);
  const task = lane.kick(); await new Promise(setImmediate);
  assert.equal(claimed,false); assert.equal(lane.kick(),task);
  release(); await task; assert.equal(claimed,true); lane.stop();
});
