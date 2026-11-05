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
// records/marker -> Router activation. Run for changes to any of these contracts;
// official runner isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR. The fixture
// owns its temporary current-session files and memory SQLite; runtime/clock I/O
// is injected, no daemon/tmux/network is used, and teardown stops the router and
// closes/removes the owned resources. Skip unrelated UI changes.
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
  assert.equal(record.continuationPending, 1);
  assert.equal(f.db.listPendingContinuations().length, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
  f.create(); await f.router.initialize(); await f.rounds(2);
  f.advance(5000); await f.rounds(5);
  const launches = () => f.calls.filter(call => call[0] === 'launch' && call[1].sessionGroup === group);
  assert.equal(launches().length, 1);
  assert.equal(f.db.listRunEndings([group])[0].continuationPending, 0);
  assert.equal(f.calls.filter(call => call[0] === 'control').length, 0);
  assert.equal(f.events.filter(event => event.event === 'continuation_cleared' && event.session_group === group).length, 1);
  await supervisor().advance(context); await f.rounds(3);
  assert.equal(launches().length, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
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
  assert.equal(f.db.listRunEndings([group])[0].continuationPending, 0);
});

// Cutover contract: the existing coordinator must clear persistent restart
// markers through the real store. Run for marker clearing/cutover changes;
// all database state is fixture-local and conversion has no filesystem side effects.
test('mode cutover clears pending restart markers through the normal coordinator', async t => {
  const f = routerFixture(t);
  const message = f.add('team');
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(message.id);
  assert.deepEqual(f.db.recordRunEnd('team', { runId: 'old-run', reason: 'unexpected' }), { recorded: true });
  f.db.recordRunEnd('origin', { runId: 'old-origin', reason: 'unexpected' });
  assert.equal(f.db.listRunEndings(['team', 'origin']).filter(row => row.continuationPending).length, 2);
  const { runId } = f.db.beginModeTransition('multi', 'single');
  f.db.setDrainFence('*');
  f.db.absorbForTransition(runId);
  const coordinator = new ModeSwitchCoordinator({ db: f.db, readMode: () => ({ mode: 'multi' }),
    convert: async () => {}, diagnostic: () => {}, now: f.now });
  await coordinator.advance();
  assert.equal(f.db.getModeTransition().phase, 'cutover');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
  assert.deepEqual(f.db.listPendingContinuations(), []);
  assert.ok(f.db.listRunEndings(['team', 'origin']).every(row => row.continuationPending === 0));
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
    reason: row.reason, continuationPending: row.continuationPending })),
  [{ sessionGroup: group, runId, reason: 'upgrade', continuationPending: 0 }]);
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

// Real Router/Store boundary with injected launch and terminal transport. Run for
// restart-marker consumption and launch delivery ordering; skip unrelated UI.
// The fixture uses memory SQLite and stops its router on teardown. No tmux,
// runtime process, PM2, network or external notification is contacted.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR.
for (const activation of ['continuation', 'inbound']) {
  test(`${activation} activation clears the marker before delivering only startup and incoming text`, async t => {
    const f = routerFixture(t); f.put('origin');
    const old = f.add('team');
    f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(old.id);
    f.db.recordRunEnd('team', { runId: 'old-run', reason: 'unexpected' });
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM control_queue').get().n, 0);
    const incoming = activation === 'inbound' ? f.add('team') : null;
    const received = [], order = [];
    const clear = f.db.clearContinuation;
    f.db.clearContinuation = (...args) => {
      const result = clear(...args);
      if (result.cleared) order.push('clear');
      return result;
    };
    const getAdapter = f.deps.getSessionAdapter;
    f.deps.getSessionAdapter = runtime => ({ ...getAdapter(runtime), launch: async input => {
      await getAdapter(runtime).launch(input);
      const prompt = f.db.insertControl('startup prompt', { sessionGroup: 'team', appendAckSuffix: false });
      f.current.get('team').startupControlIds = [prompt.id];
    } });
    const deliverControl = f.deps.deliverControl, deliverConversation = f.deps.deliverConversation;
    f.deps.deliverControl = async (row, live) => {
      received.push(row.raw_content); order.push('startup');
      return deliverControl(row, live);
    };
    f.deps.deliverConversation = async (row, live) => {
      received.push(row.content); order.push('incoming');
      return deliverConversation(row, live);
    };
    await f.create().initialize(); await f.rounds(2); f.advance(5000); await f.rounds(6);
    assert.equal(f.calls.filter(call => call[0] === 'launch' && call[1].sessionGroup === 'team').length, 1);
    assert.equal(f.db.listRunEndings(['team'])[0].continuationPending, 0);
    assert.deepEqual(order, incoming ? ['clear', 'startup', 'incoming'] : ['clear', 'startup']);
    assert.deepEqual(received, incoming ? ['startup prompt', 'body'] : ['startup prompt']);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM control_queue').get().n, 1, 'only the startup hook wrote a control row');
    if (incoming) assert.equal(f.row(incoming.id).status, 'delivered');
  });
}

// Real Router/Store boundary; startup delivery is deliberately blocked at the
// injected health transport. Run when marker lifetime or idle-ending semantics
// change, skip unrelated delivery protocols. Private memory SQLite, clock and
// scene fixtures are lifecycle-owned; there are no runtime processes or sockets.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR.
test('a health-blocked startup expires at idle TTL without another restart until new input', async t => {
  const f = routerFixture(t); f.put('origin');
  const old = f.add('team');
  f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(old.id);
  f.db.recordRunEnd('team', { runId: 'old-run', reason: 'unexpected' });
  let blocked = true;
  const getAdapter = f.deps.getSessionAdapter, deliver = f.deps.deliverControl;
  f.deps.getSessionAdapter = runtime => ({ ...getAdapter(runtime), launch: async input => {
    await getAdapter(runtime).launch(input);
    const prompt = f.db.insertControl('startup prompt', { sessionGroup: 'team', appendAckSuffix: false });
    f.current.get('team').startupControlIds = [prompt.id];
  } });
  f.deps.deliverControl = async (row, live) => {
    if (!blocked) return deliver(row, live);
    f.sqlite.prepare("UPDATE control_queue SET status='pending' WHERE id=?").run(row.id);
    return { blocked: true };
  };
  await f.create().initialize(); await f.rounds(2); f.advance(5000); await f.rounds(6);
  const launches = () => f.calls.filter(call => call[0] === 'launch' && call[1].sessionGroup === 'team');
  assert.equal(launches().length, 1);
  const firstRun = launches()[0][1].runId;
  assert.equal(f.db.listRunEndings(['team'])[0].continuationPending, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM control_queue WHERE status='pending'").get().n, 1);
  assert.equal(f.calls.filter(call => call[0] === 'control').length, 0);
  f.db.setDrainFence('team', { reason: 'ttl', runId: firstRun });
  f.db.recordRunEnd('team', { runId: firstRun, reason: 'ttl', clearFence: true });
  f.scene.delete('team'); f.current.delete('team');
  f.advance(1800000); await f.rounds(5);
  assert.equal(launches().length, 1);
  assert.equal(f.db.listRunEndings(['team'])[0].continuationPending, 0);
  assert.deepEqual(f.db.listPendingContinuations(), []);
  blocked = false;
  const incoming = f.add('team'); await f.rounds(6);
  assert.equal(launches().length, 2);
  assert.equal(f.row(incoming.id).status, 'delivered');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM control_queue').get().n, 2, 'only one startup row per actual launch');
  assert.ok(f.sqlite.prepare('SELECT raw_content FROM control_queue').all().every(row => row.raw_content === 'startup prompt'));
});
