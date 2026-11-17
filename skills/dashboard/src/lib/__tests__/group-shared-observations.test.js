import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroupSnapshot } from '../workbench/group-snapshot.js';
import { collectStatus } from '../../../../../cli/lib/status-view.js';

const item = runtime => ({ identity: { present: true, ready: true, runtime, runId: runtime, sessionId: runtime },
  status: { valid: true, value: { state: 'idle' }, reason: null },
  usage: { valid: true, value: { context_window: { used_percentage: 47 } } } });

test('fleet projects each shared observation without per-group session reads and broadcast uses cached observations', async () => {
  let reads = 0, observed = null;
  const observationOptions = [];
  const batch = { mode: 'multi', observations: new Map([['origin', item('claude')], ['other', item('codex')]]) };
  const provider = {
    get: async options => { reads++; observationOptions.push(options); return observed = batch; }, peek: () => observed,
    reader: { readRuntimeHealth: () => ({ missing: true }), readAccountUsage: async () => null },
  };
  const modules = {
    'config.js': { readSessionMode: () => ({ mode: 'multi' }) },
    'status-view.js': { collectStatus: options => collectStatus({ ...options,
      configIssue: () => null, resolveRoot: () => {}, requests: async () => {}, facts: async () => ({ originNeed: null }) }) },
  };
  const workbench = createGroupSnapshot({ zylosDir: process.env.ZYLOS_DIR,
    sessionObservations: provider, loadCoreModule: async name => {
      if (!(name in modules)) throw new Error('Optional unavailable module');
      return modules[name];
    },
    store: { queryEvents: () => [], latestEventByType: () => null },
    c4Reader: { listSlotOccupancy: () => [] },
    cli: { runC4Db: async args => ({ ok: true, data: args[0] === 'groups' ? [] : { groups: [] } }),
      readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) },
  });
  const live = await workbench.getSnapshot();
  assert.equal(reads, 1);
  assert.equal(live.sources.status.ok, true);
  assert.equal(live.rows.length, 2);
  assert.equal(live.rows.find(row => row.sessionGroup === 'other').contextPct, 47);
  const broadcast = await workbench.getSnapshot(undefined, { fresh: true, cachedObservations: true });
  assert.equal(reads, 1, 'broadcast projects the timer batch without observing again');
  assert.equal(workbench.getCachedSnapshot(), broadcast);
  await workbench.getSnapshot(undefined, { fresh: true });
  assert.equal(reads, 2, 'lifecycle requests observe again even within the projection cache TTL');
  assert.deepEqual(observationOptions, [{ fresh: false }, { fresh: true }]);
});
