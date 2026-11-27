import { loadRuntimeContexts } from '../../../../cli/lib/model-rotation-thresholds.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as databaseFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../reclaim-prompts.js';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

const contexts = await loadRuntimeContexts();

function localFixture(t, Class = SupervisorLifecycle, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, now: 1792000000000, controls: [], events: [],
    context: { configuration: { contexts, mode: 'multi' } } };
  f.scene = { sessionGroup: 'origin', runtime: 'claude', runId: 'old-run', sessionId: 's1',
    present: true, ready: true, processRunning: true, state: 'idle', idleSince: f.now - 10000,
    runDir: root, usagePercent: 80, launchConfig: { runtime: 'claude', mode: 'default' } };
  f.db = { getModeTransition: () => null, getDrainFence: () => null, listDrainFences: () => [],
    insertControl: (content, opts) => { f.controls.push({ content, ...opts }); return { id: f.controls.length }; },
    ...options.db };
  f.deps = { db: f.db, bindTarget: scene => ({ expectedRunId: scene.runId, tmuxTarget: { serverGeneration: 'private-server', sessionId: '$1', paneId: '%1' } }), observeGroup: () => f.scene, observe: () => [f.scene],
    requests: { read: () => [] }, diagnostic: e => f.events.push(e),
    prompts: { PRE_RECLAIM_CHECK_PROMPT },
    ...options.deps };
  const configuration = f.context.configuration;
  Object.defineProperty(f, 'context', { get: () => ({ configuration, transition: f.db.getModeTransition(),
    fences: f.db.listDrainFences(), restartRequests: [], scenes: [{ ...f.scene }] }) });
  f.lifecycle = new Class(f.deps, { now: () => f.now });
  return f;
}

// Boundary: real C4 binding, acknowledgment and drain-fence persistence; tmux is fake.
// Run for Origin TTL preparation/reclaim changes; unrelated machine tasks may skip.
test('Origin TTL keeps its bound reclaim check with uncheckpointed conversations', async t => {
  const sql = databaseFixture(t), f = localFixture(t, SupervisorLifecycle, { db: sql.store });
  f.deps.env = { ZYLOS_DIR: f.root };
  f.scene.createdAt = f.now - 3_300_000;
  f.db.getLastActivity = () => null;
  f.db.getControlById = id => sql.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id);
  sql.store.insertConversation('out', 'system', null, 'isolated earlier group result');
  sql.store.insertConversation('out', 'system', null, 'isolated group result');
  sql.store.insertConversation('out', 'telegram', 'fixture', 'isolated Origin input', { groupName: 'room' });
  let stops = 0; f.deps.stop = () => { stops++; f.scene = { ...f.scene, present: false, ready: false }; };
  await f.lifecycle.checkTtl(f.scene, f.context);
  const rows = sql.db.prepare('SELECT * FROM control_queue ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.raw_content), [PRE_RECLAIM_CHECK_PROMPT]);
  for (const row of rows) {
    assert.equal(row.session_group, 'origin'); assert.equal(row.require_idle, 1); assert.ok(row.content.includes(' ---- ack via:'));
    assert.equal(JSON.parse(row.target_binding).expectedRunId, 'old-run'); assert.ok(Number.isInteger(row.ack_deadline_at));
  }
  assert.equal(sql.store.getOriginNeed().controls.count, 0);
  await f.lifecycle.checkTtl(f.scene, f.context); assert.equal(sql.store.getDrainFence('origin'), null);
  sql.db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(rows[0].id);
  await f.lifecycle.checkTtl(f.scene, f.context);
  const fence = sql.store.getDrainFence('origin'); assert.equal(fence.reason, 'ttl'); assert.equal(fence.runId, 'old-run');
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'done');
  assert.equal(stops, 1); assert.equal(sql.store.getDrainFence('origin'), null);
  assert.equal(sql.db.prepare('SELECT count(*) FROM control_queue').pluck().get(), 1);
  assert.equal(sql.store.getOriginNeed().controls.count, 0);
});

