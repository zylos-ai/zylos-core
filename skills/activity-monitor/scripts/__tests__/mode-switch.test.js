import test from 'node:test';
import assert from 'node:assert/strict';
import { ModeSwitchCoordinator } from '../mode-switch.js';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { DispatcherRestartConfirmation } from '../dispatcher-restart-confirmation.js';
import { fixture as databaseFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';

const error = code => Object.assign(new Error(code), { code });
function fixture(overrides = {}) {
  let keyPresent = false;
  let row = null, mode = 'single', time = 1800000000000, fences = [], sourceScenes = [], legacy = false, requests = [];
  const events = [], calls = [], controls = { machine: { running: 0 }, allSessionGroups: { running: 0 } };
  const withoutDeadline = { machine: [], allSessionGroups: [] };
  const db = {
    getModeTransition: () => row,
    expireLegacyRunningControls: () => ({ count: 0, ids: [] }),
    beginModeTransition: (source, target) => { calls.push('begin'); row = { run_id: 'transition', source_mode: source, target_mode: target, phase: 'gating', reason: null, created_at: time / 1000 }; return { runId: row.run_id }; },
    setModeTransitionPhase: (runId, phase, { reason = null } = {}) => { assert.equal(row.run_id, runId); calls.push(phase); row = { ...row, phase, reason }; if (phase === 'complete') fences = []; return row; },
    setDrainFence: (group, options = {}) => { if (!fences.some(f => f.sessionGroup === group)) fences.push({ sessionGroup: group, reason: options.reason ?? null, runId: options.runId ?? null, createdAt: time / 1000 }); },
    listDrainFences: () => fences,
    countNonTerminalControls: target => target.sessionGroup ? { running: 0 } : controls[Object.keys(target)[0]],
    listRunningControlsWithoutDeadline: target => withoutDeadline[Object.keys(target)[0]] ?? [],
    countGlobalRunningConversations: () => 0,
    countRunningConversations: () => 0,
    voidInternalForSingle: () => calls.push('voidInternal'),
    claimUngroupedPendingForOrigin: () => calls.push('claimOrigin'),
    expirePendingControls: target => calls.push(Object.keys(target)[0]),
    clearContinuationsExceptOrigin: () => { calls.push('clearContinuations'); return { cleared: 0 }; },
  };
  const deps = { db, readMode: () => ({ mode, keyPresent: keyPresent || mode !== 'single' }), readConfiguration: () => ({ mode }), readRequests: () => requests,
    legacyPresent: () => legacy, observe: () => sourceScenes, lifecycle: { stopForModeSwitch: async () => {}, advanceReclaim: async () => {} },
    writeMode: value => { calls.push('writeMode'); mode = value; },
    restart: { advance: async () => ({ confirmed: true }) }, diagnostic: event => events.push(event), now: () => time,
    ...overrides };
  return { db, deps, events, calls, controls, withoutDeadline, create: () => new ModeSwitchCoordinator(deps), get row() { return row; },
    set keyPresent(value) { keyPresent = value; }, set row(value) { row = value; }, set mode(value) { mode = value; }, set time(value) { time = value; }, set fences(value) { fences = value; }, get fences() { return fences; },
    set scenes(value) { sourceScenes = value; }, set legacy(value) { legacy = value; }, set requests(value) { requests = value; } };
}
const request = { version: 1, type: 'mode_switch', requestId: 'mode-test', target: 'multi' };

test('admission priority: , config, noop, legacy, manual and unreadable intent', async () => {
  const f = fixture(), owner = f.create();
  f.row = { run_id: 'old', target_mode: 'single' }; f.deps.readMode = () => { throw error('CONFIG_UNREADABLE'); };
  assert.deepEqual(await owner.handle(request), { ok: false, code: 'transition_open', runId: 'old', target: 'single' });
  f.row = null; owner.readMode = f.deps.readMode;
  assert.equal((await owner.handle(request)).code, 'config_unreadable');
  owner.readMode = () => ({ mode: 'multi', keyPresent: true }); owner.readRequests = () => { throw error('requests_unreadable'); };
  assert.deepEqual(await owner.handle(request), { ok: true, result: 'noop' });
  owner.readMode = () => ({ mode: 'single', keyPresent: true }); f.legacy = true;
  assert.equal((await owner.handle(request)).code, 'legacy_session_present'); f.legacy = false;
  owner.readRequests = () => [{ reason: 'manual_restart' }]; assert.equal((await owner.handle(request)).code, 'manual_restart_pending');
  owner.readRequests = () => { throw error('requests_unreadable'); }; await assert.rejects(owner.handle(request), { code: 'requests_unreadable' });
  assert.deepEqual(f.calls, []);
  owner.readRequests = () => []; assert.equal((await owner.handle(request)).result, 'accepted'); assert.deepEqual(f.calls, ['begin']);
});

test('actual admission wrapper defers corrupt until after noop/open checks', async () => {
  const f = fixture(), owner = f.create(); f.mode = 'multi';
  const store = { read: () => { throw error('requests_unreadable'); } };
  owner.readRequests = () => store.read();
  const admission = new SupervisorAdmission({ modeSwitch: request => owner.handle(request), store });
  admission.openEntry(); assert.equal((await admission.handle(request)).result, 'noop');
  f.mode = 'single'; assert.equal((await admission.handle(request)).code, 'requests_unreadable');
  f.row = { run_id: 'already', target_mode: 'multi' }; assert.equal((await admission.handle(request)).code, 'transition_open');
});

test('automatic migration requires all three conditions and emits success only after commit', async () => {
  const f = fixture({ readMode: () => ({ mode: 'single', keyPresent: true }) }), owner = f.create(); await owner.automatic(); assert.deepEqual(f.calls, []);
  owner.readMode = () => ({ mode: null, keyPresent: false }); f.legacy = true; await owner.automatic(); assert.deepEqual(f.calls, []);
  f.legacy = false; f.row = { run_id: 'existing' }; await owner.automatic(); assert.deepEqual(f.calls, []);
  f.row = null; owner.readMode = () => { throw error('CONFIG_UNREADABLE'); }; await assert.rejects(owner.automatic(), { code: 'CONFIG_UNREADABLE' });
  owner.readMode = () => ({ mode: null, keyPresent: false }); const begin = f.db.beginModeTransition;
  f.db.beginModeTransition = () => { throw error('DB_BUSY'); }; await assert.rejects(owner.automatic(), { code: 'DB_BUSY' });
  assert.equal(f.events.some(event => event.event === 'auto_migration_begin'), false);
  f.db.beginModeTransition = begin; await owner.automatic(); await owner.automatic(); assert.equal(f.calls.filter(x => x === 'begin').length, 1);
  assert.equal(f.events.filter(event => event.event === 'auto_migration_begin').length, 1);
});

for (const phase of ['gating', 'converting', 'cutover']) test(`recovery preserves ${phase} state and rejects conflicting`, async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); f.row = { ...f.row, phase }; f.mode = 'invalid';
  await owner.advance(); assert.equal(f.row.reason, 'config_unreadable'); assert.equal(f.row.phase, phase);
  f.mode = 'multi'; await owner.advance();
  if (phase !== 'cutover') assert.equal(f.row.reason, `mode_conflict:${phase}:multi`);
  assert.equal(f.calls.includes('writeMode'), false);
});

test('blocked events deduplicate consecutive reasons, A to B to A emits and success unblocks', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); f.controls.machine = { running: 2 }; f.withoutDeadline.machine = [4, 8];
  await owner.advance(); await owner.advance();
  f.controls.machine = { running: 0 }; f.withoutDeadline.machine = []; f.controls.allSessionGroups = { running: 2 }; f.withoutDeadline.allSessionGroups = [4, 8]; await owner.advance();
  f.controls.machine = { running: 2 }; f.withoutDeadline.machine = [4, 8]; await owner.advance();
  assert.equal(f.events.filter(x => x.event === 'transition_blocked').length, 3);
  f.controls.machine = f.controls.allSessionGroups = { running: 0 }; f.withoutDeadline.machine = f.withoutDeadline.allSessionGroups = []; await owner.advance();
  assert.equal(f.events.filter(x => x.event === 'transition_unblocked').length, 1); assert.equal(f.row.reason, null);
});

test('cutover failure persists one blocked reason without unblocking on retries and recovers', async () => {
  const f = fixture(), owner = f.create();
  await owner.handle(request);
  const set = f.db.setModeTransitionPhase;
  let code = 'DB_WRITE_FAILED';
  f.db.setModeTransitionPhase = (...args) => {
    if (args[1] === 'cutover' && code) throw error(code);
    return set(...args);
  };
  for (let tick = 0; tick < 3; tick++) await owner.advance();
  assert.equal(f.row.phase, 'gating');
  assert.equal(f.row.reason, 'cutover_failed:DB_WRITE_FAILED');
  assert.equal(f.fences[0].sessionGroup, '*');
  assert.equal(f.calls.filter(call => call === 'gating').length, 1, 'persist the same blocked reason only once');
  assert.equal(f.events.filter(event => event.event === 'transition_cutover_failed').length, 1);
  assert.equal(f.events.filter(event => event.event === 'transition_unblocked').length, 0);
  code = null; await owner.advance();
  assert.equal(f.row.phase, 'cutover'); assert.equal(f.row.reason, null);
  assert.equal(f.events.filter(event => event.event === 'transition_unblocked').length, 1);
  await owner.advance();
  assert.equal(f.row.phase, 'complete'); assert.deepEqual(f.fences, []);
  assert.equal(f.events.filter(event => event.event === 'transition_cutover').length, 1);
});

test('observation errors and failed reads never become empty input', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); f.scenes = [{ present: true, observationError: error('TMUX_UNAVAILABLE') }];
  await assert.rejects(owner.advance(), { code: 'INVALID_OBSERVATION' }); assert.equal(f.row.phase, 'gating');
  f.scenes = [];
  f.db.listDrainFences = () => { throw error('DB_BUSY'); }; await assert.rejects(owner.advance(), { code: 'DB_BUSY' });
  assert.equal(f.calls.includes('cutover'), false);
});

test('extra fence prevents expiration/cutover and complete transaction is never replaced by clear', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); await owner.advance();
  f.fences.push({ sessionGroup: 'tg:a', reason: 'model_config', runId: 'old' });
  assert.equal(f.calls.includes('machine'), false);
  await owner.advance(); assert.equal(f.row.reason, 'fence_extra:tg:a');
  f.fences = f.fences.filter(x => x.sessionGroup === '*');
  const set = f.db.setModeTransitionPhase; let fails = true;
  f.db.setModeTransitionPhase = (...args) => { if (args[1] === 'complete' && fails) throw error('DB_BUSY'); return set(...args); };
  await assert.rejects(owner.advance(), { code: 'DB_BUSY' }); assert.equal(f.row.phase, 'cutover'); assert.equal(f.fences.length, 1);
  fails = false; await owner.advance(); assert.equal(f.row.phase, 'complete');
});

test('PM2 adjacent ticks keep baseline/timer and confirmed attempt survives DB failure', async () => {
  let time = 1800000000000, restarts = 0, lists = 0, locked = false;
  const restart = new DispatcherRestartConfirmation({ now: () => time, restart: async () => { assert.equal(locked, false); restarts++; }, list: async () => { assert.equal(locked, false); lists++; return [{ name: 'c4-dispatcher', pm2_env: { status: 'online', pm_uptime: 1800000000001 } }]; } });
  const f = fixture({ restart, now: () => time, serialize: async action => { assert.equal(locked, false); locked = true; try { return await action(); } finally { locked = false; } } }), owner = f.create();
  await owner.handle(request); await owner.advance(); await owner.advance();
  assert.equal(owner.attempt.writtenAt, time); time += 1000; await new Promise(resolve => setImmediate(resolve));
  const set = f.db.setModeTransitionPhase; f.db.setModeTransitionPhase = (...args) => { if (args[1] === 'complete') throw error('DB_BUSY'); return set(...args); };
  await assert.rejects(owner.advance(), { code: 'DB_BUSY' }); assert.equal(owner.attempt.confirmed, true);
  f.db.setModeTransitionPhase = set; time += 1000; await owner.advance();
  assert.equal(f.row.phase, 'complete'); assert.equal(restarts, 1); assert.equal(lists, 1);
});

for (const phase of ['before_rename', 'after_rename']) test(`config ${phase} failure keeps gate and recovers forward`, async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); await owner.advance();
  owner.writeMode = () => { if (phase === 'after_rename') f.mode = 'multi'; throw Object.assign(error('CONFIG_WRITE_FAILED'), { phase }); };
  await owner.advance(); assert.equal(f.row.reason, 'config_write_failed:CONFIG_WRITE_FAILED'); assert.equal(f.row.phase, 'cutover'); assert.equal(f.fences.length, 1);
  owner.writeMode = value => { f.mode = value; }; await owner.advance(); assert.equal(f.row.phase, 'complete');
});

test('second config read fails closed before begin', async () => {
  const f = fixture(); let reads = 0;
  const owner = f.create(); owner.readMode = () => { if (++reads === 2) throw error('EIO'); return { mode: 'single' }; };
  assert.deepEqual(await owner.handle(request), { ok:false, code:'config_unreadable' });
  assert.deepEqual(f.calls, []);
});

test('restart rejection retains cutover and gate then starts fresh attempt', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); await owner.advance();
  owner.restart.advance = async () => { throw error('PM2_FAILED'); };
  await owner.advance(); assert.equal(f.row.reason, 'dispatcher_restart_unconfirmed'); assert.equal(owner.attempt, null);
  assert.equal(f.row.phase, 'cutover'); assert.equal(f.fences.length, 1);
  owner.restart.advance = async () => ({ confirmed: true }); await owner.advance();
  assert.equal(f.row.phase, 'complete'); assert.equal(f.events.filter(x => x.event === 'transition_dispatcher_restart_failed').length, 1);
});

for (const code of ['DB_BUSY', 'DB_READ_FAILED']) test(`missing-deadline detail ${code} propagates without reporting a blocked transition`, async () => {
  const f = fixture();
  const expected = Object.assign(error(code), { persisted: [] });
  f.db.listRunningControlsWithoutDeadline = target => { assert.deepEqual(target, { machine: true }); throw expected; };
  const owner = f.create(); await owner.handle(request);
  f.controls.machine = { running: 1 }; f.withoutDeadline.machine = [4, 8];
  await assert.rejects(owner.advance(), actual => actual === expected);
  assert.equal(f.row.phase, 'gating'); assert.equal(f.row.reason, null);
  assert.deepEqual(f.fences.map(fence => fence.sessionGroup), ['*']);
  assert.deepEqual(f.calls, ['begin']);
  assert.equal(f.events.some(event => event.event === 'transition_blocked'), false);
});

test('gating lists both scopes once before counts and blocks from returned ids', async () => {
  const f = fixture(), reads = [];
  f.db.listRunningControlsWithoutDeadline = target => { reads.push(target); return target.allSessionGroups ? [9, 12] : []; };
  f.db.countNonTerminalControls = () => { throw new Error('counts must not precede missing-deadline lists'); };
  const owner = f.create(); await owner.handle(request); await owner.advance();
  assert.deepEqual(reads, [{ machine: true }, { allSessionGroups: true }, { sessionGroup: 'origin' }]);
  assert.equal(f.row.reason, 'running_control_without_deadline:allSessionGroups:9,12');
  assert.equal(f.row.phase, 'gating'); assert.equal(f.calls.includes('cutover'), false);
});

test('empty deadline lists allow cutover and only running counts gate it', async () => {
  const f = fixture(), reads = [];
  f.db.listRunningControlsWithoutDeadline = target => { reads.push(['list', target]); return []; };
  let running = 1;
  f.db.countNonTerminalControls = target => {
    reads.push(['count', target]);
    return { running };
  };
  const owner = f.create(); await owner.handle(request); await owner.advance();
  assert.equal(f.row.phase, 'gating'); assert.equal(f.row.reason, null);
  assert.deepEqual(reads.slice(0, 2), [['list', { machine: true }], ['list', { allSessionGroups: true }]]);
  running = 0; reads.length = 0; await owner.advance();
  assert.equal(f.row.phase, 'cutover');
  assert.deepEqual(reads, [['list', { machine: true }], ['list', { allSessionGroups: true }], ['list', { sessionGroup: 'origin' }], ['count', { machine: true }], ['count', { allSessionGroups: true }], ['count', { sessionGroup: 'origin' }]]);
});

test('multi reclaim preserves existing reasons, waits starting scenes, cleans before counts', async () => {
  const f = fixture(); f.mode='multi'; const order=[];
  f.scenes=[{sessionGroup:'origin',present:true,ready:true,runId:'o'}, {sessionGroup:'tg:a',present:true,ready:true,runId:'a'}, {sessionGroup:'tg:b',present:true,ready:false,runId:'b'}];
  f.fences=[{sessionGroup:'tg:a',reason:'model_config',runId:'a',createdAt:1800000000}];
  f.deps.lifecycle.advanceReclaim=async fence=>order.push(fence);
  const count=f.db.countNonTerminalControls; f.db.countNonTerminalControls=target=>{assert.equal(order.length,1); return count(target);};
  const owner=f.create(); await owner.handle({...request,target:'single'}); await owner.advance();
  assert.equal(f.fences.find(x=>x.sessionGroup==='tg:a').reason,'model_config');
  assert.equal(f.fences.some(x=>x.sessionGroup==='tg:b'),false);
  assert.deepEqual(order.map(x=>x.sessionGroup),['tg:a']); assert.equal(f.row.phase,'gating');
  f.time=1800003601000; order.length=0; await owner.advance(); assert.equal(f.row.reason,'reclaim_waiting:tg:a');
  assert.equal(f.fences.some(x=>x.sessionGroup==='*'),true);
});

test('automatic migration respects durable manual intent and unreadable intent',async()=>{
 const f=fixture({readMode:()=>({mode:null,keyPresent:false})}), owner=f.create(); f.requests=[{reason:'manual_restart'}];
 await owner.automatic(); assert.deepEqual(f.calls,[]);
 owner.readRequests=()=>{throw error('requests_unreadable');}; await assert.rejects(owner.automatic(),{code:'requests_unreadable'}); assert.deepEqual(f.calls,[]);
});


test('changed between admission reads rejects before creating', async () => {
  const f = fixture(), owner = f.create();
  let reads = 0;
  owner.readMode = () => ({ mode: ++reads === 1 ? 'single' : 'multi', keyPresent: true });
  await assert.rejects(owner.handle(request), { code: 'TRANSITION_PRECONDITION', persisted: [] });
  assert.equal(reads, 2);
  assert.equal(f.row, null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.events, []);
});



test('accepted gating continues without re-reading later damaged', async () => {
  const f = fixture(), owner = f.create();
  await owner.handle(request);
  owner.readRequests = () => { throw error('requests_unreadable'); };
  await owner.advance();
  assert.equal(f.row.phase, 'cutover');
  assert.equal(f.row.reason, null);
  assert.equal(f.calls.filter(call => call === 'cutover').length, 1);
});

test('cutover writes before the completion-only extra fence check', async () => {
  const f = fixture(), owner = f.create();
  await owner.handle(request); await owner.advance();
  f.fences.push({ sessionGroup: 'tg:a', reason: 'model_config', runId: 'old' });
  await owner.advance();
  assert.equal(f.calls.includes('writeMode'), true);
  assert.equal(f.row.phase, 'cutover');
  assert.equal(f.row.reason, 'fence_extra:tg:a');
  assert.equal(f.calls.includes('complete'), false);
});


test('machine blocker still reads each deadline scope exactly once', async () => {
  const f = fixture(), reads = [];
  f.db.listRunningControlsWithoutDeadline = target => { reads.push(target); return target.machine ? [3] : target.allSessionGroups ? [8] : []; };
  const owner = f.create(); await owner.handle(request); await owner.advance();
  assert.deepEqual(reads, [{ machine: true }, { allSessionGroups: true }, { sessionGroup: 'origin' }]);
  assert.equal(f.row.reason, 'running_control_without_deadline:machine:3');
});

test('first unknown observation adds no session fence or reclaim', async () => {
  const f = fixture(); f.mode = 'multi';
  f.scenes = [{sessionGroup:'tg:a', present:true, ready:true, runId:'a', observationError:error('TMUX_UNAVAILABLE')}];
  const reclaimed = []; f.deps.lifecycle.advanceReclaim = async fence => { reclaimed.push(fence); };
  const owner = f.create(); await owner.handle({...request,target:'single'});
  await assert.rejects(owner.advance(), {code:'INVALID_OBSERVATION'});
  assert.deepEqual(f.fences.map(fence => fence.sessionGroup), ['*']);
  assert.deepEqual(reclaimed, []); assert.equal(f.calls.includes('cutover'), false);
});

test('unknown second observation prevents cutover', async () => {
  const f = fixture(); let reads = 0;
  f.deps.observe = () => ++reads === 1 ? [] : [{present:false, observationError:error('TMUX_UNAVAILABLE')}];
  const owner = f.create(); await owner.handle(request);
  await assert.rejects(owner.advance(), {code:'INVALID_OBSERVATION'});
  assert.equal(reads, 2); assert.equal(f.row.phase, 'gating');
  assert.equal(f.calls.includes('cutover'), false);
});

// Real coordinator/private SQLite boundary; run for legacy gate cleanup changes,
// skip unrelated conversion/runtime changes. The official runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR. No tmux, network, PM2 or child processes;
// observation/restart/conversion are injected and fixture teardown closes the DB.
for (const deadline of [null, 1800001000]) test(`old machine control with ${deadline === null ? 'no' : 'future'} deadline gates safely`, async t => {
  let mode = 'single'; const events = [], clock = 1800000000000;
  const { db, store } = databaseFixture(t, { now: () => clock,
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } }) });
  const id = Number(db.prepare(`INSERT INTO control_queue(content,raw_content,status,created_at,updated_at,ack_deadline_at)
    VALUES('exit','exit','running',1700000000,1700000000,?)`).run(deadline).lastInsertRowid);
  const owner = new ModeSwitchCoordinator({ db: store, now: () => clock,
    readMode: () => ({ mode, keyPresent: false }), readConfiguration: () => ({ mode }),
    readRequests: () => [], legacyPresent: () => false, observe: () => [],
    lifecycle: { stopForModeSwitch: async () => {}, advanceReclaim: async () => {} },
    writeMode: target => { mode = target; }, restart: { advance: async () => ({ confirmed: true }) },
    diagnostic: event => events.push(event) });
  assert.equal((await owner.handle(request)).result, 'accepted');
  for (let i = 0; i < 3; i++) await owner.advance();
  const control = db.prepare('SELECT status,last_error FROM control_queue WHERE id=?').get(id);
  if (deadline === null) {
    assert.deepEqual(control, { status: 'timeout', last_error: 'SESSION_ENDED' });
    assert.equal(mode, 'multi'); assert.equal(store.getModeTransition(), null); assert.equal(store.getDrainFence('*'), null);
    const expired = events.filter(event => event.event === 'transition_legacy_controls_expired');
    assert.equal(expired.length, 1); assert.equal(expired[0].count, 1); assert.deepEqual(expired[0].ids, [id]);
  } else {
    assert.equal(control.status, 'running'); assert.equal(mode, 'single'); assert.equal(store.getModeTransition().phase, 'gating');
    assert.ok(store.getDrainFence('*')); assert.equal(events.some(event => event.event === 'transition_legacy_controls_expired'), false);
  }
});

for (const obstacle of ['legacy-live', 'legacy-unknown', 'legacy-error', 'source-live', 'source-error', 'extra-fence', 'db-error']) {
  test(`legacy cleanup preserves gating for ${obstacle}`, async () => {
    const f = fixture(), owner = f.create(); await owner.handle(request);
    f.controls.machine = { running: 1 }; f.withoutDeadline.machine = [4, 8];
    let cleanups = 0;
    owner.db.expireLegacyRunningControls = () => { cleanups++; if (obstacle === 'db-error') throw error('DB_BUSY'); return { count: 1, ids: [4] }; };
    if (obstacle === 'legacy-live') f.legacy = true;
    if (obstacle === 'legacy-unknown') owner.legacyPresent = () => undefined;
    if (obstacle === 'legacy-error') owner.legacyPresent = () => { throw error('TMUX_UNAVAILABLE'); };
    let observations = 0;
    owner.observe = () => {
      observations++;
      if (obstacle === 'source-live' && observations > 1) return [{ present: true }];
      if (obstacle === 'source-error' && observations > 1) return [{ observationError: error('TMUX_UNAVAILABLE') }];
      return [];
    };
    if (obstacle === 'extra-fence') f.fences = [{ sessionGroup: 'origin', reason: 'ttl', runId: 'old' }];
    if (['legacy-error', 'source-error', 'db-error'].includes(obstacle)) await assert.rejects(owner.advance());
    else await owner.advance();
    assert.equal(cleanups, obstacle === 'db-error' ? 1 : 0);
    assert.equal(f.row.phase, 'gating'); assert.equal(f.calls.includes('cutover'), false);
    assert.equal(f.events.some(event => event.event === 'transition_legacy_controls_expired'), false);
  });
}

test('ineligible controls keep one stable blocker without claiming cleanup', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request);
  f.controls.machine = { running: 1 }; f.withoutDeadline.machine = [4, 8];
  await owner.advance(); await owner.advance();
  assert.equal(f.row.reason, 'running_control_without_deadline:machine:4,8');
  assert.equal(f.events.filter(event => event.event === 'transition_blocked').length, 1);
  assert.equal(f.events.some(event => event.event === 'transition_legacy_controls_expired'), false);
  f.fences.push({ sessionGroup: 'origin', reason: 'ttl', runId: 'old' });
  await owner.advance(); await owner.advance();
  assert.equal(f.events.filter(event => event.event === 'transition_blocked').length, 1);
});

test('multi-to-single never applies legacy machine cleanup', async () => {
  const f = fixture(); f.mode = 'multi'; const owner = f.create();
  f.db.expireLegacyRunningControls = () => assert.fail('reverse transition must not clean legacy controls');
  f.controls.machine = { running: 1 }; f.withoutDeadline.machine = [4, 8];
  await owner.handle({ ...request, target: 'single' }); await owner.advance();
  assert.equal(f.row.reason, 'running_control_without_deadline:machine:4,8');
  assert.equal(f.row.phase, 'gating');
});


test('native gate counts and missing deadlines exclude only Origin', async () => {
  const f = fixture(); f.keyPresent = true;
  f.db.listRunningControlsWithoutDeadline = target => target.machine ? [] : target.sessionGroup ? [7] : [7, 8];
  const owner = f.create(); await owner.handle(request); await owner.advance();
  assert.equal(f.row.phase, 'gating');
  assert.equal(f.row.reason, 'running_control_without_deadline:allSessionGroups:8');
  assert.equal(f.calls.includes('cutover'), false);
});

test('handover admission check follows noop and legacy and precedes restart intent', async () => {
  const f = fixture({ globalMemoryPending: () => true }); f.keyPresent = true;
  const owner = f.create(); f.requests = [{ reason: 'manual_restart' }];
  assert.equal((await owner.handle(request)).code, 'global_memory_pending');
  f.legacy = true;
  assert.equal((await owner.handle(request)).code, 'legacy_session_present');
  f.mode = 'multi';
  assert.equal((await owner.handle(request)).result, 'noop');
  assert.equal(f.calls.length, 0);
});

test('missing mode key admits first migration without checking global handover', async () => {
  const f = fixture({ globalMemoryPending: () => assert.fail('legacy global memory belongs to first migration') });
  const owner = f.create();
  assert.equal((await owner.handle(request)).result, 'accepted');
});
