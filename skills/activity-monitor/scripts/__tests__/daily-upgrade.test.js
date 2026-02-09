import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DailyUpgradeScheduler } from '../daily-upgrade.js';

function createMockDeps(overrides = {}) {
  const calls = {
    enqueue: 0,
    writeState: [],
    log: []
  };

  const deps = {
    getLocalHour: () => overrides.hour ?? 5,
    getLocalDate: () => overrides.date ?? '2026-02-10',
    loadState: () => overrides.state ?? null,
    writeState: (date) => { calls.writeState.push(date); },
    enqueue: () => { calls.enqueue++; return overrides.enqueueResult ?? true; },
    log: (msg) => { calls.log.push(msg); }
  };

  return { deps, calls };
}

describe('DailyUpgradeScheduler', () => {
  describe('maybeEnqueue', () => {
    it('enqueues when hour matches and no previous upgrade today', () => {
      const { deps, calls } = createMockDeps({ hour: 5, date: '2026-02-10' });
      const scheduler = new DailyUpgradeScheduler(deps, { upgradeHour: 5 });

      const result = scheduler.maybeEnqueue(true, 'ok');

      assert.equal(result, true);
      assert.equal(calls.enqueue, 1);
      assert.deepStrictEqual(calls.writeState, ['2026-02-10']);
      assert.equal(calls.log.length, 1);
    });

    it('skips when claude is not running', () => {
      const { deps, calls } = createMockDeps({ hour: 5 });
      const scheduler = new DailyUpgradeScheduler(deps);

      const result = scheduler.maybeEnqueue(false, 'ok');

      assert.equal(result, false);
      assert.equal(calls.enqueue, 0);
    });

    it('skips when health is not ok', () => {
      const { deps, calls } = createMockDeps({ hour: 5 });
      const scheduler = new DailyUpgradeScheduler(deps);

      assert.equal(scheduler.maybeEnqueue(true, 'recovering'), false);
      assert.equal(scheduler.maybeEnqueue(true, 'down'), false);
      assert.equal(calls.enqueue, 0);
    });

    it('skips when hour does not match', () => {
      const { deps, calls } = createMockDeps({ hour: 10 });
      const scheduler = new DailyUpgradeScheduler(deps, { upgradeHour: 5 });

      const result = scheduler.maybeEnqueue(true, 'ok');

      assert.equal(result, false);
      assert.equal(calls.enqueue, 0);
    });

    it('skips when already upgraded today', () => {
      const { deps, calls } = createMockDeps({
        hour: 5,
        date: '2026-02-10',
        state: { last_upgrade_date: '2026-02-10' }
      });
      const scheduler = new DailyUpgradeScheduler(deps, { upgradeHour: 5 });

      const result = scheduler.maybeEnqueue(true, 'ok');

      assert.equal(result, false);
      assert.equal(calls.enqueue, 0);
    });

    it('enqueues on new day even if upgraded yesterday', () => {
      const { deps, calls } = createMockDeps({
        hour: 5,
        date: '2026-02-11',
        state: { last_upgrade_date: '2026-02-10' }
      });
      const scheduler = new DailyUpgradeScheduler(deps, { upgradeHour: 5 });

      const result = scheduler.maybeEnqueue(true, 'ok');

      assert.equal(result, true);
      assert.equal(calls.enqueue, 1);
      assert.deepStrictEqual(calls.writeState, ['2026-02-11']);
    });

    it('does not write state when enqueue fails', () => {
      const { deps, calls } = createMockDeps({
        hour: 5,
        date: '2026-02-10',
        enqueueResult: false
      });
      const scheduler = new DailyUpgradeScheduler(deps, { upgradeHour: 5 });

      const result = scheduler.maybeEnqueue(true, 'ok');

      assert.equal(result, false);
      assert.equal(calls.enqueue, 1);
      assert.deepStrictEqual(calls.writeState, []);
    });

    it('respects custom upgradeHour', () => {
      const { deps, calls } = createMockDeps({ hour: 3 });
      const scheduler = new DailyUpgradeScheduler(deps, { upgradeHour: 3 });

      const result = scheduler.maybeEnqueue(true, 'ok');

      assert.equal(result, true);
      assert.equal(calls.enqueue, 1);
    });

    it('defaults upgradeHour to 5', () => {
      const { deps, calls } = createMockDeps({ hour: 5 });
      const scheduler = new DailyUpgradeScheduler(deps);

      const result = scheduler.maybeEnqueue(true, 'ok');

      assert.equal(result, true);
      assert.equal(calls.enqueue, 1);
    });

    it('enqueues when state file is null (first run)', () => {
      const { deps, calls } = createMockDeps({
        hour: 5,
        date: '2026-02-10',
        state: null
      });
      const scheduler = new DailyUpgradeScheduler(deps, { upgradeHour: 5 });

      const result = scheduler.maybeEnqueue(true, 'ok');

      assert.equal(result, true);
      assert.equal(calls.enqueue, 1);
    });
  });
});
