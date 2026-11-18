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
    const env = { ZYLOS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sync-deadline-')) }; t.after(() => fs.rmSync(env.ZYLOS_DIR, { recursive: true, force: true }));
    const lifecycle = new SupervisorLifecycle({ env, db: f.db, observeGroup: () => scene,
      requests: { read: () => [] }, readSyncMarker: () => ({ held: false, stale: false }),
      prompts: { GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync', SYNC_BACKLOG_ALERT: () => 'sync backlog alert' },
    }, { now: f.now });
    const context = { configuration: { mode, legacy: mode === 'single' }, scenes: [scene], fences: [], restartRequests: [], transition: null };
    const range = { count: 1000, nonempty: true, firstAt: f.now() - 100_000_000,
      alertFirstAt: f.now() - 100_000_000, firstConversationId: 1 };
    await lifecycle.sendSyncAlert({ type: 'backlog', kind, scope: kind === 'global' ? '*' : scene.sessionGroup, backlog: range.count, lag: 100000 }, context);
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
import { supervisorDiagnosticPath, groupMemoryDir } from '../../../../cli/lib/session-group-paths.js';
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
  const lifecycle = new SupervisorLifecycle({ env, db: f.db, syncObserver: observer,
    requests: { read: () => [] }, observeGroup: () => scene,
    bindTarget: () => ({ expectedRunId: 'run', tmuxTarget: { serverGeneration: '1:1', sessionId: '$1', paneId: '%1' } }), groupRunDir: () => scene.runDir,
    readSyncMarker: () => ({ held: false, stale: false }), prompts: { ...syncPrompts, PRE_RECLAIM_CHECK_PROMPT },
    diagnostic: row => appendEvent(file, { v: 1, ts: f.now(), ...row }),
  }, { now: f.now });
  const context = { configuration: { mode: 'multi' }, scenes: [scene], fences: [], restartRequests: [], transition: null };
  const alerts = () => f.sqlite.prepare("SELECT content,session_group FROM control_queue WHERE content LIKE 'Memory Sync alert:%'").all();
  const events = type => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    .filter(row => row.event === 'sync_alert' && (!type || row.type === type)) : [];
  const restart = async () => {
    lifecycle.d.syncObserver.close();
    const next = new SyncObserver({ env, now: f.now }); t.after(() => next.close());
    lifecycle.d.syncObserver = next;
    lifecycle.syncAlertEpisodes = new (await import('../sync-alert-episodes.js')).SyncAlertEpisodes({ env, now: f.now });
  };
  return { ...f, root, scene, lifecycle, context, observer, file, alerts, events, restart };
}

test('third unchanged group request queues a typed scoped alert once per unresolved episode', async t => {
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

test('inactive group lag remains silent and distinguishes Origin lag', async t => {
  const f = observableFixture(t);
  const row = f.db.insertConversation('in', 'telegram', 'fixture', 'fixture', { groupName: 'inactive' });
  assert.equal(f.db.claimConversation(row.id), true);
  assert.equal(f.db.markDelivered(row.id, { sessionId: 'fixture' }), true);
  f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now() / 1000 - 21601, row.id);
  f.context.scenes = [];
  await f.lifecycle.checkSync([], f.context);
  assert.equal(f.alerts().some(row => /kind=group; scope=telegram:inactive/.test(row.content)), false);
  assert.equal(f.alerts().length, 0);
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
  assert.equal(f.alerts().length, 0);
  assert.deepEqual(f.events('control_timeout').map(row => row.kind).sort(), ['group', 'origin']);
  const reasons = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.event === 'sync_triggered');
  assert.equal(reasons.length, 2); assert.ok(reasons.every(row => row.reason.includes('pre_reclaim')));
});

test('a fenced Origin cannot block timeout diagnostics or create owner controls', async t => {
  const f = observableFixture(t);
  await f.lifecycle.syncScope(f.scene, 'group', { count: 16, firstAt: f.now(), nonempty: true }, f.context);
  f.advance(301000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  f.db.setDrainFence('origin', { reason: 'ttl', runId: 'run' });
  await f.lifecycle.syncAlerts(f.context); assert.equal(f.alerts().length, 0);
  assert.equal(f.events('control_timeout').length, 1);
  f.db.clearDrainFence('origin'); await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.alerts().length, 0); assert.equal(f.events('control_timeout').length, 1);
});

// Run for max-lag observation or active-session filtering changes; skip unrelated
// UI changes. Uses the isolated real C4/Router fixture described above.
test('a live group at maximum lag receives Sync while an absent group remains untouched', async t => {
  const f = observableFixture(t);
  for (const name of ['active', 'inactive']) {
    const row = f.db.insertConversation('in', 'telegram', name, 'fixture', { groupName: name });
    assert.equal(f.db.claimConversation(row.id), true);
    assert.equal(f.db.markDelivered(row.id, { sessionId: 'fixture' }), true);
    f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now() / 1000 - 21601, row.id);
  }
  const scene = { ...f.scene, sessionGroup: 'telegram:active' };
  f.context.scenes = [scene];
  f.lifecycle.d.observeGroup = group => group === scene.sessionGroup ? scene : null;
  await f.lifecycle.checkSync([scene], f.context);
  assert.equal(f.alerts().filter(row => /kind=group; scope=telegram:active/.test(row.content)).length, 0);
  assert.equal(f.alerts().filter(row => /kind=group; scope=telegram:inactive/.test(row.content)).length, 0);
  const groupControls = f.sqlite.prepare("SELECT raw_content,session_group FROM control_queue WHERE session_group IN ('telegram:active','telegram:inactive')").all();
  assert.equal(groupControls.length, 1);
  assert.equal(groupControls[0].session_group, 'telegram:active');
  assert.equal(groupControls[0].raw_content, syncPrompts.GROUP_SYNC_PROMPT);
});

test('each timeout remains consumed after supervisor restart without a time window', async t => {
  const f = observableFixture(t);
  const range = { count: 16, firstAt: f.now(), nonempty: true };
  await f.lifecycle.syncScope(f.scene, 'group', range, f.context);
  f.advance(301000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  await f.lifecycle.syncAlerts(f.context); assert.equal(f.alerts().length, 0);
  assert.equal(f.events('control_timeout').length, 1);
  f.advance(300000); await f.lifecycle.syncScope(f.scene, 'group', range, f.context);
  f.advance(301000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  await f.lifecycle.syncAlerts(f.context); assert.equal(f.alerts().length, 0);
  assert.equal(f.events('control_timeout').length, 2);
  assert.ok(f.lifecycle.syncAlertEpisodes.entries().filter(row => row.type === 'control_timeout').every(row => row.sent));
  f.observer.close();
  const observer = new SyncObserver({ env: { ZYLOS_DIR: f.root }, now: f.now }); t.after(() => observer.close());
  f.lifecycle.d.syncObserver = observer;
  f.lifecycle.syncAlertEpisodes = new (await import('../sync-alert-episodes.js')).SyncAlertEpisodes({ env: { ZYLOS_DIR: f.root }, now: f.now });
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.alerts().length, 0);
  assert.equal(f.events('control_timeout').length, 2, 'restart recovers handled timeout incidents from persistent episode state');
});


// Real diagnostic/control incident integration, same isolated boundary above.
// Run for repair-first notification gates; unrelated UI may skip.
test('active backlog waits for ordinary Sync failure before notifying', async t => {
  const f = observableFixture(t);
  await f.lifecycle.syncScope(f.scene, 'group', { count: 1000, firstAt: f.now(), nonempty: true }, f.context);
  await f.lifecycle.syncAlerts(f.context); assert.equal(f.alerts().length, 0);
  appendEvent(f.file, { v: 1, ts: f.now(), event: 'sync_result', kind: 'group', scope: 'origin', runId: f.scene.runId, status: 'error', code: 'INPUT_CHANGED' });
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.alerts().filter(row => /type=backlog; kind=group/.test(row.content)).length, 1);
});

test('state gaps log once per persistent incident, resolve on catch-up and recur without controls', async t => {
  const f = observableFixture(t);
  const row = f.db.insertConversation('out', 'system', null, 'fixture result');
  f.db.createCheckpoint('origin', row.id, 'fixture checkpoint');
  f.lifecycle.d.prompts = { ...f.lifecycle.d.prompts, SYNC_BACKLOG_ALERT: () => { assert.fail('state diagnostic requested owner prompt'); } };
  f.db.setDrainFence('origin', { reason: 'ttl', runId: 'run' });
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.events('state_uncommitted').length, 1, 'state observation needs no repair attempt');
  await f.lifecycle.syncAlerts(f.context); await f.restart(); await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.events('state_uncommitted').length, 1, 'restart preserves the unresolved diagnostic incident');
  const directory = groupMemoryDir('origin', { ZYLOS_DIR: f.root });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'state.md'), `<!-- zylos-state v1 | scope=origin | synced_at=2026-11-17T00:00:00Z | coverage=${row.id} | inbox_committed= -->\n`);
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.lifecycle.syncAlertEpisodes.entries().some(row => row.type === 'state_uncommitted'), false);
  await f.restart();
  const next = f.db.insertConversation('out', 'system', null, 'later fixture result');
  f.db.createCheckpoint('origin', next.id, 'later fixture checkpoint');
  await f.lifecycle.syncAlerts(f.context); await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.events('state_uncommitted').length, 2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) FROM control_queue').pluck().get(), 0);
});


// Product path: real rotated event reader, durable episode ledger and C4 queue.
// Restart only replaces observer/ledger; no services or external processes start.
for (const type of ['origin_frequency', 'origin_idle']) {
  test(`${type} logs once, survives restart and logs a new resolved recurrence without controls`, async t => {
    const f = observableFixture(t);
    const emit = productive => appendEvent(f.file, { v: 1, ts: f.now(),
      ...(type === 'origin_frequency' ? { event: 'sync_triggered', kind: 'origin', scope: 'origin' }
        : { event: 'sync_result', kind: 'origin', action: 'round_complete', processedCount: productive ? 1 : 0, advancedGroups: productive ? 1 : 0 }) });
    const trigger = () => { for (let i = 0; i < (type === 'origin_frequency' ? 5 : 10); i++) emit(false); };
    // Any use of the owner prompt for a diagnostic is a regression, even if
    // queue deduplication might otherwise hide it.
    f.lifecycle.d.prompts = { ...f.lifecycle.d.prompts, SYNC_BACKLOG_ALERT: () => { assert.fail('diagnostic requested owner prompt'); } };
    f.db.setDrainFence('origin', { reason: 'ttl', runId: 'run' });
    trigger(); await f.lifecycle.syncAlerts(f.context);
    assert.equal(f.events(type).length, 1);
    await f.lifecycle.syncAlerts(f.context); await f.restart(); await f.lifecycle.syncAlerts(f.context);
    assert.equal(f.events(type).length, 1);
    if (type === 'origin_frequency') f.advance(3600001);
    else for (let i = 0; i < 10; i++) emit(true);
    await f.lifecycle.syncAlerts(f.context);
    await f.restart(); trigger(); await f.lifecycle.syncAlerts(f.context);
    assert.equal(f.events(type).length, 2);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) FROM control_queue').pluck().get(), 0);
  });
}

test('reclaim-owned timeout logs once without requesting an owner prompt or adding any control', async t => {
  const f = observableFixture(t);
  await f.lifecycle.syncScope(f.scene, 'group', { count: 16, firstAt: f.now(), nonempty: true }, f.context);
  const id = f.sqlite.prepare('SELECT id FROM control_queue').pluck().get();
  f.lifecycle.releasePreparation.set('origin', { runId: 'run', controlIds: [id] });
  const count = f.sqlite.prepare('SELECT COUNT(*) FROM control_queue').pluck().get();
  f.lifecycle.d.prompts = { ...f.lifecycle.d.prompts, SYNC_BACKLOG_ALERT: () => { assert.fail('timeout requested owner prompt'); } };
  f.advance(301000); f.db.expireTimedOutControls(Math.floor(f.now() / 1000));
  await f.lifecycle.syncAlerts(f.context); await f.lifecycle.syncAlerts(f.context);
  await f.restart(); await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.events('control_timeout').length, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) FROM control_queue').pluck().get(), count);
});

for (const [type, reason, issue] of [
  ['backlog', 'INPUT_CHANGED', /27 messages remain unsynced/],
  ['no_checkpoint', undefined, /repeated Sync requests produced no new checkpoint/],
  ['repair_failed', 'control_timeout', /Memory Sync repair failed/],
]) {
  test(`${type} owner control explains issue repair failure and a concrete next action`, async t => {
    const f = observableFixture(t);
    await f.lifecycle.sendSyncAlert({ type, kind: 'group', scope: 'telegram:help', backlog: 27, lag: 42,
      ...(reason ? { reason } : {}) }, f.context);
    const rows = f.alerts(); assert.equal(rows.length, 1);
    assert.equal(rows[0].session_group, 'origin');
    assert.match(rows[0].content, issue);
    assert.match(rows[0].content, /Automated repair: .*; failed because/);
    assert.match(rows[0].content, /Action: .*rerun Sync for this scope/);
    if (reason) assert.ok(rows[0].content.includes(reason));
    if (reason === 'INPUT_CHANGED') assert.match(rows[0].content, /once current messages settle/);
    else assert.match(rows[0].content, /verify a covering checkpoint and a released Sync lock/);
    assert.equal(f.events(type).length, 1);
    await f.restart(); await f.lifecycle.sendSyncAlert({ type, kind: 'group', scope: 'telegram:help' }, f.context);
    assert.equal(f.alerts().length, 1);
  });
}


test('Origin repair failure gives cursor and lock proof instead of group checkpoint proof', async t => {
  const f = observableFixture(t);
  await f.lifecycle.sendSyncAlert({ type: 'repair_failed', kind: 'origin', scope: 'origin',
    reason: 'no_checkpoint', repairAttempt: 'pre_reclaim_retry' }, f.context);
  assert.equal(f.alerts().length, 1);
  assert.match(f.alerts()[0].content, /pre-reclaim Sync plus one retry; failed because no_checkpoint/);
  assert.match(f.alerts()[0].content, /verify cursor progress and a released Sync lock/);
  assert.doesNotMatch(f.alerts()[0].content, /covering checkpoint/);
});


// Actual marker parser + C4 + observer, isolated files only. Run when scene
// scope mapping changes; no runtime or external process is started.
test('single state observation preserves current run ownership of the global Sync marker', async t => {
  const f = observableFixture(t);
  f.context.configuration.mode = 'single';
  f.context.configuration.legacy = true;
  f.scene.sessionGroup = 'legacy-single';
  const row = f.db.insertConversation('out', 'system', null, 'global result');
  f.db.createCheckpoint('*', row.id, 'global checkpoint');
  const { readSyncMarker, markerPath } = await import('../../../zylos-memory/scripts/sync-lock.js');
  fs.mkdirSync(f.scene.runDir, { recursive: true });
  fs.writeFileSync(markerPath(f.scene.runDir, 'global'), JSON.stringify({ runId: f.scene.runId, kind: 'global',
    token: 'a'.repeat(32), expiresAt: f.now() + 100000 }));
  const calls = [];
  f.lifecycle.d.readSyncMarker = args => { calls.push(args); return readSyncMarker(args, { now: f.now }); };
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].currentRunId, f.scene.runId);
  assert.equal(calls[0].runDir, f.scene.runDir);
  assert.equal(f.events('state_uncommitted').length, 0);
  assert.equal(f.alerts().length, 0);
});

test('active Sync marker prevents state notification even after its control acknowledgment', async t => {
  const f = observableFixture(t);
  const row = f.db.insertConversation('out', 'system', null, 'group result');
  f.db.createCheckpoint('origin', row.id, 'group checkpoint');
  await f.lifecycle.syncScope(f.scene, 'group', { count: 16, firstAt: f.now(), nonempty: true }, f.context);
  const { readSyncMarker, markerPath } = await import('../../../zylos-memory/scripts/sync-lock.js');
  fs.mkdirSync(f.scene.runDir, { recursive: true });
  fs.writeFileSync(markerPath(f.scene.runDir, 'group'), JSON.stringify({ runId: f.scene.runId, kind: 'group',
    token: 'b'.repeat(32), expiresAt: f.now() + 100000 }));
  f.lifecycle.d.readSyncMarker = args => readSyncMarker(args, { now: f.now });
  f.sqlite.prepare("UPDATE control_queue SET status='done'").run();
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.events('state_uncommitted').length, 0);
  assert.equal(f.alerts().length, 0);
  fs.unlinkSync(markerPath(f.scene.runDir, 'group'));
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.events('state_uncommitted').length, 1);
  assert.equal(f.alerts().length, 0);
});

test('rejected repair-failure notice replays through syncAlerts offline until checkpoint proof resolves it', async t => {
  const f = observableFixture(t);
  const scope = 'telegram:repair';
  const row = f.db.insertConversation('out', 'telegram', 'fixture', 'repair target', { groupName: 'repair' });
  const alert = { type: 'repair_failed', kind: 'group', scope, reason: 'no_checkpoint',
    repairAttempt: 'pre_reclaim_retry', checkpointId: null, checkpointEnd: row.id };
  const insert = f.lifecycle.d.db.insertControl;
  f.lifecycle.d.db.insertControl = () => { throw Object.assign(new Error('isolated database busy'), { code: 'SQLITE_BUSY' }); };
  await assert.rejects(f.lifecycle.sendSyncAlert(alert, f.context), { code: 'SQLITE_BUSY' });
  assert.equal(f.alerts().length, 0);
  assert.equal(f.lifecycle.syncAlertEpisodes.entries().find(row => row.type === 'repair_failed').sent, false);
  await f.restart();
  assert.equal(f.lifecycle.syncAlertEpisodes.entries().find(row => row.type === 'repair_failed').repairAttempt, 'pre_reclaim_retry');
  f.lifecycle.d.db.insertControl = insert;
  f.context.scenes = [];
  f.lifecycle.d.observeGroup = () => null;
  await f.lifecycle.syncAlerts(f.context);
  await f.lifecycle.syncAlerts(f.context); await f.restart(); await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.alerts().length, 1, 'offline scope replays one durable notice without a new repair trigger');
  assert.equal(f.events('repair_failed').length, 1);
  f.db.createCheckpoint(scope, row.id, 'repaired checkpoint');
  const directory = groupMemoryDir(scope, { ZYLOS_DIR: f.root });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'state.md'), `<!-- zylos-state v1 | scope=${scope} | synced_at=2026-11-17T00:00:00Z | coverage=0 | inbox_committed= -->\n`);
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.lifecycle.syncAlertEpisodes.entries().some(row => row.type === 'repair_failed'), false,
    'covering checkpoint and released lock resolve repair failure even while state remains behind');
  assert.equal(f.alerts().length, 1);
  const checkpoint = f.db.getLatestContentCheckpoint(scope);
  const next = f.db.insertConversation('out', 'telegram', 'fixture', 'next repair target', { groupName: 'repair' });
  await f.lifecycle.sendSyncAlert({ ...alert, checkpointId: checkpoint.id, checkpointEnd: next.id }, f.context);
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.alerts().length, 2, 'resolution permits a later repair-failure incident');
  assert.equal(f.events('repair_failed').length, 2);
});


// Real observer/incident/C4 queue, isolated fixture; bounded success rounds still
// leave an overdue range. Run for Origin backlog notification policy changes.
test('successful Origin rounds still notify overdue backlog once until resolution and recurrence', async t => {
  const f = observableFixture(t);
  const range = { count: 27, firstAt: f.now() - 50000000, alertFirstAt: f.now() - 50000000, nonempty: true };
  for (let i = 0; i < 3; i++) {
    appendEvent(f.file, { v: 1, ts: f.now(), event: 'sync_result', kind: 'origin', scope: 'origin',
      action: 'round_complete', status: 'ok', processedCount: 1, advancedGroups: 1 });
    await f.lifecycle.syncScope(f.scene, 'origin', range, f.context);
    await f.lifecycle.syncAlerts(f.context);
    assert.equal(f.lifecycle.d.syncObserver.originResults.at(-1).status, 'ok');
    f.advance(600001);
  }
  const notices = () => f.alerts().filter(row => /type=backlog; kind=origin; scope=origin/.test(row.content));
  assert.equal(notices().length, 1);
  assert.match(notices()[0].content, /27 messages remain unsynced/);
  assert.match(notices()[0].content, /ordinary Origin Sync; backlog remains above the limit/);
  assert.doesNotMatch(notices()[0].content, /failed because/);
  assert.match(notices()[0].content, /Action: .*cursor progress and a released Sync lock/);
  await f.restart(); await f.lifecycle.syncAlerts(f.context);
  assert.equal(notices().length, 1);
  await f.lifecycle.syncScope(f.scene, 'origin', { count: 0, firstAt: null, alertFirstAt: null, nonempty: false }, f.context);
  await f.lifecycle.syncAlerts(f.context);
  appendEvent(f.file, { v: 1, ts: f.now(), event: 'sync_result', kind: 'origin', scope: 'origin',
    action: 'round_complete', status: 'ok', processedCount: 1, advancedGroups: 1 });
  await f.lifecycle.syncScope(f.scene, 'origin', range, f.context);
  await f.lifecycle.syncAlerts(f.context);
  assert.equal(notices().length, 2);
});

// Real C4/checkpoint, observer and lifecycle in the private fixture above.
// Run when dormant-group alert filtering changes; no runtime is started.
test('dormant checkpoint-state gaps and retained backlog candidates create no owner controls', async t => {
  const f = observableFixture(t);
  const scope = 'telegram:inactive';
  const row = f.db.insertConversation('out', 'telegram', 'fixture', 'fixture', { groupName: 'inactive' });
  const checkpoint = f.db.createCheckpoint(scope, row.id, 'fixture checkpoint');
  for (let i = 0; i < 3; i++) appendEvent(f.file, { v: 1, ts: f.now(), event: 'sync_triggered', kind: 'group', scope, checkpointId: checkpoint.id });
  f.lifecycle.syncBacklogCandidates.set(JSON.stringify(['group', scope]), { type: 'backlog', kind: 'group', scope, backlog: 900, lag: 50000 });
  await f.lifecycle.syncAlerts(f.context);
  const evidence = f.lifecycle.d.syncObserver.groups.get(JSON.stringify(['group', scope]));
  assert.equal(evidence.checkpointId, checkpoint.id);
  assert.ok(evidence.attempts >= 3, 'retained backlog has enough failed-attempt evidence to notify if the live-scene gate is removed');
  assert.equal(f.alerts().length, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) FROM control_queue').pluck().get(), 0);
});
