import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

// Sync/queue integration: actual lifecycle production, C4 persistence and Router
// timeout maintenance, with in-memory SQLite and fixture runtime observations.
// Run for ordinary Sync/alert deadline changes; unrelated UI may skip. The root
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/temp/socket paths before imports. No
// process, tmux, PM2 or network is started; router/database teardown belongs to t.
for (const [mode, kind, group] of [['multi', 'group', 'a'], ['single', 'global', null], ['multi', 'origin', 'origin']]) {
  test(`${kind} Sync and backlog alert have finite deadlines without ack suffixes`, async t => {
    const f = routerFixture(t, { mode });
    const scene = { sessionGroup: group, present: true, ready: true, runtime: 'claude',
      runId: 'sync-run', sessionId: 'sync-session', runDir: '/isolated/sync', state: 'idle' };
    const lifecycle = new SupervisorLifecycle({ db: f.db, observeGroup: () => scene,
      requests: { read: () => [] }, readSyncMarker: () => ({ held: false, stale: false }),
      prompts: { GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync', SYNC_BACKLOG_ALERT: () => 'sync backlog alert' },
    }, { now: f.now });
    const context = { configuration: { mode }, scenes: [scene], fences: [], restartRequests: [], transition: null };
    const range = { count: 1000, nonempty: true, firstAt: f.now() - 100_000_000,
      alertFirstAt: f.now() - 100_000_000, firstConversationId: 1 };
    await lifecycle.syncScope(scene, kind, range, context);
    const rows = f.sqlite.prepare('SELECT * FROM control_queue ORDER BY id').all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, 'pending');
      assert.equal(row.ack_deadline_at, Math.floor(f.now() / 1000) + 300);
      assert.doesNotMatch(row.content, /---- ack via:/);
      assert.equal(row.target_binding, null, 'ordinary Sync still supports absent-Origin demand');
    }
    const router = f.create(); await router.initialize();
    f.advance(300_000); router.tick(); await router.idle();
    assert.equal(f.sqlite.prepare("SELECT count(*) FROM control_queue WHERE status='pending'").pluck().get(), 2);
    f.advance(1000); router.tick(); await router.idle();
    assert.equal(f.sqlite.prepare("SELECT count(*) FROM control_queue WHERE status='timeout'").pluck().get(), 2);
    f.advance(299_000);
    await lifecycle.syncScope(scene, kind, range, context);
    assert.equal(f.sqlite.prepare("SELECT count(*) FROM control_queue WHERE status='pending'").pluck().get(), 1,
      'ordinary Sync may retry at its existing interval after timeout');
    const latest = f.sqlite.prepare('SELECT * FROM control_queue ORDER BY id DESC LIMIT 1').get();
    assert.equal(latest.ack_deadline_at, Math.floor(f.now() / 1000) + 300);
  });
}
