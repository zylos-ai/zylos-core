import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

// Sync/queue integration: actual lifecycle production, C4 persistence and Router
// timeout maintenance, with in-memory SQLite and fixture runtime observations.
// Run for Group Sync deadline/scope changes; unrelated UI may skip. The root
// runner isolates HOME/ZYLOS_DIR/PM2_HOME/temp/socket paths before imports. No
// process, tmux, PM2 or network is started; router/database teardown belongs to t.
for (const [mode, kind, group] of [['multi', 'group', 'a'], ['single', 'global', null], ['multi', 'origin', 'origin']]) {
  test(`${kind} Sync keeps its intended deadline scope and backlog alerts remain durable`, async t => {
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
    const alert = rows.find(row => row.content === 'sync backlog alert');
    const sync = rows.find(row => row.content === (kind === 'origin' ? 'origin sync' : 'group sync'));
    assert.ok(alert); assert.ok(sync);
    assert.equal(alert.ack_deadline_at, null, 'backlog alerts retain their existing unbounded lifetime');
    assert.equal(sync.ack_deadline_at, kind === 'origin' ? null : Math.floor(f.now() / 1000) + 300);
    for (const row of rows) {
      assert.equal(row.status, 'pending');
      assert.doesNotMatch(row.content, /---- ack via:/);
      assert.equal(row.target_binding, null, 'ordinary Sync still supports absent-Origin demand');
    }
    const router = f.create(); await router.initialize();
    f.advance(300_000); router.tick(); await router.idle();
    assert.equal(f.sqlite.prepare("SELECT count(*) FROM control_queue WHERE status='pending'").pluck().get(), 2);
    f.advance(1000); router.tick(); await router.idle();
    assert.equal(f.db.getControlById(alert.id).status, 'pending');
    assert.equal(f.db.getControlById(sync.id).status, kind === 'origin' ? 'pending' : 'timeout');
    assert.equal(f.sqlite.prepare("SELECT count(*) FROM control_queue WHERE status='timeout'").pluck().get(), kind === 'origin' ? 0 : 1);
    f.advance(299_000);
    await lifecycle.syncScope(scene, kind, range, context);
    assert.equal(f.sqlite.prepare("SELECT count(*) FROM control_queue WHERE status='pending'").pluck().get(), 2,
      'Sync may retry at its existing interval while the original alert remains pending');
    const latest = f.sqlite.prepare('SELECT * FROM control_queue ORDER BY id DESC LIMIT 1').get();
    assert.equal(latest.ack_deadline_at, kind === 'origin' ? null : Math.floor(f.now() / 1000) + 300);
  });
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncObserver } from '../sync-observer.js';
import { appendEvent } from '../../../../cli/lib/event-log.js';
import { supervisorDiagnosticPath } from '../../../../cli/lib/session-group-paths.js';
import { PRE_RECLAIM_CHECK_PROMPT } from '../reclaim-prompts.js';
import * as syncPrompts from '../../../zylos-memory/scripts/sync-prompts.js';

// These cases extend the same isolated real C4/Router boundary above. Run for
// Sync observability/deadline changes; skip for unrelated UI. Fresh runner HOME,
// ZYLOS_DIR, PM2_HOME and TMPDIR are read back before opening any fixture; no
// runtime process, socket, PM2 service or external account is accessed.
function observableFixture(t) {
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key]?.includes('zylos-tests-'), `${key} must be isolated`);
  const f = routerFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-observation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root }, file = supervisorDiagnosticPath(env);
  const observer = new SyncObserver({ env, now: f.now }); t.after(() => observer.close());
  const scene = { sessionGroup: 'origin', present: true, ready: true, runtime: 'claude',
    runId: 'run', sessionId: 'session', runDir: path.join(root, 'run') };
  const lifecycle = new SupervisorLifecycle({ db: f.db, syncObserver: observer,
    requests: { read: () => [] }, observeGroup: () => scene,
    bindTarget: () => ({ expectedRunId: 'run', tmuxTarget: { serverGeneration: '1:1', sessionId: '$1', paneId: '%1' } }), groupRunDir: () => scene.runDir,
    readSyncMarker: () => ({ held: false, stale: false }), prompts: { ...syncPrompts, PRE_RECLAIM_CHECK_PROMPT },
    diagnostic: row => appendEvent(file, { v: 1, ts: f.now(), ...row }),
  }, { now: f.now });
  const context = { configuration: { mode: 'multi' }, scenes: [scene], fences: [], restartRequests: [], transition: null };
  const alerts = () => f.sqlite.prepare("SELECT content,session_group FROM control_queue WHERE content LIKE 'Memory Sync alert:%'").all();
  return { ...f, root, scene, lifecycle, context, observer, file, alerts };
}

test('third unchanged group request queues a typed scoped alert with six hour throttling', async t => {
  const f = observableFixture(t);
  const range = { count: 16, firstAt: f.now(), nonempty: true, firstConversationId: 1 };
  for (let i = 0; i < 3; i++) {
    await f.lifecycle.syncScope(f.scene, 'group', range, f.context);
    await f.lifecycle.syncAlerts(f.context); f.advance(600000);
  }
  const alerts = f.alerts(); assert.equal(alerts.length, 1);
  assert.match(alerts[0].content, /type=no_checkpoint; kind=group; scope=origin/);
  assert.equal(alerts[0].session_group, 'origin');
  await f.lifecycle.syncAlerts(f.context); assert.equal(f.alerts().length, 1);
  const events = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.event === 'sync_triggered');
  assert.equal(events.length, 3); assert.equal(events[0].backlog, 16); assert.ok(events[0].reason.includes('threshold'));
});

test('inactive group lag alerts without requesting that group session and distinguishes Origin lag', async t => {
  const f = observableFixture(t);
  const row = f.db.insertConversation('in', 'telegram', 'fixture', 'fixture', { groupName: 'inactive' });
  assert.equal(f.db.claimConversation(row.id), true);
  assert.equal(f.db.markDelivered(row.id, { sessionId: 'fixture' }), true);
  f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now() / 1000 - 21601, row.id);
  f.context.scenes = [];
  await f.lifecycle.checkSync([], f.context);
  assert.ok(f.alerts().some(row => /kind=group; scope=telegram:inactive/.test(row.content)));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) FROM control_queue WHERE session_group='telegram:inactive'").pluck().get(), 0);
  await f.lifecycle.sendSyncAlert({ type: 'backlog', kind: 'origin', scope: 'origin', backlog: 1, lag: 50000 }, f.context);
  assert.ok(f.alerts().some(row => /kind=origin; scope=origin/.test(row.content)));
});

test('pre-reclaim group and Origin Sync survive six minutes and expire after fifteen', async t => {
  const f = observableFixture(t);
  f.db.getUnsummarizedRange = () => ({ count: 1, firstAt: f.now(), firstConversationId: 1 });
  f.db.getOriginSyncBacklog = () => ({ total: 1, groups: [{ pendingCheckpoints: 0, firstAt: f.now() }] });
  const intent = { controlIds: [] };
  await f.lifecycle.prepareRelease(f.scene, f.context, intent);
  const rows = f.sqlite.prepare('SELECT id,raw_content,ack_deadline_at FROM control_queue ORDER BY id').all();
  assert.equal(rows.length, 3);
  for (const row of rows.slice(1)) assert.equal(row.ack_deadline_at, Math.floor(f.now() / 1000) + 900);
  f.advance(360000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  for (const row of rows.slice(1)) assert.equal(f.db.getControlById(row.id).status, 'pending');
  f.advance(541000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  for (const row of rows.slice(1)) assert.equal(f.db.getControlById(row.id).status, 'timeout');
  await f.lifecycle.syncAlerts(f.context);
  assert.ok(f.alerts().some(row => /type=control_timeout; kind=group/.test(row.content)));
  assert.ok(f.alerts().some(row => /type=control_timeout; kind=origin/.test(row.content)));
  const reasons = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.event === 'sync_triggered');
  assert.equal(reasons.length, 2); assert.ok(reasons.every(row => row.reason.includes('pre_reclaim')));
});

test('a temporarily fenced timeout alert is retained for successful later delivery', async t => {
  const f = observableFixture(t);
  await f.lifecycle.syncScope(f.scene, 'group', { count: 16, firstAt: f.now(), nonempty: true }, f.context);
  f.advance(301000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  f.db.setDrainFence('origin', { reason: 'ttl', runId: 'run' });
  await f.lifecycle.syncAlerts(f.context); assert.equal(f.alerts().length, 0);
  f.db.clearDrainFence('origin'); await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.alerts().length, 1); assert.match(f.alerts()[0].content, /type=control_timeout/);
});
