import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSessionModeStatus, probeSupervisor, formatSessionModeStatus } from '../session-mode-status.js';

const row = { run_id: 'switch-a', kind: 'switch', source_mode: 'single', target_mode: 'multi', phase: 'gating', cutoff: null,
  reason: 'running_control_without_deadline:machine:17', created_at: 100, updated_at: 102 };
const defaults = overrides => ({
  db: { getModeTransition: () => row, getDrainFence: group => { assert.equal(group, '*'); return { reason: null, runId: null }; }, getLastCompletedModeTransition: () => null },
  readMode: () => ({ mode: 'single', keyPresent: true }), readEvents: () => [], probeSupervisor: () => true,
  readPm2: () => { throw new Error('reachable socket must not query PM2'); }, ...overrides,
});

// Private temporary diagnostics only, with injected authoritative DB/socket/PM2.
// Run when status diagnostics caching or rotation changes; skip UI-only changes.
test('unchanged diagnostics avoid log reads while append, replacement, rotation and run changes stay visible', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-status-events-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const directory = path.join(root, 'activity-monitor'); fs.mkdirSync(directory);
  const file = path.join(directory, 'supervisor-events.jsonl');
  const event = (ts, run = row.run_id) => JSON.stringify({ run_id: run, event: 'transition_blocked', reason: row.reason, ts }) + '\n';
  fs.writeFileSync(file, event(3));
  const input = defaults({ zylosDir: root }); delete input.readEvents;
  let reads = 0; const read = fs.readSync;
  t.mock.method(fs, 'readSync', (...args) => { reads++; return read(...args); });
  assert.equal((await readSessionModeStatus(input)).blocked.since, 3);
  const initialReads = reads; assert.ok(initialReads > 0);
  assert.equal((await readSessionModeStatus(input)).lastEvents[0].ts, 3);
  assert.equal(reads, initialReads, 'unchanged metadata does not parse the log again');
  fs.appendFileSync(file, event(4));
  assert.deepEqual((await readSessionModeStatus(input)).lastEvents.map(item => item.ts), [3, 4]);
  fs.renameSync(file, path.join(directory, 'supervisor-events.100.jsonl'));
  fs.writeFileSync(file, event(5));
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  assert.deepEqual((await readSessionModeStatus(input)).lastEvents.map(item => item.ts), [3, 4, 5]);
  const beforeRewrite = fs.statSync(file);
  fs.writeFileSync(file, event(600));
  fs.utimesSync(file, beforeRewrite.atime, beforeRewrite.mtime);
  const afterRewrite = fs.statSync(file);
  assert.notEqual(afterRewrite.size, beforeRewrite.size);
  assert.equal(afterRewrite.mtimeMs, beforeRewrite.mtimeMs);
  assert.deepEqual((await readSessionModeStatus(input)).lastEvents.map(item => item.ts), [3, 4, 600]);
  fs.appendFileSync(file, event(61));
  assert.equal((await readSessionModeStatus(input)).lastEvents.at(-1).ts, 61);
  fs.writeFileSync(file, event(6));
  assert.deepEqual((await readSessionModeStatus(input)).lastEvents.map(item => item.ts), [3, 4, 6], 'truncation invalidates the cached view');
  fs.unlinkSync(path.join(directory, 'supervisor-events.100.jsonl'));
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  assert.equal((await readSessionModeStatus(input)).blocked.since, 6);
  const beforeReplacement = fs.statSync(file, { bigint: true });
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, event(7));
  fs.utimesSync(replacement, 1_700_000_000, 1_700_000_000);
  fs.renameSync(replacement, file);
  const afterReplacement = fs.statSync(file, { bigint: true });
  assert.equal(afterReplacement.size, beforeReplacement.size);
  assert.equal(afterReplacement.mtimeNs, beforeReplacement.mtimeNs);
  assert.notEqual(afterReplacement.ino, beforeReplacement.ino);
  const replacementReads = reads;
  assert.equal((await readSessionModeStatus(input)).blocked.since, 7);
  assert.ok(reads > replacementReads, 'same-size replacement with restored mtime is read again');
  // Populate the next run before warming the current run cache. Nothing is
  // written between switching runs and observing its already-existing events.
  fs.appendFileSync(file, event(8, 'switch-b'));
  assert.deepEqual((await readSessionModeStatus(input)).lastEvents.map(item => item.ts), [7]);
  const beforeSwitch = fs.statSync(file, { bigint: true });
  const switchReads = reads;
  input.db.getModeTransition = () => ({ ...row, run_id: 'switch-b' });
  const switched = await readSessionModeStatus(input);
  assert.equal(switched.blocked.since, 8);
  assert.deepEqual(switched.lastEvents.map(item => item.ts), [8]);
  assert.ok(reads > switchReads, 'run-key change rereads an unchanged file');
  const afterSwitch = fs.statSync(file, { bigint: true });
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    assert.equal(afterSwitch[key], beforeSwitch[key], `${key} stays unchanged across the run switch`);
  }
  fs.unlinkSync(file);
  assert.deepEqual((await readSessionModeStatus(input)).lastEvents, []);
  fs.writeFileSync(file, event(9, 'switch-b'));
  assert.equal((await readSessionModeStatus(input)).blocked.since, 9);
});

test('status maps only authoritative transition/gate fields and does not submit requests', async () => {
  const status = await readSessionModeStatus(defaults());
  assert.deepEqual(status, {
    sessionMode: 'single', transition: { runId: 'switch-a', kind: 'switch', sourceMode: 'single', targetMode: 'multi', phase: 'gating', cutoff: null,
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
  assert.deepEqual(status.lastCompleted, { runId: row.run_id, kind: 'switch', sourceMode: 'single', targetMode: 'multi', updatedAt: 110 });
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

test('cancellation never replaces last completed transition with diagnostics', async () => {
  const input = defaults(); input.db.getModeTransition = () => null;
  input.db.getLastCompletedModeTransition = () => ({ ...row, kind: 'first_migration', phase: 'complete' });
  const cancelled = { run_id: 'later-cancel', event: 'transition_cancelled', ts: 101000 };
  input.readEvents = () => [cancelled];
  const status = await readSessionModeStatus(input);
  assert.equal(status.lastCompleted.runId, row.run_id); assert.equal(status.lastCompleted.kind, 'first_migration');
  assert.deepEqual(status.lastEvents, [cancelled]);
});
test('without an open transition status shows latest ten permitted events across runs and handovers', async () => {
  const input = defaults(); input.db.getModeTransition = () => null; input.db.getLastCompletedModeTransition = () => null;
  const events = Array.from({ length: 15 }, (_, i) => ({ run_id: `run-${i}`, event: i % 2 ? 'global_memory_handover' : 'global_memory_handover_failed', ts: i }));
  input.readEvents = () => [...events, { event: 'unrelated' }];
  const status = await readSessionModeStatus(input);
  assert.deepEqual(status.lastEvents, events.slice(-10)); assert.equal(status.transition, null);
});
test('open status keeps current switch events and subsequent handovers using seconds to milliseconds', async () => {
  const input = defaults();
  const current = { run_id: row.run_id, event: 'transition_blocked', reason: row.reason, ts: 100001 };
  const handover = { run_id: 'gm-1', event: 'global_memory_handover', ts: 100000 };
  const failed = { run_id: 'gm-2', event: 'global_memory_handover_failed', reason: row.reason, ts: 100002 };
  input.readEvents = () => [
    { run_id: 'old', event: 'transition_cancelled', ts: 100003 },
    { run_id: 'gm-old', event: 'global_memory_handover', ts: 99999 },
    { run_id: 'gm-no-time', event: 'global_memory_handover' }, handover, current, failed,
  ];
  const status = await readSessionModeStatus(input);
  assert.equal(status.transition.kind, 'switch'); assert.equal(status.blocked.since, current.ts);
  assert.deepEqual(status.lastEvents, [handover, current, failed]);
});
test('real retained diagnostics expose cancellation and handover when no mode transition is open', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-status-terminal-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const directory = path.join(root, 'activity-monitor'); fs.mkdirSync(directory);
  const events = [{ run_id: 'cancelled-run', event: 'transition_cancelled', ts: 100001 },
    { run_id: 'gm-1', event: 'global_memory_handover', ts: 100002 }];
  fs.writeFileSync(path.join(directory, 'supervisor-events.jsonl'), events.map(event => JSON.stringify(event) + '\n').join(''));
  const input = defaults({ zylosDir: root }); delete input.readEvents;
  input.db.getModeTransition = () => null; input.db.getLastCompletedModeTransition = () => null;
  assert.deepEqual((await readSessionModeStatus(input)).lastEvents, events);
});

test('plain status shows cancellation and handover events while authoritative transition stays absent', async () => {
  const input = defaults(); input.db.getModeTransition = () => null; input.db.getLastCompletedModeTransition = () => null;
  input.readEvents = () => [{ event: 'transition_cancelled', run_id: 'cancel-1' },
    { event: 'global_memory_handover', run_id: 'gm-1' }, { event: 'global_memory_handover_failed', run_id: 'gm-2' }];
  const status = await readSessionModeStatus(input), text = formatSessionModeStatus(status);
  assert.equal(status.transition, null); assert.equal(status.lastCompleted, null);
  assert.match(text, /Transition: none/);
  assert.match(text, /transition_cancelled \(cancel-1\)/);
  assert.match(text, /global_memory_handover \(gm-1\)/);
  assert.match(text, /global_memory_handover_failed \(gm-2\)/);
});
