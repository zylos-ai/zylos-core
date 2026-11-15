import test from 'node:test';
import assert from 'node:assert/strict';
import { readGroupSnapshot, instanceActionRequest } from '../public/js/wb/group-data.js';
import { statePill, renderDistribution, modelCell } from '../public/js/wb/board.js';
import { createDocument } from './fixtures/workbench-dom.js';

// Pure page modules and injected reads/DOM: no process, database, network or source evaluation.
test('group page requests running rows and counts separately without fetching offline rows', async () => {
  const paths = [], instance = { default_runtime: 'codex', accounts: {}, system: {} };
  const counts = { readAt: 123, mode: 'multi', running: { total: 1, states: { working: 1 } }, offline: { total: 50 }, pool: { used: 1, capacity: 3 } };
  const row = { sessionGroup: 'example', state: { kind: 'working' }, flags: { queued: { count: 3 } } };
  const snapshot = await readGroupSnapshot(async path => { paths.push(path); return path === '/api/instance' ? instance : path === '/api/groups/counts' ? counts : { readAt: 123, rows: [row] }; });
  assert.deepEqual(paths.sort(), ['/api/groups/counts', '/api/groups/running', '/api/instance']);
  assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.rows[0], row);
  assert.equal(snapshot.groupCounts.offline.total, 50); assert.equal(snapshot.instance.pool, counts.pool);
});
test('offline page keeps its returned cursor and does not request running rows', async () => {
  const paths = [];
  const snapshot = await readGroupSnapshot(async path => { paths.push(path); return path === '/api/instance' ? {} : path === '/api/groups/counts' ? { mode: 'multi' } : { rows: [], nextCursor: 'later' }; }, { side: 'offline', cursor: 'earlier' });
  assert.equal(paths.includes('/api/groups/offline?cursor=earlier'), true);
  assert.equal(paths.includes('/api/groups/running'), false);
  assert.equal(snapshot.nextCursor, 'later'); assert.equal(snapshot.hasOlder, true);
});
test('working primary state and queued blocked flags are displayed together without main-agent state', () => {
  const document = createDocument();
  const pill = statePill(document, { state: { kind: 'working' }, mainAgent: 'idle', flags: { queued: { count: 3 }, blocked: { reason: 'rate_limited' } } });
  assert.match(pill.textContent, /wb.state.working/); assert.match(pill.textContent, /wb.flags.queued/); assert.match(pill.textContent, /wb.flags.blocked/);
  assert.equal(pill.textContent.includes('idle'), false);
});
test('instance defaults and actions target their owning resource with the prescribed method', () => {
  assert.deepEqual(instanceActionRequest('switch-model', { runtime: 'codex', model: 'example' }), { method: 'PUT', path: '/api/instance/defaults', body: { runtime: 'codex', model: 'example', kind: 'model' } });
  assert.equal(instanceActionRequest('restart-session').path, '/api/groups/origin/actions/restart');
  assert.equal(instanceActionRequest('upgrade-cc').path, '/api/instance/actions/upgrade-runtime');
  assert.throws(() => instanceActionRequest('made-up'), /unknown_action/);
});

test('a default launch displays the validated actual model from its group row', () => {
  assert.equal(modelCell({ presence: 'running', model: 'actual-model', launchConfig: { runtime: 'codex', mode: 'default' } }), 'Codex · actual-model');
});
test('refreshing an offline list rereads the loaded page depth and retains later rows', async () => {
  let generation = 0; const calls = [];
  const read = async path => {
    calls.push(path);
    if (path === '/api/instance') return {};
    if (path === '/api/groups/counts') return { mode: 'multi', listKnown: true };
    return path.includes('cursor=second') ? { rows: [{ sessionGroup: 'second' }], nextCursor: null }
      : { listKnown: true, rows: [{ sessionGroup: 'first', name: { displayName: String(generation) } }], nextCursor: 'second' };
  };
  const first = await readGroupSnapshot(read, { side: 'offline', pages: 2 });
  generation++;
  const refreshed = await readGroupSnapshot(read, { side: 'offline', pages: 2 });
  assert.equal(first.rows.length, 2); assert.equal(refreshed.rows.length, 2);
  assert.equal(refreshed.rows[0].name.displayName, '1'); assert.equal(refreshed.rows[1].sessionGroup, 'second');
  assert.equal(calls.filter(path => path.includes('cursor=second')).length, 2);
});

test('pushed counts and the current instance refresh only the group rows', async () => {
  const paths = [], counts = { mode: 'multi', running: { total: 1 }, offline: { total: 500 }, pool: { used: 1, capacity: 4 } };
  const instance = { default_runtime: 'codex', poolCapacityRecord: { source: 'configured' } };
  const row = { sessionGroup: 'a', state: { kind: 'working' } };
  const snapshot = await readGroupSnapshot(async path => { paths.push(path); return { rows: [row] }; }, { counts, instance });
  assert.deepEqual(paths, ['/api/groups/running']);
  assert.equal(snapshot.groupCounts, counts);
  assert.equal(snapshot.rows[0], row);
  assert.equal(snapshot.instance.pool.capacityRecord, instance.poolCapacityRecord);
});
