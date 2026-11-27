import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../reclaim-prompts.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

test('voluntary release with a backlog enqueues one bounded reclaim check', async t => {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(process.env[key]?.includes('zylos-tests-'), `${key} must be isolated`);
  }
  const f = routerFixture(t);
  f.db.getUnsummarizedRange = () => ({ count: 16 });
  f.db.getOriginSyncBacklog = () => ({ total: 1, groups: [] });
  const scene = { sessionGroup: 'origin', present: true, ready: true, runId: 'run', sessionId: 'session' };
  const targetBinding = { expectedRunId: 'run', tmuxTarget: { serverGeneration: '1:1', sessionId: '$1', paneId: '%1' } };
  const lifecycle = new SupervisorLifecycle({
    db: f.db, requests: { read: () => [] }, observeGroup: () => scene, bindTarget: () => targetBinding,
    prompts: { PRE_RECLAIM_CHECK_PROMPT },
  }, { now: f.now });
  const context = { configuration: { mode: 'multi' }, scenes: [scene], fences: [], restartRequests: [], transition: null };
  const intent = { controlIds: [] };
  await lifecycle.prepareRelease(scene, context, intent);
  const rows = f.sqlite.prepare('SELECT id, raw_content, ack_deadline_at FROM control_queue ORDER BY id').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].raw_content, PRE_RECLAIM_CHECK_PROMPT);
  assert.equal(rows[0].ack_deadline_at, Math.floor(f.now() / 1000) + 300);
  assert.deepEqual(intent.controlIds, [rows[0].id]);
});
