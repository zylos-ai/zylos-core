import test from 'node:test';
import assert from 'node:assert/strict';
import { ModeSwitchCoordinator } from '../mode-switch.js';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { DispatcherRestartConfirmation } from '../dispatcher-restart-confirmation.js';
import { HANDOFF_FOLLOWUP_PROMPT } from '../origin-prompts.js';
import { fixture as databaseFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';

const error = code => Object.assign(new Error(code), { code });
function fixture(overrides = {}) {
  let row = null, mode = 'single', time = 1800000000000, fences = [], sourceScenes = [], legacy = false, requests = [];
  const events = [], calls = [], controls = { machine: { running: 0, runningWithoutDeadline: 0 }, allSessionGroups: { running: 0, runningWithoutDeadline: 0 } };
  const db = {
    getModeTransition: () => row,
    expireLegacyRunningControls: () => ({ count: 0, ids: [] }),
    beginModeTransition: (source, target) => { calls.push('begin'); row = { run_id: 'transition', source_mode: source, target_mode: target, phase: 'gating', reason: null, created_at: time / 1000 }; return { runId: row.run_id }; },
    setModeTransitionPhase: (runId, phase, { reason = null } = {}) => { assert.equal(row.run_id, runId); calls.push(phase); row = { ...row, phase, reason }; if (phase === 'complete') fences = []; return row; },
    setDrainFence: (group, options = {}) => { if (!fences.some(f => f.sessionGroup === group)) fences.push({ sessionGroup: group, reason: options.reason ?? null, runId: options.runId ?? null, createdAt: time / 1000 }); },
    listDrainFences: () => fences,
    countNonTerminalControls: target => controls[Object.keys(target)[0]],
    listRunningControlsWithoutDeadline: target => controls[Object.keys(target)[0]].runningWithoutDeadline ? [4, 8] : [],
    countGlobalRunningConversations: () => 0,
    absorbForTransition: () => { calls.push('absorb'); row = { ...row, phase: 'converting', cutoff: 10, absorbed_ids: [] }; return { cutoff: 10, absorbedIds: [] }; },
    expirePendingControls: target => calls.push(Object.keys(target)[0]),
    clearAllContinuations: () => { calls.push('clearContinuations'); return { cleared: 0 }; },
    insertControl: (content, options) => { assert.equal(content,HANDOFF_FOLLOWUP_PROMPT); assert.deepEqual(options,{sessionGroup:'origin',priority:2,appendAckSuffix:false}); calls.push('followup'); },
  };
  const deps = { db, readMode: () => ({ mode, keyPresent: true }), readConfiguration: () => ({ mode }), readRequests: () => requests,
    legacyPresent: () => legacy, observe: () => sourceScenes, lifecycle: { advanceReclaim: async () => {} },
    convert: () => { calls.push('convert'); }, writeMode: value => { calls.push('writeMode'); mode = value; },
    restart: { advance: async () => ({ confirmed: true }) }, diagnostic: event => events.push(event), now: () => time,
    ...overrides };
  return { db, deps, events, calls, controls, create: () => new ModeSwitchCoordinator(deps), get row() { return row; },
    set row(value) { row = value; }, set mode(value) { mode = value; }, set time(value) { time = value; }, set fences(value) { fences = value; }, get fences() { return fences; },
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
  const f = fixture(), owner = f.create(); await owner.automatic(); assert.deepEqual(f.calls, []);
  owner.readMode = () => ({ mode: null, keyPresent: false }); f.legacy = true; await owner.automatic(); assert.deepEqual(f.calls, []);
  f.legacy = false; f.row = { run_id: 'existing' }; await owner.automatic(); assert.deepEqual(f.calls, []);
  f.row = null; owner.readMode = () => { throw error('CONFIG_UNREADABLE'); }; await assert.rejects(owner.automatic(), { code: 'CONFIG_UNREADABLE' });
  owner.readMode = () => ({ mode: null, keyPresent: false }); const begin = f.db.beginModeTransition;
  f.db.beginModeTransition = () => { throw error('DB_BUSY'); }; await assert.rejects(owner.automatic(), { code: 'DB_BUSY' });
  assert.equal(f.events.some(event => event.event === 'auto_migration_begin'), false);
  f.db.beginModeTransition = begin; await owner.automatic(); await owner.automatic(); assert.equal(f.calls.filter(x => x === 'begin').length, 1);
  assert.equal(f.events.filter(event => event.event === 'auto_migration_begin').length, 1);
});

test('stages only move forward and conversion never repeats after cutover', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request);
  await owner.advance(); assert.equal(f.row.phase, 'converting'); assert.equal(f.fences[0].sessionGroup, '*');
  await owner.advance(); assert.equal(f.row.phase, 'cutover');
  await owner.advance(); assert.equal(f.row.phase, 'complete'); assert.deepEqual(f.fences, []);
  assert.deepEqual(f.calls, ['begin', 'absorb', 'convert', 'machine', 'allSessionGroups', 'clearContinuations', 'cutover', 'writeMode', 'followup', 'complete']);
});

// Integration boundary: real mode coordinator and memory SQLite only. Run for
// cutover marker cleanup changes; skip unrelated process/runtime conversion.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; scene,
// conversion, restart and clock are injected, with no tmux/network/PM2/notify.
// Store teardown closes its private database; this case starts no background work.
test('mode cutover clears every pending restart marker before changing mode and does not restore them', async t => {
  let mode = 'multi';
  const clock = 1800000000000;
  const { store } = databaseFixture(t, { now: () => clock,
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } }) });
  for (const group of ['origin', 'telegram:a']) {
    store.recordRunEnd(group, { runId: `ended-${group}`, reason: 'unexpected' });
  }
  const originalPhase = store.setModeTransitionPhase;
  let cutovers = 0;
  store.setModeTransitionPhase = (runId, phase, ...options) => {
    if (phase === 'cutover') {
      cutovers++;
      assert.deepEqual(store.listRunEndings(['origin', 'telegram:a']).map(row => row.continuationPending), [0, 0]);
    }
    return originalPhase(runId, phase, ...options);
  };
  const owner = new ModeSwitchCoordinator({ db: store, now: () => clock,
    readMode: () => ({ mode, keyPresent: true }), readConfiguration: () => ({ mode }),
    readRequests: () => [], legacyPresent: () => false, observe: () => [],
    lifecycle: { advanceReclaim: async () => {} }, convert: async () => {},
    writeMode: target => { mode = target; }, restart: { advance: async () => ({ confirmed: true }) } });
  for (const target of ['single', 'multi']) {
    assert.equal((await owner.handle({ ...request, target })).result, 'accepted');
    for (let i = 0; i < 3; i++) await owner.advance();
    assert.equal(mode, target);
    assert.equal(store.getModeTransition(), null);
  }
  assert.equal(cutovers, 2);
  assert.deepEqual(store.listPendingContinuations(), []);
});

for (const persistedMode of ['single','multi']) test(`cutover from persisted ${persistedMode} retries failed followup before completion without restarting dispatcher`, async () => {
  const f=fixture(); f.row={run_id:'transition',source_mode:'single',target_mode:'multi',phase:'cutover',reason:null};
  f.mode=persistedMode; f.fences=[{sessionGroup:'*',reason:null,runId:null}];
  let restarts=0,writes=0; f.deps.restart={advance:()=>{restarts++;return {confirmed:true};}};
  const insert=f.db.insertControl; f.db.insertControl=(...args)=>{if(++writes===1)throw error('DB_BUSY');return insert(...args);};
  const owner=f.create(); await assert.rejects(owner.advance(),{code:'DB_BUSY'});
  assert.equal(f.row.phase,'cutover');assert.equal(f.fences[0].sessionGroup,'*');assert.equal(owner.attempt.confirmed,true);
  await owner.advance();assert.equal(f.row.phase,'complete');assert.equal(restarts,1);assert.equal(writes,2);
  assert.ok(f.calls.indexOf('followup')<f.calls.indexOf('complete'));
  assert.equal(f.calls.filter(call => call === 'clearContinuations').length, 0);
  assert.equal(f.calls.filter(call => call === 'followup').length, 1);
});

test('cutover to single does not enqueue an Origin followup', async () => {
  const f=fixture();f.row={run_id:'transition',source_mode:'multi',target_mode:'single',phase:'cutover',reason:null};
  f.mode='multi';f.fences=[{sessionGroup:'*',reason:null,runId:null}];
  f.db.insertControl=()=>{throw new Error('single cannot wake Origin');};
  await f.create().advance();assert.equal(f.row.phase,'complete');
});

// Integration boundary: real coordinator and private SQLite; run for cutover retry
// or completion changes, skip unrelated runtime/process conversion. Official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; no tmux/network/PM2 or child work.
// Configuration/restart are injected and fixture teardown closes the private DB.
for(const persistedMode of ['single','multi']) test(`real cutover resumed on ${persistedMode} converges to one pending followup after a completion crash`,async t=>{
  let mode=persistedMode,fail=true;
  const {db,store}=databaseFixture(t,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:mode}})});
  const {runId}=store.beginModeTransition('single','multi');store.setDrainFence('*');store.absorbForTransition(runId);store.setModeTransitionPhase(runId,'cutover');
  const deps={db:{...store,setModeTransitionPhase:(id,phase,options)=>{if(phase==='complete'&&fail)throw error('DB_BUSY');return store.setModeTransitionPhase(id,phase,options);}},
    readMode:()=>({mode}),writeMode:target=>{mode=target;},restart:{advance:()=>({confirmed:true})}};
  await assert.rejects(new ModeSwitchCoordinator(deps).advance(),{code:'DB_BUSY'});
  assert.equal(store.getModeTransition().phase,'cutover');assert.ok(store.getDrainFence('*'));
  assert.equal(store.getOriginNeed().controls.count,1);
  fail=false;await new ModeSwitchCoordinator(deps).advance();
  assert.equal(store.getModeTransition(),null);assert.equal(store.getDrainFence('*'),null);
  const pending=db.prepare("SELECT * FROM control_queue WHERE status='pending'").all();
  assert.equal(pending.length,1);assert.equal(pending[0].raw_content,HANDOFF_FOLLOWUP_PROMPT);assert.equal(pending[0].target_binding,null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM control_queue WHERE status='superseded'").get().n,1);
  assert.ok(pending[0].created_at<=store.getLastCompletedModeTransition().updated_at);
});

for (const phase of ['gating', 'converting', 'cutover']) test(`recovery preserves ${phase} state and rejects conflicting`, async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); f.row = { ...f.row, phase }; f.mode = 'invalid';
  await owner.advance(); assert.equal(f.row.reason, 'config_unreadable'); assert.equal(f.row.phase, phase);
  f.mode = 'multi'; await owner.advance();
  if (phase !== 'cutover') assert.equal(f.row.reason, `mode_conflict:${phase}:multi`);
  assert.equal(f.calls.includes('absorb'), false); assert.equal(f.calls.includes('convert'), false);
});

test('blocked events deduplicate consecutive reasons, A to B to A emits and success unblocks', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); f.controls.machine = { running: 2, runningWithoutDeadline: 2 };
  await owner.advance(); await owner.advance();
  f.controls.machine = { running: 0, runningWithoutDeadline: 0 }; f.controls.allSessionGroups = { running: 2, runningWithoutDeadline: 2 }; await owner.advance();
  f.controls.machine = { running: 2, runningWithoutDeadline: 2 }; await owner.advance();
  assert.equal(f.events.filter(x => x.event === 'transition_blocked').length, 3);
  f.controls.machine = f.controls.allSessionGroups = { running: 0, runningWithoutDeadline: 0 }; await owner.advance();
  assert.equal(f.events.filter(x => x.event === 'transition_unblocked').length, 1); assert.equal(f.row.reason, null);
});

test('conversion failure retains phase and gate, then retries without absorbing again', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); await owner.advance();
  owner.convert = () => { throw Object.assign(error('EIO'), { step: 'export' }); };
  await owner.advance(); await owner.advance(); assert.equal(f.row.reason, 'conversion_failed:export:EIO');
  assert.equal(f.events.filter(x => x.event === 'transition_convert_failed').length, 1); assert.equal(f.fences.length, 1);
  owner.convert = () => {}; await owner.advance(); assert.equal(f.row.phase, 'cutover');
  assert.equal(f.calls.filter(x => x === 'absorb').length, 1);
});

test('observation errors and failed reads never become empty input', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); f.scenes = [{ present: true, observationError: error('TMUX_UNAVAILABLE') }];
  await assert.rejects(owner.advance(), { code: 'INVALID_OBSERVATION' }); assert.equal(f.row.phase, 'gating');
  f.scenes = [];
  f.db.listDrainFences = () => { throw error('DB_BUSY'); }; await assert.rejects(owner.advance(), { code: 'DB_BUSY' });
  assert.equal(f.calls.includes('absorb'), false);
});

test('extra fence prevents expiration/cutover and complete transaction is never replaced by clear', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); await owner.advance();
  f.fences.push({ sessionGroup: 'tg:a', reason: 'model_config', runId: 'old' });
  await owner.advance(); assert.equal(f.row.reason, 'fence_extra:tg:a'); assert.equal(f.calls.includes('machine'), false);
  f.fences = f.fences.filter(x => x.sessionGroup === '*'); await owner.advance();
  const set = f.db.setModeTransitionPhase; let fails = true;
  f.db.setModeTransitionPhase = (...args) => { if (args[1] === 'complete' && fails) throw error('DB_BUSY'); return set(...args); };
  await assert.rejects(owner.advance(), { code: 'DB_BUSY' }); assert.equal(f.row.phase, 'cutover'); assert.equal(f.fences.length, 1);
  fails = false; await owner.advance(); assert.equal(f.row.phase, 'complete');
});

test('PM2 adjacent ticks keep baseline/timer and confirmed attempt survives DB failure', async () => {
  let time = 1800000000000, restarts = 0, lists = 0, locked = false;
  const restart = new DispatcherRestartConfirmation({ now: () => time, restart: async () => { assert.equal(locked, false); restarts++; }, list: async () => { assert.equal(locked, false); lists++; return [{ name: 'c4-dispatcher', pm2_env: { status: 'online', pm_uptime: 1800000000001 } }]; } });
  const f = fixture({ restart, now: () => time, serialize: async action => { assert.equal(locked, false); locked = true; try { return await action(); } finally { locked = false; } } }), owner = f.create();
  await owner.handle(request); await owner.advance(); await owner.advance(); await owner.advance();
  assert.equal(owner.attempt.writtenAt, time); time += 1000; await new Promise(resolve => setImmediate(resolve));
  const set = f.db.setModeTransitionPhase; f.db.setModeTransitionPhase = (...args) => { if (args[1] === 'complete') throw error('DB_BUSY'); return set(...args); };
  await assert.rejects(owner.advance(), { code: 'DB_BUSY' }); assert.equal(owner.attempt.confirmed, true);
  f.db.setModeTransitionPhase = set; time += 1000; await owner.advance();
  assert.equal(f.row.phase, 'complete'); assert.equal(restarts, 1); assert.equal(lists, 1);
});

for (const phase of ['before_rename', 'after_rename']) test(`config ${phase} failure keeps gate and recovers forward`, async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); await owner.advance(); await owner.advance();
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
  const f = fixture(), owner = f.create(); await owner.handle(request); await owner.advance(); await owner.advance();
  owner.restart.advance = async () => { throw error('PM2_FAILED'); };
  await owner.advance(); assert.equal(f.row.reason, 'dispatcher_restart_unconfirmed'); assert.equal(owner.attempt, null);
  assert.equal(f.row.phase, 'cutover'); assert.equal(f.fences.length, 1);
  owner.restart.advance = async () => ({ confirmed: true }); await owner.advance();
  assert.equal(f.row.phase, 'complete'); assert.equal(f.events.filter(x => x.event === 'transition_dispatcher_restart_failed').length, 1);
});

for (const code of ['DB_BUSY', 'DB_READ_FAILED']) test(`missing-deadline detail ${code} propagates without blocking or absorbing`, async () => {
  const f = fixture();
  const expected = Object.assign(error(code), { persisted: [] });
  f.db.listRunningControlsWithoutDeadline = target => { assert.deepEqual(target, { machine: true }); throw expected; };
  const owner = f.create(); await owner.handle(request);
  f.controls.machine = { running: 1, runningWithoutDeadline: 1 };
  await assert.rejects(owner.advance(), actual => actual === expected);
  assert.equal(f.row.phase, 'gating'); assert.equal(f.row.reason, null);
  assert.deepEqual(f.fences.map(fence => fence.sessionGroup), ['*']);
  assert.deepEqual(f.calls, ['begin']);
  assert.equal(f.events.some(event => event.event === 'transition_blocked'), false);
});

test('gating lists both scopes once before counts and blocks from returned ids', async () => {
  const f = fixture(), reads = [];
  f.db.listRunningControlsWithoutDeadline = target => { reads.push(target); return target.machine ? [] : [9, 12]; };
  f.db.countNonTerminalControls = () => { throw new Error('counts must not precede missing-deadline lists'); };
  const owner = f.create(); await owner.handle(request); await owner.advance();
  assert.deepEqual(reads, [{ machine: true }, { allSessionGroups: true }]);
  assert.equal(f.row.reason, 'running_control_without_deadline:allSessionGroups:9,12');
  assert.equal(f.row.phase, 'gating'); assert.equal(f.calls.includes('absorb'), false);
});

test('empty deadline lists allow absorption and only running counts gate it', async () => {
  const f = fixture(), reads = [];
  f.db.listRunningControlsWithoutDeadline = target => { reads.push(['list', target]); return []; };
  let running = 1;
  f.db.countNonTerminalControls = target => {
    reads.push(['count', target]);
    return { running, get runningWithoutDeadline() { throw new Error('obsolete deadline count read'); } };
  };
  const owner = f.create(); await owner.handle(request); await owner.advance();
  assert.equal(f.row.phase, 'gating'); assert.equal(f.row.reason, null);
  assert.deepEqual(reads.slice(0, 2), [['list', { machine: true }], ['list', { allSessionGroups: true }]]);
  running = 0; reads.length = 0; await owner.advance();
  assert.equal(f.row.phase, 'converting');
  assert.deepEqual(reads, [['list', { machine: true }], ['list', { allSessionGroups: true }], ['count', { machine: true }], ['count', { allSessionGroups: true }]]);
});

test('multi reclaim preserves existing reasons, waits starting scenes, cleans before counts', async () => {
  const f = fixture(); f.mode='multi'; const order=[];
  f.scenes=[{sessionGroup:'origin',present:true,ready:true,runId:'o'}, {sessionGroup:'tg:a',present:true,ready:true,runId:'a'}, {sessionGroup:'tg:b',present:true,ready:false,runId:'b'}];
  f.fences=[{sessionGroup:'tg:a',reason:'model_config',runId:'a',createdAt:1800000000}];
  f.deps.lifecycle.advanceReclaim=async fence=>order.push(fence);
  const count=f.db.countNonTerminalControls; f.db.countNonTerminalControls=target=>{assert.equal(order.length,2); return count(target);};
  const owner=f.create(); await owner.handle({...request,target:'single'}); await owner.advance();
  assert.equal(f.fences.find(x=>x.sessionGroup==='tg:a').reason,'model_config');
  assert.equal(f.fences.some(x=>x.sessionGroup==='tg:b'),false);
  assert.deepEqual(order.map(x=>x.sessionGroup),['tg:a','origin']); assert.equal(f.row.phase,'gating');
  f.time=1800003601000; order.length=0; await owner.advance(); assert.equal(f.row.reason,'reclaim_waiting:origin,tg:a');
  assert.equal(f.fences.some(x=>x.sessionGroup==='*'),true);
});

test('single reclaim uses global scope without creating a per-group fence', async () => {
  const f=fixture(), calls=[]; f.scenes=[{sessionGroup:'origin',present:true,ready:true,runId:'single-run'}];
  f.deps.lifecycle.advanceReclaim=async (...args)=>calls.push(args);
  const owner=f.create(); await owner.handle(request); await owner.advance();
  assert.deepEqual(calls[0][0],{sessionGroup:null,reason:'mode_switch',runId:'single-run'});
  assert.deepEqual(calls[0][2],{unfenced:true}); assert.deepEqual(f.fences.map(x=>x.sessionGroup),['*']); assert.equal(f.row.phase,'gating');
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
  assert.equal(f.row.phase, 'converting');
  assert.equal(f.row.reason, null);
  assert.equal(f.calls.filter(call => call === 'absorb').length, 1);
});

test('cutover writes before the completion-only extra fence check', async () => {
  const f = fixture(), owner = f.create();
  await owner.handle(request); await owner.advance(); await owner.advance();
  f.fences.push({ sessionGroup: 'tg:a', reason: 'model_config', runId: 'old' });
  await owner.advance();
  assert.equal(f.calls.includes('writeMode'), true);
  assert.equal(f.row.phase, 'cutover');
  assert.equal(f.row.reason, 'fence_extra:tg:a');
  assert.equal(f.calls.includes('complete'), false);
});


test('machine blocker still reads each deadline scope exactly once', async () => {
  const f = fixture(), reads = [];
  f.db.listRunningControlsWithoutDeadline = target => { reads.push(target); return target.machine ? [3] : [8]; };
  const owner = f.create(); await owner.handle(request); await owner.advance();
  assert.deepEqual(reads, [{ machine: true }, { allSessionGroups: true }]);
  assert.equal(f.row.reason, 'running_control_without_deadline:machine:3');
});

test('first unknown observation adds no session fence or reclaim', async () => {
  const f = fixture(); f.mode = 'multi';
  f.scenes = [{sessionGroup:'tg:a', present:true, ready:true, runId:'a', observationError:error('TMUX_UNAVAILABLE')}];
  const reclaimed = []; f.deps.lifecycle.advanceReclaim = async fence => { reclaimed.push(fence); };
  const owner = f.create(); await owner.handle({...request,target:'single'});
  await assert.rejects(owner.advance(), {code:'INVALID_OBSERVATION'});
  assert.deepEqual(f.fences.map(fence => fence.sessionGroup), ['*']);
  assert.deepEqual(reclaimed, []); assert.equal(f.calls.includes('absorb'), false);
});

test('unknown second observation prevents absorption', async () => {
  const f = fixture(); let reads = 0;
  f.deps.observe = () => ++reads === 1 ? [] : [{present:false, observationError:error('TMUX_UNAVAILABLE')}];
  const owner = f.create(); await owner.handle(request);
  await assert.rejects(owner.advance(), {code:'INVALID_OBSERVATION'});
  assert.equal(reads, 2); assert.equal(f.row.phase, 'gating');
  assert.equal(f.calls.includes('absorb'), false);
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
    readMode: () => ({ mode, keyPresent: true }), readConfiguration: () => ({ mode }),
    readRequests: () => [], legacyPresent: () => false, observe: () => [],
    lifecycle: { advanceReclaim: async () => {} }, convert: async () => {},
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
    f.controls.machine = { running: 1, runningWithoutDeadline: 1 };
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
    assert.equal(f.row.phase, 'gating'); assert.equal(f.calls.includes('absorb'), false);
    assert.equal(f.events.some(event => event.event === 'transition_legacy_controls_expired'), false);
  });
}

test('ineligible controls keep one stable blocker without claiming cleanup', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request);
  f.controls.machine = { running: 1, runningWithoutDeadline: 1 };
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
  f.controls.machine = { running: 1, runningWithoutDeadline: 1 };
  await owner.handle({ ...request, target: 'single' }); await owner.advance();
  assert.equal(f.row.reason, 'running_control_without_deadline:machine:4,8');
  assert.equal(f.row.phase, 'gating');
});
