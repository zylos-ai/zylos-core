import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskScheduler } from '../task-scheduler.js';

function createScheduler(tasks, overrides = {}) {
  const calls = { log: [] };
  const scheduler = new TaskScheduler(tasks, {
    getLocalHour: () => overrides.hour ?? 5,
    getLocalDate: () => overrides.date ?? '2026-04-30',
    nowEpoch: () => overrides.now ?? 1000,
    log: (message) => calls.log.push(message)
  });
  return { scheduler, calls };
}

describe('TaskScheduler', () => {
  it('runs an eligible daily task once and writes the date', () => {
    const writes = [];
    let runs = 0;
    const { scheduler } = createScheduler([{
      id: 'daily-test',
      type: 'daily',
      hour: 5,
      loadState: () => null,
      writeState: (date) => writes.push(date),
      execute: () => { runs++; return true; }
    }]);

    assert.equal(scheduler.tick({}), 1);
    assert.equal(runs, 1);
    assert.deepEqual(writes, ['2026-04-30']);
  });

  it('skips daily tasks outside their target hour or already run date', () => {
    let runs = 0;
    const { scheduler } = createScheduler([
      {
        id: 'wrong-hour',
        type: 'daily',
        hour: 3,
        execute: () => { runs++; return true; }
      },
      {
        id: 'already-run',
        type: 'daily',
        hour: 5,
        loadState: () => ({ last_date: '2026-04-30' }),
        execute: () => { runs++; return true; }
      }
    ]);

    assert.equal(scheduler.tick({}), 0);
    assert.equal(runs, 0);
  });

  it('does not persist daily state when execute returns false', () => {
    const writes = [];
    const { scheduler } = createScheduler([{
      id: 'daily-false',
      type: 'daily',
      hour: 5,
      writeState: (date) => writes.push(date),
      execute: () => false
    }]);

    assert.equal(scheduler.tick({}), 0);
    assert.deepEqual(writes, []);
  });

  it('runs interval tasks after the configured delay', () => {
    let runs = 0;
    const writes = [];
    const { scheduler } = createScheduler([{
      id: 'interval-test',
      type: 'interval',
      intervalSec: 60,
      getLastRunAt: () => 900,
      writeState: (now) => writes.push(now),
      execute: ({ currentTime }) => {
        runs++;
        assert.equal(currentTime, 1000);
        return true;
      }
    }], { now: 1000 });

    assert.equal(scheduler.tick({}), 1);
    assert.equal(runs, 1);
    assert.deepEqual(writes, [1000]);
  });

  it('applies enabled and gate predicates before running tasks', () => {
    let runs = 0;
    const { scheduler } = createScheduler([{
      id: 'gated',
      type: 'interval',
      intervalSec: 1,
      enabled: () => true,
      gate: (snapshot) => snapshot.health === 'ok',
      execute: () => { runs++; return true; }
    }]);

    assert.equal(scheduler.tick({ health: 'unavailable' }), 0);
    assert.equal(scheduler.tick({ health: 'ok' }), 1);
    assert.equal(runs, 1);
  });

  it('skips interval task when enabled returns false', () => {
    let runs = 0;
    const { scheduler } = createScheduler([{
      id: 'disabled-interval',
      type: 'interval',
      intervalSec: 1,
      enabled: () => false,
      gate: (snapshot) => snapshot.agentRunning === true && snapshot.health === 'ok',
      getLastRunAt: () => 0,
      execute: () => { runs++; return true; }
    }], { now: 1000 });

    assert.equal(scheduler.tick({ agentRunning: true, health: 'ok' }), 0);
    assert.equal(runs, 0);
  });

  it('runs interval task when enabled is undefined (default)', () => {
    let runs = 0;
    const { scheduler } = createScheduler([{
      id: 'default-enabled',
      type: 'interval',
      intervalSec: 1,
      getLastRunAt: () => 0,
      execute: () => { runs++; return true; }
    }], { now: 1000 });

    assert.equal(scheduler.tick({}), 1);
    assert.equal(runs, 1);
  });

  it('runs interval task when enabled returns true', () => {
    let runs = 0;
    const { scheduler } = createScheduler([{
      id: 'enabled-interval',
      type: 'interval',
      intervalSec: 1,
      enabled: () => true,
      getLastRunAt: () => 0,
      execute: () => { runs++; return true; }
    }], { now: 1000 });

    assert.equal(scheduler.tick({}), 1);
    assert.equal(runs, 1);
  });
});
