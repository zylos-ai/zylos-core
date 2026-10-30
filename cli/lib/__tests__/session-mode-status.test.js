import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readSessionModeStatus, probeSupervisor, formatSessionModeStatus } from '../session-mode-status.js';

const row = { run_id: 'switch-a', source_mode: 'single', target_mode: 'multi', phase: 'gating', cutoff: null,
  reason: 'running_control_without_deadline:machine:17', created_at: 100, updated_at: 102 };
const defaults = overrides => ({
  db: { getModeTransition: () => row, getDrainFence: group => { assert.equal(group, '*'); return { reason: null, runId: null }; }, getLastCompletedModeTransition: () => null },
  readMode: () => ({ mode: 'single', keyPresent: true }), readEvents: () => [], probeSupervisor: () => true,
  readPm2: () => { throw new Error('reachable socket must not query PM2'); }, ...overrides,
});

test('status maps only authoritative transition/gate fields and does not submit requests', async () => {
  const status = await readSessionModeStatus(defaults());
  assert.deepEqual(status, {
    sessionMode: 'single', transition: { runId: 'switch-a', sourceMode: 'single', targetMode: 'multi', phase: 'gating', cutoff: null,
      reason: row.reason, createdAt: 100, updatedAt: 102 },
    globalGate: { present: true, reason: null, runId: null }, blocked: { reason: row.reason, since: null },
    lastEvents: [], supervisor: 'reachable', lastCompleted: null,
  });
});

for (const method of ['getModeTransition', 'getDrainFence', 'getLastCompletedModeTransition']) {
  test(`${method} failures propagate instead of becoming absent`, async () => {
    const input = defaults(); const failure = Object.assign(new Error('held database'), { code: 'DB_BUSY', persisted: [] });
    input.db[method] = () => { throw failure; };
    input.probeSupervisor = () => { throw new Error('must stop before observations'); };
    await assert.rejects(readSessionModeStatus(input), error => error === failure);
  });
}

test('missing config and unreadable config differ without changing', async () => {
  const missing = await readSessionModeStatus(defaults({ readMode: () => ({ mode: null, keyPresent: false }) }));
  const unreadable = await readSessionModeStatus(defaults({ readMode: () => { throw new Error('invalid config'); } }));
  assert.equal(missing.sessionMode, null); assert.equal(unreadable.sessionMode, 'unreadable');
  assert.deepEqual(missing.transition, unreadable.transition);
});

test('diagnostics use only the current run, first matching reason and latest ten allowed events', async () => {
  const events = [
    { run_id: 'other', event: 'transition_blocked', reason: row.reason, ts: 1 },
    { run_id: row.run_id, event: 'unrelated', reason: row.reason, ts: 2 },
    { run_id: row.run_id, event: 'transition_blocked', reason: row.reason, ts: 3 },
    ...Array.from({ length: 12 }, (_, i) => ({ run_id: row.run_id, event: i % 2 ? 'absorb' : 'auto_migration_begin', ts: 10 + i })),
    { run_id: row.run_id, event: 'transition_blocked', reason: row.reason, ts: 30 },
  ];
  const status = await readSessionModeStatus(defaults({ readEvents: () => events }));
  assert.equal(status.blocked.since, 3); assert.deepEqual(status.lastEvents, events.slice(-10));
  assert.equal(status.lastEvents.length, 10);
});

test('E diagnostic loss cannot change authoritative state or socket observation', async () => {
  const input = defaults({ readEvents: () => [{ run_id: row.run_id, reason: row.reason, event: 'transition_blocked', ts: 3 }] });
  const before = await readSessionModeStatus(input);
  const after = await readSessionModeStatus({ ...input, readEvents: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  assert.deepEqual(after, { ...before, blocked: { reason: row.reason, since: null }, lastEvents: [] });
});

test('stopped supervisor preserves state with explicit PM2 status or observation failure', async () => {
  const stopped = await readSessionModeStatus(defaults({ probeSupervisor: () => false, readPm2: () => 'stopped' }));
  assert.equal(stopped.supervisor, 'unreachable'); assert.deepEqual(stopped.supervisorPm2, { status: 'stopped', error: null });
  const unknown = await readSessionModeStatus(defaults({ probeSupervisor: () => false,
    readPm2: () => { throw Object.assign(new Error('pm2 absent'), { code: 'ENOENT' }); } }));
  assert.deepEqual(unknown.supervisorPm2, { status: 'unobservable', error: { code: 'ENOENT', message: 'pm2 absent' } });
  assert.deepEqual(stopped.transition, unknown.transition);
  assert.match(formatSessionModeStatus(unknown), /PM2 activity-monitor: unobservable/);
});

test('no open transition reads latest completed row and never infers blocked from logs', async () => {
  const input = defaults(); input.db.getModeTransition = () => null; input.db.getDrainFence = () => null;
  input.db.getLastCompletedModeTransition = () => ({ ...row, phase: 'complete', updated_at: 110 });
  input.readEvents = () => [{ run_id: row.run_id, event: 'transition_blocked', reason: 'stale', ts: 100 }];
  const status = await readSessionModeStatus(input);
  assert.equal(status.transition, null); assert.equal(status.blocked, null);
  assert.deepEqual(status.globalGate, { present: false, reason: null, runId: null });
  assert.deepEqual(status.lastCompleted, { runId: row.run_id, sourceMode: 'single', targetMode: 'multi', updatedAt: 110 });
  assert.match(formatSessionModeStatus(status), /Last completed: switch-a/);
});

for (const outcome of ['connect', 'error', 'timeout']) test(`one socket connection with no bytes, ${outcome}`, async () => {
  let calls = 0; let destroyed = 0;
  const socket = new EventEmitter(); socket.destroy = () => destroyed++;
  socket.write = () => assert.fail('status may not send a request');
  const result = await probeSupervisor('/test/am.sock', { timeoutMs: 10, connect: target => {
    calls++; assert.equal(target, '/test/am.sock');
    if (outcome !== 'timeout') queueMicrotask(() => socket.emit(outcome, new Error('refused')));
    return socket;
  } });
  assert.equal(result, outcome === 'connect'); assert.equal(calls, 1); assert.equal(destroyed, 1);
});

test('an unfinished gating transition with NULL reason is not blocked, including after unblocking', async () => {
  const input = defaults(); let reason = null;
  input.db.getModeTransition = () => ({ ...row, reason });
  input.readEvents = () => [{ run_id: row.run_id, event: 'transition_blocked', reason: row.reason, ts: 10 }];
  const gating = await readSessionModeStatus(input);
  assert.equal(gating.transition.phase, 'gating'); assert.equal(gating.transition.reason, null); assert.equal(gating.blocked, null);
  reason = row.reason; assert.equal((await readSessionModeStatus(input)).blocked.reason, row.reason);
  reason = null;
  const unblocked = await readSessionModeStatus(input);
  assert.equal(unblocked.transition.runId, row.run_id); assert.equal(unblocked.transition.phase, 'gating'); assert.equal(unblocked.blocked, null);
});

test('a global manual_restart fence is present independently of any mode transition', async () => {
  const input = defaults(); input.db.getModeTransition = () => null;
  input.db.getDrainFence = group => { assert.equal(group, '*'); return { reason: 'manual_restart', runId: 'restart-run' }; };
  const status = await readSessionModeStatus(input);
  assert.deepEqual(status.globalGate, { present: true, reason: 'manual_restart', runId: 'restart-run' });
  assert.equal(status.transition, null); assert.equal(status.blocked, null);
});
