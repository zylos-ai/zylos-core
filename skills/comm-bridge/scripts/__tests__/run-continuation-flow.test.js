import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { routerFixture } from './helpers/router-fixture.js';
import { ModeSwitchCoordinator } from '../../../activity-monitor/scripts/mode-switch.js';
import { SupervisorLifecycle } from '../../../activity-monitor/scripts/supervisor-lifecycle.js';
import { SupervisorRunEndings } from '../../../activity-monitor/scripts/supervisor-run-endings.js';
import { groupRunDir } from '../../../../cli/lib/session-group-paths.js';

// Cross-module boundary: persistent current-session file -> Supervisor reconciliation -> real C4
// records/control -> Router activation. Run for changes to any of these contracts;
// isolated module test with injected runtime I/O, no daemon, tmux or live resources.
test('a restarted supervisor resumes an absent group through the persistent continuation exactly once', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continue-flow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ZYLOS_DIR: root };
  const f = routerFixture(t);
  f.put('origin');
  const message = f.add('team');
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(message.id);
  const group = message.session_group;
  f.db.takeSlot(group, { runId: 'old-run', k: 2 });
  const directory = groupRunDir(group, env);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'current-session.json'), JSON.stringify({ runId: 'old-run', sessionId: 'old-session', ts: f.now() - 10000 }));
  const context = { configuration: { mode: 'multi' }, transition: null, fences: [], scenes: [] };
  const supervisor = () => new SupervisorRunEndings({ db: f.db, env, now: f.now,
    readIdentity: f.deps.readLiveIdentity, diagnostic: () => {}, reportError: error => { throw error; } });
  // A new instance has no earlier scene sample or in-memory exit history.
  await supervisor().advance(context);
  const record = f.db.listRunEndings(['team', 'gated-upgrade'])[0];
  assert.equal(record.runId, 'old-run'); assert.equal(record.reason, 'unexpected');
  assert.equal(f.db.listPendingContinuations().length, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
  f.create(); await f.router.initialize(); await f.rounds(2);
  f.advance(5000); await f.rounds(5);
  const launches = () => f.calls.filter(call => call[0] === 'launch' && call[1].sessionGroup === group);
  assert.equal(launches().length, 1);
  assert.equal(f.db.getControlById(record.continuationControlId).status, 'done');
  assert.equal(f.calls.filter(call => call[0] === 'control' && call[1] === record.continuationControlId).length, 1);
  await supervisor().advance(context); await f.rounds(3);
  assert.equal(launches().length, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM control_queue').get().n, 1);
  // A subsequent normal idle ending is recorded without another continuation.
  const runId = launches()[0][1].runId;
  f.db.setDrainFence(group, { reason: 'ttl', runId });
  f.db.recordRunEnd(group, { runId, reason: 'ttl', clearFence: true });
  f.scene.delete(group);
  await fs.writeFile(path.join(directory, 'current-session.json'), JSON.stringify({ runId, sessionId: 'new-session', ts: f.now() }));
  await supervisor().advance(context);
  f.advance(120000); await f.rounds(4);
  assert.equal(launches().length, 1);
  assert.equal(f.db.listRunEndings(['team', 'gated-upgrade'])[0].reason, 'ttl');
  assert.equal(f.db.listRunEndings(['team', 'gated-upgrade'])[0].continuationControlId, null);
});

// Cutover contract: the existing coordinator must expire persistent continuation
// controls through the real store. Run for continuation preservation/expiry changes;
// all database state is fixture-local and conversion has no filesystem side effects.
test('mode cutover expires pending continuation through the normal coordinator', async t => {
  const f = routerFixture(t);
  const message = f.add('team');
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(message.id);
  const ended = f.db.recordRunEnd('team', { runId: 'old-run', reason: 'unexpected' });
  const { runId } = f.db.beginModeTransition('multi', 'single');
  f.db.setDrainFence('*');
  f.db.absorbForTransition(runId);
  const coordinator = new ModeSwitchCoordinator({ db: f.db, readMode: () => ({ mode: 'multi' }),
    convert: async () => {}, diagnostic: () => {}, now: f.now });
  await coordinator.advance();
  assert.equal(f.db.getModeTransition().phase, 'cutover');
  assert.equal(f.db.getControlById(ended.continuationControlId).status, 'timeout');
  assert.deepEqual(f.db.listPendingContinuations(), []);
  assert.equal(f.db.listRunEndings(['team', 'gated-upgrade'])[0].continuationControlId, ended.continuationControlId);
});


// Real lifecycle/coordinator/store boundary: run for reclaim completion during
// mode gating or continuation suppression/cutover changes. All C4 state is local
// to the fixture; scene stop, conversion and dispatcher restart are injected I/O.
test('upgrade reclaim finishes during gating without creating a continuation before cutover', async t => {
  const f = routerFixture(t);
  const message = f.add('gated-upgrade');
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(message.id);
  const group = message.session_group, runId = 'upgrade-run';
  f.put(group, { sessionGroup: group, runId, processRunning: false });
  f.db.setDrainFence(group, { reason: 'upgrade', runId });
  const transition = f.db.beginModeTransition('multi', 'single');
  let mode = 'multi';
  const stops = [], conversions = [], writes = [], restarts = [];
  const observe = async () => [...f.scene.values()];
  const lifecycle = new SupervisorLifecycle({
    db: f.db, observeGroup: f.deps.readLiveIdentity, observe,
    stop: async scene => { stops.push(scene.runId); f.scene.delete(scene.sessionGroup); },
    diagnostic: () => {},
  }, { now: f.now });
  const coordinator = new ModeSwitchCoordinator({
    db: f.db, lifecycle, readMode: () => ({ mode }), readConfiguration: async () => ({ runtime: 'claude' }),
    observe, readRequests: () => [],
    convert: async row => { conversions.push(row.run_id); },
    writeMode: async target => { writes.push(target); mode = target; },
    restart: { advance: async request => { restarts.push(request.runId); return { confirmed: true }; } },
    diagnostic: () => {}, now: f.now,
  });
  const groupControls = () => f.sqlite.prepare('SELECT count(*) AS n FROM control_queue WHERE session_group=?').get(group).n;
  assert.equal(f.db.getModeTransition().phase, 'gating');
  await coordinator.advance();
  assert.deepEqual(stops, [runId]);
  assert.equal(f.db.getDrainFence(group), null);
  assert.deepEqual(f.db.listRunEndings(['team', 'gated-upgrade']).map(row => ({ sessionGroup: row.sessionGroup, runId: row.runId,
    reason: row.reason, continuationControlId: row.continuationControlId })),
  [{ sessionGroup: group, runId, reason: 'upgrade', continuationControlId: null }]);
  assert.equal(groupControls(), 0);
  assert.equal(f.db.getModeTransition().phase, 'converting', 'gating must finish after the existing upgrade reclaim');
  await coordinator.advance();
  assert.deepEqual(conversions, [transition.runId]);
  assert.equal(f.db.getModeTransition().phase, 'cutover');
  assert.equal(groupControls(), 0);
  assert.equal(f.db.listPendingContinuations().length, 0);
  await coordinator.advance();
  assert.deepEqual(writes, ['single']);assert.deepEqual(restarts, [transition.runId]);
  assert.equal(f.db.getModeTransition(), null);
  assert.equal(f.db.getDrainFence('*'), null);
  assert.equal(groupControls(), 0);
});
