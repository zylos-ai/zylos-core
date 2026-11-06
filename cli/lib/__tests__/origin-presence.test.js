import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { guardDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../../../skills/comm-bridge/scripts/c4-v2-store.js';
import { openReadStore } from '../c4-read-store.js';
import { readOriginFacts, describeOrigin, formatOriginDescription } from '../origin-presence.js';

const base = { view: 'multi', origin: { presence: 'not_running' },
  originNeed: { inbound: 1, controls: 0, oldestAt: 600 }, runtimeHealth: {}, targetRuntime: 'codex', nowSec: 1000 };
for (const [name, input, state, failure] of [
  ['single absence', { view: 'single' }, 'not_running', false],
  ['single ignores need and auth', { view: 'single', runtimeHealth: { codex: { health: 'auth_failed' } } }, 'not_running', false],
  ['running survives an unreadable need', { origin: { presence: 'running' }, originNeed: { error: { message: 'locked' } } }, 'running', false],
  ['starting survives an unreadable need', { origin: { presence: 'starting' }, originNeed: { error: { message: 'locked' } } }, 'starting', false],
  ['unknown presence stays unknown', { origin: { presence: 'unknown' } }, 'unknown', false],
  ['present work waits for target authentication', { origin: { presence: 'running' }, runtimeHealth: { codex: { health: 'auth_failed' } } }, 'auth_wait', true],
  ['absent work waits for target authentication', { runtimeHealth: { codex: { health: 'auth_failed' } } }, 'auth_wait', true],
  ['unreadable absent need fails', { originNeed: { error: { message: 'locked' } } }, 'need_unreadable', true],
  ['no need sleeps even with failed auth', { originNeed: { inbound: 0, controls: 0, oldestAt: null }, runtimeHealth: { codex: { health: 'auth_failed' } } }, 'sleeping', false],
  ['ready control wakes', { originNeed: { inbound: 0, controls: 1, oldestAt: 701 } }, 'waking', false],
  ['demand at 299 seconds wakes', { originNeed: { inbound: 1, controls: 0, oldestAt: 701 } }, 'waking', false],
  ['demand at 300 seconds is overdue', { originNeed: { inbound: 1, controls: 0, oldestAt: 700 } }, 'wake_overdue', true],
  ['rate limit precedes overdue', { runtimeHealth: { codex: { health: 'rate_limited' } } }, 'rate_wait', false],
  ['present rate limit preserves presence', { origin: { presence: 'running' }, runtimeHealth: { codex: { health: 'rate_limited' } } }, 'running', false],
  ['missing target ignores unrelated auth', { targetRuntime: null, runtimeHealth: { codex: { health: 'auth_failed' } } }, 'wake_overdue', true],
  ['unavailable health keeps time based wake decision', { runtimeHealth: { codex: { health: 'unavailable' } } }, 'wake_overdue', true],
]) test(name, () => assert.deepEqual(describeOrigin({ ...base, ...input }), { state, failure }));

test('messages describe wake conditions and read errors without promising startup', () => {
  for (const state of ['sleeping', 'waking', 'wake_overdue', 'auth_wait', 'rate_wait', 'need_unreadable']) {
    const message = formatOriginDescription({ state }, 'codex', { error: { message: 'database locked' } });
    assert.ok(message); assert.doesNotMatch(message, /start shortly/);
    if (state === 'auth_wait' || state === 'rate_wait') assert.match(message, /codex/);
    if (state === 'need_unreadable') assert.match(message, /database locked/);
  }
  assert.equal(formatOriginDescription({ state: 'running' }, 'codex'), null);
});

test('read facts projects counts, continuation and earliest non-null need and closes on failures', async () => {
  for (const times of [[null, null, null], [120, null, null], [null, 90, null], [null, null, 60], [120, 90, 60], [60, 90, 120], [120, 60, 90]]) {
    let closed = 0;
    const result = await readOriginFacts({ zylosDir: '/isolated', nowSec: 200, open: root => {
      assert.equal(root, '/isolated');
      return { close: () => closed++, store: {
        getOriginNeed: now => { assert.equal(now, 200); return { inbound: { count: 2, oldestAt: times[0] }, controls: { count: 3, oldestAt: times[1] }, continuation: { pending: times[2] !== null, oldestAt: times[2] } }; },
        getModeTransition: () => ({ phase: 'gating' }), getDrainFence: group => { assert.equal(group, 'origin'); return {}; },
      } };
    } });
    assert.deepEqual(result, { originNeed: { inbound: 2, controls: 3, continuation: times[2] !== null, oldestAt: times.every(x => x === null) ? null : Math.min(...times.filter(x => x !== null)) }, transitionOpen: true, fenced: true });
    assert.equal(closed, 1);
  }
  for (const method of ['getOriginNeed', 'getModeTransition', 'getDrainFence']) {
    let closed = 0;
    const store = { getOriginNeed: () => ({ inbound: { count: 0, oldestAt: null }, controls: { count: 0, oldestAt: null }, continuation: { pending: false, oldestAt: null } }), getModeTransition: () => null, getDrainFence: () => null };
    store[method] = () => { throw new Error('cannot read'); };
    assert.deepEqual(await readOriginFacts({ open: () => ({ store, close: () => closed++ }) }), {
      originNeed: { error: { code: 'READ_FAILED', message: 'cannot read' } }, transitionOpen: null, fenced: null,
    });
    assert.equal(closed, 1);
  }
});

// Covers the shared CLI/Dashboard reader against a temporary C4 database. Run
// when its connection or queries change; skip for presentation-only changes.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME; no tmux or service runs.
test('shared reader opens only the supplied C4 read-only, preserving bytes and rows', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const filename = path.join(root, 'comm-bridge', 'c4.db');
  const db = new Database(filename); guardDatabase(db, schema);
  const store = createStore(db, { now: () => 1_000_000 });
  store.insertControl('due', { sessionGroup: 'origin', availableAt: 1100, appendAckSuffix: false });
  store.insertControl('future', { sessionGroup: 'origin', availableAt: 1200, appendAckSuffix: false });
  store.setDrainFence('*', { reason: 'manual_restart', runId: 'restart' });
  db.close();
  const before = fs.readFileSync(filename);
  const opened = await openReadStore(root);
  assert.throws(() => opened.store.insertControl('forbidden', { sessionGroup: 'origin', appendAckSuffix: false }), error => error.code === 'DB_WRITE_FAILED' && /readonly/i.test(error.message));
  opened.close();
  assert.deepEqual(await readOriginFacts({ zylosDir: root, nowSec: 1099 }), { originNeed: { inbound: 0, controls: 0, continuation: false, oldestAt: null }, transitionOpen: false, fenced: true });
  assert.deepEqual(await readOriginFacts({ zylosDir: root, nowSec: 1100 }), { originNeed: { inbound: 0, controls: 1, continuation: false, oldestAt: 1100 }, transitionOpen: false, fenced: true });
  assert.deepEqual(fs.readFileSync(filename), before);
  const missing = await readOriginFacts({ zylosDir: path.join(root, 'missing'), nowSec: 1100 });
  assert.equal(missing.originNeed.error.code, 'READ_FAILED');
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
});

// Covers default target configuration resolution with stubbed tmux observation.
// Run for reader connection/config changes; skip display-only changes. All data
// lives under a temporary directory; the stub cannot create a tmux connection.
test('absent multi target resolution reads strict configuration and C4 without writing', async t => {
  const { createSessionReader } = await import('../session-state-reader-async.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reader = createSessionReader({ env: { ZYLOS_DIR: root }, open: async () => ({ close() {} }), observe: async () => ({ present: false }) });
  await assert.rejects(reader.resolveTargetRuntime('origin'));
  assert.deepEqual(fs.readdirSync(root), []);
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const filename = path.join(root, 'comm-bridge/c4.db');
  const db = new Database(filename); guardDatabase(db, schema); db.close();
  const before = fs.readFileSync(filename);
  assert.equal(await reader.resolveTargetRuntime('origin'), 'codex');
  assert.deepEqual(fs.readFileSync(filename), before);
  fs.writeFileSync(path.join(root, '.zylos/config.json'), '{broken');
  await assert.rejects(reader.resolveTargetRuntime('origin'), error => error.code === 'CONFIG_UNREADABLE');
  const live = createSessionReader({ env: { ZYLOS_DIR: root }, open: async () => ({ close() {} }), observe: async () => ({ present: true, runtime: 'claude' }) });
  assert.equal(await live.resolveTargetRuntime('origin'), 'claude');
});

// Shared reader and interpreter over an isolated file DB. Run for Origin demand
// projections/display; skip unrelated runtime behavior. Official runner isolates
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; no tmux/network/background processes.
// Read handles close inside readOriginFacts; teardown closes writer and files.
test('marker-only Origin facts drive wake and authentication states and sleep after clearing', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'origin-marker-'));
  fs.mkdirSync(path.join(root,'comm-bridge'));
  const db=new Database(path.join(root,'comm-bridge/c4.db')); guardDatabase(db,schema);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const store=createStore(db,{now:()=>700_000,readConfig:()=>({state:'ok',config:{runtime:'codex',session_mode:'multi'}})});
  store.recordRunEnd('origin',{runId:'old',reason:'unexpected'});
  const facts=await readOriginFacts({zylosDir:root,nowSec:999});
  assert.deepEqual(facts.originNeed,{inbound:0,controls:0,continuation:true,oldestAt:700});
  for(const [nowSec,health,state,failure] of [[999,'ok','waking',false],[1000,'ok','wake_overdue',true],[1000,'auth_failed','auth_wait',true],[1000,'rate_limited','rate_wait',false]]) {
    assert.deepEqual(describeOrigin({...base,originNeed:facts.originNeed,nowSec,runtimeHealth:{codex:{health}}}),{state,failure});
  }
  store.clearContinuation('origin',{runId:'new'});
  const cleared=await readOriginFacts({zylosDir:root,nowSec:1000});
  assert.deepEqual(cleared.originNeed,{inbound:0,controls:0,continuation:false,oldestAt:null});
  assert.deepEqual(describeOrigin({...base,originNeed:cleared.originNeed,runtimeHealth:{codex:{health:'auth_failed'}}}),{state:'sleeping',failure:false});
});
