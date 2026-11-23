import test from 'node:test';
import assert from 'node:assert/strict';
import { ModeSwitchCoordinator } from '../mode-switch.js';

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
  const deps = { db, readMode: () => ({ mode, keyPresent: keyPresent || mode !== 'single' }), readConfiguration: () => ({ mode }), requestStore: { read: () => requests, write: rows => { requests = rows; } },
    legacyPresent: () => legacy, observe: () => sourceScenes, lifecycle: { stopForModeSwitch: async () => {}, advanceReclaim: async () => {} },
    writeMode: value => { calls.push('writeMode'); mode = value; },
    restart: { advance: async () => ({ confirmed: true }) }, diagnostic: event => events.push(event), now: () => time,
    ...overrides };
  return { db, deps, events, calls, controls, withoutDeadline, create: () => new ModeSwitchCoordinator(deps), get row() { return row; },
    set keyPresent(value) { keyPresent = value; }, set row(value) { row = value; }, set mode(value) { mode = value; }, set time(value) { time = value; }, set fences(value) { fences = value; }, get fences() { return fences; },
    set scenes(value) { sourceScenes = value; }, set legacy(value) { legacy = value; }, set requests(value) { requests = value; } };
}
const request = { version: 1, type: 'mode_switch', requestId: 'mode-test', target: 'multi' };

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

test('observation errors and failed reads never become empty input', async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); f.scenes = [{ present: true, observationError: error('TMUX_UNAVAILABLE') }];
  await assert.rejects(owner.advance(), { code: 'INVALID_OBSERVATION' }); assert.equal(f.row.phase, 'gating');
  f.scenes = [];
  f.db.listDrainFences = () => { throw error('DB_BUSY'); }; await assert.rejects(owner.advance(), { code: 'DB_BUSY' });
  assert.equal(f.calls.includes('cutover'), false);
});

for (const phase of ['before_rename', 'after_rename']) test(`config ${phase} failure keeps gate and recovers forward`, async () => {
  const f = fixture(), owner = f.create(); await owner.handle(request); await owner.advance();
  owner.writeMode = () => { if (phase === 'after_rename') f.mode = 'multi'; throw Object.assign(error('CONFIG_WRITE_FAILED'), { phase }); };
  await owner.advance(); assert.equal(f.row.reason, 'config_write_failed:CONFIG_WRITE_FAILED'); assert.equal(f.row.phase, 'cutover'); assert.equal(f.fences.length, 1);
  owner.writeMode = value => { f.mode = value; }; await owner.advance(); assert.equal(f.row.phase, 'complete');
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

