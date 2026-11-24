import { loadRuntimeContexts } from '../../../../cli/lib/model-rotation-thresholds.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runtimes from '../../../../cli/lib/runtime/index.js';
import { UNSUPPORTED } from '../../../../cli/lib/runtime/contract.js';
import { fixture as databaseFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT,
  PRE_RECLAIM_SYNC_PROMPT, PRE_RECLAIM_ORIGIN_SYNC_PROMPT } from '../../../zylos-memory/scripts/sync-prompts.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../reclaim-prompts.js';
import { groupMemoryDir } from '../../../../cli/lib/session-group-paths.js';
import { renderStateSkeleton } from '../../../zylos-memory/scripts/state-format.js';

const contexts = await loadRuntimeContexts();

// Supply a synthetic adapter for the optional capability. All supported IDs
// still resolve through the real registry and load their runtime adapters.
const runtimeWithoutPrompt = 'without-group-sync';
const findRuntime = mock.fn(async id => id === runtimeWithoutPrompt
  ? { instructions: { groupSyncPrompt: UNSUPPORTED } }
  : runtimes.findRuntime(id));
const registry = mock.module('../../../../cli/lib/runtime/index.js', {
  namedExports: { ...runtimes, findRuntime },
});
const { SupervisorLifecycle } = await import('../supervisor-lifecycle.js');
registry.restore();

function localFixture(t, Class = SupervisorLifecycle, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, now: 1792000000000, controls: [], markerCalls: [], events: [],
    context: { configuration: { contexts, mode: 'multi' } }, marker: { held: false, stale: false, runId: null, expiresAt: null, reason: 'absent' },
    transition: null, range: { count: 20, firstAt: 1791999990000 }, backlog: { total: 60, groups: [{ count: 60, firstAt: 1791999990000 }] } };
  f.scene = { sessionGroup: 'origin', runtime: 'claude', runId: 'old-run', sessionId: 's1',
    present: true, ready: true, processRunning: true, state: 'idle', idleSince: f.now - 10000,
    runDir: root, usagePercent: 80, launchConfig: { runtime: 'claude', mode: 'default' } };
  f.db = { getModeTransition: () => f.transition, getDrainFence: () => null, listDrainFences: () => [],
    getUnsummarizedRange: () => f.range, getGlobalUnsummarizedRange: () => f.range,
    getOriginSyncBacklog: () => f.backlog,
    insertControl: (content, opts) => { f.controls.push({ content, ...opts }); return { id: f.controls.length }; },
    ...options.db };
  f.deps = { db: f.db, bindTarget: scene => ({ expectedRunId: scene.runId, tmuxTarget: { serverGeneration: 'private-server', sessionId: '$1', paneId: '%1' } }), observeGroup: () => f.scene, observe: () => [f.scene],
    requests: { read: () => [] }, diagnostic: e => f.events.push(e),
    groupRunDir: () => f.root,
    readSyncMarker: args => { f.markerCalls.push(args); return f.marker; },
    prompts: { GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT,
      PRE_RECLAIM_CHECK_PROMPT, PRE_RECLAIM_SYNC_PROMPT, PRE_RECLAIM_ORIGIN_SYNC_PROMPT, ROTATION_PROMPT: 'rotate' },
    ...options.deps };
  const configuration = f.context.configuration;
  Object.defineProperty(f, 'context', { get: () => ({ configuration, transition: f.db.getModeTransition(),
    fences: f.db.listDrainFences(), restartRequests: [], scenes: [{ ...f.scene }] }) });
  f.lifecycle = new Class(f.deps, { now: () => f.now });
  return f;
}

async function duplicateScenario(t, storeFactory = createStore) {
  const sql = databaseFixture(t), store = storeFactory(sql.db, sql.dependencies);
  const f = localFixture(t, SupervisorLifecycle, { db: store });
  f.db.getUnsummarizedRange = () => f.range; f.db.getOriginSyncBacklog = () => ({ total: 0, groups: [] });
  await f.lifecycle.checkSync([f.scene], f.context);
  f.now += 600000; await f.lifecycle.checkSync([f.scene], f.context);
  const rows = sql.db.prepare('SELECT raw_content,status,session_group FROM control_queue').all();
  assert.equal(rows.filter(r => r.status === 'pending').length, 1, 'duplicate Sync left multiple pending controls');
  assert.equal(rows.filter(r => r.status === 'superseded').length, 1);
  assert.equal(rows[1].raw_content, rows[0].raw_content);
}
test('repeated Sync content leaves one pending row and supersedes the previous one', async t => {
  await duplicateScenario(t);
});

// The consumer uses the memory provider's frozen marker result.

async function syncScopeScenario(t, Class) {
  for (const mode of ['single', 'multi']) {
    const f = localFixture(t, Class); Object.assign(f.context.configuration, { mode });
    const insert = f.db.insertControl; let fail = true;
    f.db.insertControl = (...args) => { if (fail) throw new Error('injected write failure'); return insert(...args); };
    await assert.rejects(f.lifecycle.checkSync([f.scene], f.context), /injected write failure/);
    assert.equal(f.lifecycle.syncSent.size, 0, 'failed Sync write marked the scope sent');
    fail = false; f.now += 60000; await f.lifecycle.checkSync([f.scene], f.context);
    assert.deepEqual(f.markerCalls.map(c => c.kind), ['group', 'group', 'origin']);
    assert.ok(f.markerCalls.every(c => c.currentRunId === 'old-run' && c.runDir === f.root));
    assert.ok(f.controls.every(c => c.sessionGroup === 'origin' && c.priority === 2 && c.appendAckSuffix === false));
    const count = f.controls.length;
    f.scene = { ...f.scene, present: false }; f.now += 600000;
    await f.lifecycle.checkSync([f.scene], f.context);
    assert.equal(f.controls.length, count + 1);
    assert.equal(f.controls.at(-1).content, ORIGIN_SYNC_PROMPT);
    assert.deepEqual(f.markerCalls.at(-1), { runDir: f.root, kind: 'origin', currentRunId: null });
  }
}
test('Sync reads group and Origin marker scopes and failed writes do not mark a scope sent', async t => {
  await syncScopeScenario(t, SupervisorLifecycle);
});

test('ordinary group Sync uses the runtime prompt when available', async t => {
  const adapterCases = await Promise.all(runtimes.SUPPORTED_RUNTIMES.map(async runtime => {
    const { instructions: { groupSyncPrompt } } = await runtimes.findRuntime(runtime);
    assert.equal(typeof groupSyncPrompt, 'string', runtime);
    return ['multi', runtime, 'telegram:room', groupSyncPrompt];
  }));
  const { instructions: { groupSyncPrompt } } = await runtimes.findRuntime('claude');
  for (const [mode, runtime, sessionGroup, expected] of [
    ...adapterCases,
    ['multi', 'claude', 'origin', groupSyncPrompt],
    ['multi', runtimeWithoutPrompt, 'telegram:room', GROUP_SYNC_PROMPT],
    ['multi', 'unknown', 'telegram:room', GROUP_SYNC_PROMPT],
    ['single', 'claude', 'origin', GROUP_SYNC_PROMPT],
  ]) {
    const f = localFixture(t);
    f.context.configuration.mode = mode;
    f.scene.sessionGroup = sessionGroup;
    f.scene.runtime = runtime;
    f.scene.launchConfig.runtime = runtime;
    await f.lifecycle.checkSync([f.scene], f.context);
    assert.deepEqual(f.controls.map(row => [row.sessionGroup, row.content]),
      [[sessionGroup, expected], ['origin', ORIGIN_SYNC_PROMPT]], `${mode}/${runtime}/${sessionGroup}`);
  }
  assert.ok(findRuntime.mock.calls.some(call => call.arguments[0] === runtimeWithoutPrompt));

  const f = localFixture(t, SupervisorLifecycle, { db: {
    getLastActivity: () => null,
    getLatestContentCheckpoint: () => null,
    getDeliveredFrontier: () => 20,
  } });
  f.scene.createdAt = f.now - 3_300_000;
  await f.lifecycle.checkTtl(f.scene, f.context);
  assert.deepEqual(f.controls.map(row => row.content),
    [PRE_RECLAIM_CHECK_PROMPT, PRE_RECLAIM_SYNC_PROMPT, PRE_RECLAIM_ORIGIN_SYNC_PROMPT]);
});

// Boundary: real C4 binding, acknowledgment and drain-fence persistence; tmux is fake.
// Run for Origin TTL preparation/reclaim changes; unrelated machine tasks may skip.
test('Origin TTL persists its check and requires durable group and Origin repair before reclaim', async t => {
  const sql = databaseFixture(t), f = localFixture(t, SupervisorLifecycle, { db: sql.store });
  f.deps.env = { ZYLOS_DIR: f.root };
  f.scene.createdAt = f.now - 3_300_000;
  f.db.getLastActivity = () => null;
  f.db.getControlById = id => sql.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id);
  // Threshold 1 with two Origin group rows keeps the group Sync due before reclaim.
  f.context.configuration.syncThreshold = 1;
  sql.store.insertConversation('out', 'system', null, 'isolated earlier group result');
  const groupRow = sql.store.insertConversation('out', 'system', null, 'isolated group result');
  const originRow = sql.store.insertConversation('out', 'telegram', 'fixture', 'isolated Origin input', { groupName: 'room' });
  f.deps.prompts = { PRE_RECLAIM_CHECK_PROMPT, PRE_RECLAIM_SYNC_PROMPT, PRE_RECLAIM_ORIGIN_SYNC_PROMPT };
  let stops = 0; f.deps.stop = () => { stops++; f.scene = { ...f.scene, present: false, ready: false }; };
  await f.lifecycle.checkTtl(f.scene, f.context);
  const rows = sql.db.prepare('SELECT * FROM control_queue ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.raw_content), [PRE_RECLAIM_CHECK_PROMPT, PRE_RECLAIM_SYNC_PROMPT, PRE_RECLAIM_ORIGIN_SYNC_PROMPT]);
  for (const row of rows) {
    assert.equal(row.session_group, 'origin'); assert.equal(row.require_idle, 1); assert.ok(row.content.includes(' ---- ack via:'));
    assert.equal(JSON.parse(row.target_binding).expectedRunId, 'old-run'); assert.ok(Number.isInteger(row.ack_deadline_at));
  }
  assert.equal(sql.store.getOriginNeed().controls.count, 0);
  await f.lifecycle.checkTtl(f.scene, f.context); assert.equal(sql.store.getDrainFence('origin'), null);
  for (const row of rows.slice(0, -1)) {
    sql.db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(row.id);
    await f.lifecycle.checkTtl(f.scene, f.context); assert.equal(sql.store.getDrainFence('origin'), null);
  }
  // Acknowledgments alone cannot prove publication. Publish group state against
  // the real checkpoint; Origin's first failed round must still get one retry.
  const checkpoint = sql.store.createCheckpoint('origin', groupRow.id, 'isolated summary');
  const stateDir = groupMemoryDir('origin', { ZYLOS_DIR: f.root });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state.md'), renderStateSkeleton({ scope: 'origin', syncedAt: new Date(f.now).toISOString() })
    .replace('coverage= |', `coverage=${groupRow.id} |`));
  assert.equal(checkpoint.end_conversation_id, groupRow.id);
  f.deps.env = { ZYLOS_DIR: f.root };
  sql.db.prepare("UPDATE control_queue SET status='timeout' WHERE id=?").run(rows.at(-1).id);
  await f.lifecycle.checkTtl(f.scene, f.context);
  assert.equal(sql.store.getDrainFence('origin'), null);
  const retry = sql.db.prepare('SELECT * FROM control_queue ORDER BY id DESC LIMIT 1').get();
  assert.equal(retry.raw_content, PRE_RECLAIM_ORIGIN_SYNC_PROMPT);
  assert.ok(retry.id > rows.at(-1).id);
  sql.store.advanceOriginSyncCursor('telegram:room', { syncedId: originRow.id, checkpointId: 0 });
  sql.db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(retry.id);
  await f.lifecycle.checkTtl(f.scene, f.context);
  const fence = sql.store.getDrainFence('origin'); assert.equal(fence.reason, 'ttl'); assert.equal(fence.runId, 'old-run');
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'done');
  assert.equal(stops, 1); assert.equal(sql.store.getDrainFence('origin'), null);
  assert.equal(sql.db.prepare('SELECT count(*) FROM control_queue').pluck().get(), 4);
  assert.equal(sql.store.getOriginNeed().controls.count, 0);
});

