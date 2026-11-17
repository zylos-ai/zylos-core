import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncMaintenanceCoordinator } from '../sync-maintenance-coordinator.js';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { createMaintenanceRequests } from '../../../../cli/lib/sync-maintenance.js';
import { fixture as c4Fixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { renderStateSkeleton } from '../../../zylos-memory/scripts/state-format.js';

// Controller integration uses actual C4/receipt-range/checkpoint APIs and private
// durable files, with fixture runtime observations only. Run for repair admission,
// completion, failure or release coordination; skip unrelated UI. Official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no runtime, tmux or network is started.
function fixture(t, group = 'telegram:repair') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-maint-coordinator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1800000000000;
  const f = c4Fixture(t, { now: () => clock });
  const env = { ...process.env, ZYLOS_DIR: root };
  const db = { ...f.store, getActiveDeletion: () => null,
    getControlById: id => f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
  };
  const row = group === 'origin' ? db.insertConversation('out', 'system', null, 'fixture')
    : db.insertConversation('out', 'telegram', 'fixture', 'fixture', { groupName: 'repair' });
  const context = { configuration: { mode: 'multi', syncMaxIntervalSeconds: 60 }, scenes: [], fences: [], restartRequests: [], transition: null };
  const store = createMaintenanceRequests({ env, now: () => clock });
  const coordinator = new SyncMaintenanceCoordinator({ env, now: () => clock, store });
  let startup;
  const lifecycle = new SupervisorLifecycle({ env, db, syncMaintenance: coordinator,
    observeGroup: group => context.scenes.find(scene => scene.sessionGroup === group),
    requests: { read: () => [] }, readSyncMarker: () => ({ held: false, stale: false }),
    groupRunDir: scope => path.join(root, 'activity-monitor/session-groups', scope),
    readCurrentSession: () => startup,
    prompts: { PRE_RECLAIM_CHECK_PROMPT: 'check', SYNC_BACKLOG_ALERT: () => 'alert' },
  }, { now: () => clock });
  const alert = { type: 'backlog', kind: 'group', scope: group, backlog: 1, lag: 61 };
  const inspect = alerts => coordinator.advance(alerts, context, lifecycle);
  const run = async () => {
    const request = (await store.listMaintenanceRequests())[0];
    await store.claimMaintenance(group, 'maintenance-run');
    const control = db.insertControl('maintenance Sync', { sessionGroup: group, appendAckSuffix: true, ackDeadlineAt: Math.floor(clock / 1000) + 900 });
    startup = { runId: 'maintenance-run', startupControlIds: [control.id] };
    context.scenes = [{ sessionGroup: group, runId: 'maintenance-run', runDir: path.join(root, 'run'), present: true,
      ready: true, runtime: 'claude', state: 'idle', idleSince: clock - 10000, processRunning: true }];
    return { request, control };
  };
  const publish = () => {
    const checkpoint = db.createCheckpoint(group, row.id, 'fixture summary');
    const dir = path.join(root, 'memory/session-groups', group); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.md'), renderStateSkeleton({ scope: group, syncedAt: new Date(clock).toISOString() }).replace('coverage= |', `coverage=${row.id} |`));
    return checkpoint;
  };
  return { ...f, dbSqlite: f.db, env, root, group, db, row, context, store, coordinator, lifecycle, alert, inspect, run, publish, advance: ms => { clock += ms; } };
}

test('inactive symptoms queue one request and successful persisted Sync requests normal release without alert', async t => {
  const f = fixture(t);
  const first = await f.inspect([f.alert]);
  assert.equal(first.alerts.length, 0); assert.equal(first.failures.length, 0);
  assert.equal((await f.store.listMaintenanceRequests()).length, 1);
  await f.inspect([f.alert]); assert.equal((await f.store.listMaintenanceRequests()).length, 1);
  await f.run(); f.publish();
  const result = await f.inspect([]);
  assert.equal(result.failures.length, 0);
  const intent = f.lifecycle.releasePreparation.get(f.group);
  assert.equal(intent.skipSync, true); assert.equal(intent.runId, 'maintenance-run');
  assert.equal(f.store.read()[0].phase, 'finishing');
  f.context.scenes = []; await f.inspect([]);
  assert.equal(f.store.read()[0].phase, 'complete');
});

test('failed maintenance reports a reason, keeps one attempt per durable window, and clears after repair', async t => {
  const f = fixture(t); await f.inspect([f.alert]); const { control } = await f.run();
  f.db.getControlById(control.id);
  f.dbSqlite.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(control.id);
  const result = await f.inspect([f.alert]);
  assert.ok(result.failures.some(alert => alert.reason === 'no_checkpoint'));
  assert.equal(f.lifecycle.releasePreparation.get(f.group).skipSync, true);
  f.context.scenes = []; await f.inspect([f.alert]);
  assert.equal(f.store.read()[0].phase, 'failed');
  const restarted = new SyncMaintenanceCoordinator({ env: f.env, store: createMaintenanceRequests({ env: f.env }) });
  await restarted.advance([f.alert], f.context, f.lifecycle);
  assert.equal((await f.store.listMaintenanceRequests()).length, 0);
  f.publish();
  const fixed = await f.inspect([]);
  assert.ok(fixed.resolved.some(row => row.type === 'repair_failed'));
  assert.equal(fixed.failures.length, 0);
});

test('state-only maintenance can publish an existing checkpoint without demanding a new one', async t => {
  const f = fixture(t);
  const checkpoint = f.db.createCheckpoint(f.group, f.row.id, 'existing checkpoint');
  const alert = { ...f.alert, type: 'state_uncommitted', checkpointId: checkpoint.id };
  await f.inspect([alert]); await f.run();
  const dir = path.join(f.root, 'memory/session-groups', f.group); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.md'), renderStateSkeleton({ scope: f.group, syncedAt: new Date().toISOString() }).replace('coverage= |', `coverage=${f.row.id} |`));
  const result = await f.inspect([]);
  assert.equal(result.failures.length, 0); assert.equal(f.store.read()[0].outcome, 'success');
});

test('single mode, fences, deletion and real input do not queue maintenance', async t => {
  for (const reason of ['single', 'fence', 'delete', 'input']) {
    const f = fixture(t);
    if (reason === 'single') f.context.configuration.mode = 'single';
    if (reason === 'fence') f.context.fences = [{ sessionGroup: f.group, reason: 'delete' }];
    if (reason === 'delete') f.db.getActiveDeletion = () => ({ status: 'started' });
    if (reason === 'input') f.db.insertConversation('in', 'telegram', 'fixture', 'real input', { groupName: 'repair' });
    await f.inspect([f.alert]);
    assert.equal((await f.store.listMaintenanceRequests()).length, 0, reason);
  }
});

test('real input converts a running maintenance session without release or failure notification', async t => {
  const f = fixture(t); await f.inspect([f.alert]); await f.run();
  f.db.insertConversation('in', 'telegram', 'fixture', 'real input', { groupName: 'repair' });
  const result = await f.inspect([]);
  assert.equal(f.store.read()[0].phase, 'ordinary');
  assert.equal(result.failures.length, 0); assert.equal(f.lifecycle.releasePreparation.size, 0);
});

// The same private C4/state boundary proves final repair notifications survive a
// temporary Origin fence and restart without holding up reclaim or duplicating.
test('a final repair failure persists before enqueue, flushes after the fence, and resolves from durable facts', async t => {
  const f = fixture(t);
  const alert = { type: 'repair_failed', kind: 'group', scope: f.group, reason: 'INPUT_CHANGED', checkpointId: null, checkpointEnd: f.row.id };
  f.db.setDrainFence('origin', { reason: 'ttl', runId: 'origin-run' });
  assert.equal(await f.lifecycle.sendSyncAlert(alert, f.context), false);
  assert.equal(f.lifecycle.syncAlertEpisodes.entries()[0].sent, false);
  const { SyncAlertEpisodes } = await import('../sync-alert-episodes.js');
  f.lifecycle.syncAlertEpisodes = new SyncAlertEpisodes({ env: f.env });
  f.lifecycle.d.syncObserver = { resolved: [], groups: new Map(), originTriggers: [], originResults: [], inspect: () => [], acknowledged() {} };
  f.db.clearDrainFence('origin');
  await f.lifecycle.syncAlerts(f.context);
  const notices = () => f.dbSqlite.prepare("SELECT COUNT(*) AS n FROM control_queue WHERE raw_content='alert'").get().n;
  assert.equal(notices(), 1);
  f.advance(90 * 86400000);
  f.lifecycle.syncAlertEpisodes = new SyncAlertEpisodes({ env: f.env });
  await f.lifecycle.syncAlerts(f.context); assert.equal(notices(), 1);
  f.publish(); await f.lifecycle.syncAlerts(f.context);
  assert.equal(f.lifecycle.syncAlertEpisodes.entries().some(row => row.type === 'repair_failed'), false);
  await f.lifecycle.sendSyncAlert(alert, f.context); assert.equal(notices(), 2);
});


test('maintenance owns its single Sync and prevents ordinary Sync, TTL and rotation producers', async t => {
  const f = fixture(t); await f.inspect([f.alert]); await f.run();
  const scene = f.context.scenes[0];
  f.context.configuration.hotTtlSeconds = 1;
  scene.usagePercent = 100;
  f.lifecycle.d.prompts.ORIGIN_SYNC_PROMPT = 'ordinary Origin Sync';
  await f.lifecycle.checkTtl(scene, f.context);
  await f.lifecycle.checkRotation(scene, f.context);
  await f.lifecycle.checkSync([scene], f.context);
  assert.equal(f.dbSqlite.prepare('SELECT COUNT(*) AS n FROM control_queue WHERE session_group=?').get(f.group).n, 1);
  assert.equal(f.lifecycle.ttlPreparation.size, 0);
});


// A pending message must beat maintenance release even before Router has pasted
// it and emitted the ordinary delivery cancellation signal.
test('real input arriving after maintenance finishes cancels release before fencing', async t => {
  const f = fixture(t); await f.inspect([f.alert]); await f.run(); f.publish();
  await f.inspect([]);
  assert.equal(f.lifecycle.releasePreparation.get(f.group).maintenanceId, f.store.read()[0].id);
  f.db.insertConversation('in', 'telegram', 'fixture', 'new real work', { groupName: 'repair' });
  await f.lifecycle.advanceReleases(f.context);
  assert.equal(f.lifecycle.releasePreparation.has(f.group), false);
  assert.equal(f.store.read()[0].phase, 'ordinary');
  assert.equal(f.db.getDrainFence(f.group), null);
});


test('inactive Origin group maintenance never calls the deletion-only API that forbids Origin', async t => {
  const f = fixture(t, 'origin');
  f.db.getActiveDeletion = f.store.getActiveDeletion;
  await f.inspect([f.alert]);
  assert.equal((await f.store.listMaintenanceRequests())[0].sessionGroup, 'origin');
});
