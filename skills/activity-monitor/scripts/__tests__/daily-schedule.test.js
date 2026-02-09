import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DailySchedule } from '../daily-schedule.js';

function createMockDeps(overrides = {}) {
  const calls = {
    execute: 0,
    writeState: [],
    log: []
  };

  const deps = {
    getLocalHour: () => overrides.hour ?? 5,
    getLocalDate: () => overrides.date ?? '2026-02-10',
    loadState: () => overrides.state ?? null,
    writeState: (date) => { calls.writeState.push(date); },
    execute: () => { calls.execute++; return overrides.executeResult ?? true; },
    log: (msg) => { calls.log.push(msg); }
  };

  return { deps, calls };
}

describe('DailySchedule', () => {
  it('triggers when hour matches and no previous run today', () => {
    const { deps, calls } = createMockDeps({ hour: 5, date: '2026-02-10' });
    const sched = new DailySchedule(deps, { hour: 5, name: 'test' });

    assert.equal(sched.maybeTrigger(), true);
    assert.equal(calls.execute, 1);
    assert.deepStrictEqual(calls.writeState, ['2026-02-10']);
    assert.equal(calls.log.length, 1);
    assert.ok(calls.log[0].includes('test'));
  });

  it('skips when hour does not match', () => {
    const { deps, calls } = createMockDeps({ hour: 10 });
    const sched = new DailySchedule(deps, { hour: 5 });

    assert.equal(sched.maybeTrigger(), false);
    assert.equal(calls.execute, 0);
  });

  it('skips when already executed today', () => {
    const { deps, calls } = createMockDeps({
      hour: 5,
      date: '2026-02-10',
      state: { last_date: '2026-02-10' }
    });
    const sched = new DailySchedule(deps, { hour: 5 });

    assert.equal(sched.maybeTrigger(), false);
    assert.equal(calls.execute, 0);
  });

  it('triggers on new day even if ran yesterday', () => {
    const { deps, calls } = createMockDeps({
      hour: 5,
      date: '2026-02-11',
      state: { last_date: '2026-02-10' }
    });
    const sched = new DailySchedule(deps, { hour: 5 });

    assert.equal(sched.maybeTrigger(), true);
    assert.equal(calls.execute, 1);
    assert.deepStrictEqual(calls.writeState, ['2026-02-11']);
  });

  it('does not write state when execute fails', () => {
    const { deps, calls } = createMockDeps({
      hour: 5,
      executeResult: false
    });
    const sched = new DailySchedule(deps, { hour: 5 });

    assert.equal(sched.maybeTrigger(), false);
    assert.equal(calls.execute, 1);
    assert.deepStrictEqual(calls.writeState, []);
  });

  it('triggers on first run (null state)', () => {
    const { deps, calls } = createMockDeps({
      hour: 3,
      date: '2026-02-10',
      state: null
    });
    const sched = new DailySchedule(deps, { hour: 3 });

    assert.equal(sched.maybeTrigger(), true);
    assert.equal(calls.execute, 1);
  });

  it('uses custom hour', () => {
    const { deps, calls } = createMockDeps({ hour: 22 });
    const sched = new DailySchedule(deps, { hour: 22 });

    assert.equal(sched.maybeTrigger(), true);
    assert.equal(calls.execute, 1);
  });

  it('does not re-trigger on consecutive calls within same hour', () => {
    let state = null;
    const deps = {
      getLocalHour: () => 5,
      getLocalDate: () => '2026-02-10',
      loadState: () => state,
      writeState: (date) => { state = { last_date: date }; },
      execute: () => true,
      log: () => {}
    };
    const sched = new DailySchedule(deps, { hour: 5 });

    assert.equal(sched.maybeTrigger(), true);  // first call triggers
    assert.equal(sched.maybeTrigger(), false); // second call skipped (same date)
    assert.equal(sched.maybeTrigger(), false); // third call also skipped
  });

  it('works without log function', () => {
    const { deps, calls } = createMockDeps({ hour: 5 });
    delete deps.log;
    const sched = new DailySchedule(deps, { hour: 5 });

    assert.equal(sched.maybeTrigger(), true);
    assert.equal(calls.execute, 1);
  });
});
