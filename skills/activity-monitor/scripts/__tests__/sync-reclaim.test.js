import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { captureSyncTarget, observeSyncCompletion } from '../sync-reclaim.js';
import { fixture as c4Fixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { groupMemoryDir } from '../../../../cli/lib/session-group-paths.js';
import { SYNC_BACKLOG_ALERT } from '../../../zylos-memory/scripts/sync-prompts.js';
import { recordSyncResult } from '../../../../cli/lib/sync-observability.js';

// Boundary: real lifecycle, completion proofs, state parser and private SQLite
// checkpoints/cursors; deterministic control delivery and scene observation.
// Run for pre-reclaim retry/proof changes; skip unrelated UI/runtime work.
// Official runner isolates imports; every file belongs to a private fixture,
// DB is in memory, and there are no sockets, tmux, PM2, network or background
// loops. t.after closes SQLite and removes the fixture tree.
function fixture(t, route = 'release', group = 'chat:room') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'z'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(env[key].startsWith(root + path.sep)); fs.mkdirSync(env[key], { recursive: true });
  }
  t.diagnostic(JSON.stringify({ paths: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, env[key]])),
    database: ':memory:', tmux: 'unused' }));
  let now = 1_800_000_000_000, lastActivity = 0;
  const { store } = c4Fixture(t, { now: () => now });
  const seed = () => store.insertConversation('out', 'chat', 'fixture', 'fixture output', { groupName: 'room' });
  const first = seed(), end = seed().id;
  const controls = [], events = [], fences = new Map(), stopped = [];
  let held = false;
  const scene = { sessionGroup: group, runId: 'fixture-run', sessionId: 'fixture-session', runtime: 'claude',
    present: true, ready: true, processRunning: true, createdAt: 0, state: 'idle', idleSince: 0, turnOpen: false,
    runDir: path.join(root, 'run'), launchConfig: { runtime: 'claude', mode: 'default' } };
  const db = { ...store,
    getLastActivity: () => ({ ts: lastActivity }),
    getControlById: id => controls.find(row => row.id === id),
    insertControl: (content, options) => {
      const row = { id: controls.length + 1, content, ...options, status: 'pending' }; controls.push(row); return row;
    },
    getDrainFence: scope => fences.get(scope) ?? null,
    listDrainFences: () => [...fences.values()],
    setDrainFence: (scope, fence) => fences.set(scope, { sessionGroup: scope, ...fence }),
    clearDrainFence: scope => fences.delete(scope),
    resolveSessionLaunchConfig: () => scene.launchConfig,
    countRunningConversations: () => 0, countNonTerminalControls: () => ({ running: 0, runningWithoutDeadline: 0 }),
    recordRunEnd: () => ({ recorded: true }),
  };
  const deps = { db, env, observeGroup: () => scene, bindTarget: () => ({ expectedRunId: scene.runId }),
    readSyncMarker: () => ({ held, stale: false }), diagnostic: row => events.push(row),
    requests: { read: () => [] }, stop: () => { stopped.push(scene.runId); scene.processRunning = false; },
    prompts: { PRE_RECLAIM_CHECK_PROMPT: 'check', PRE_RECLAIM_SYNC_PROMPT: 'sync', PRE_RECLAIM_ORIGIN_SYNC_PROMPT: 'origin sync',
      SYNC_BACKLOG_ALERT: (kind, count, lag, scope, type, details) => `${type}:${details.reason}` } };
  const lifecycle = new SupervisorLifecycle(deps, { now: () => now });
  const context = () => ({ configuration: { mode: 'multi', hotTtlSeconds: 1 }, scenes: [scene],
    transition: null, fences: [...fences.values()], restartRequests: [] });
  const tick = () => route === 'release' ? lifecycle.advanceReleases(context()) : lifecycle.checkTtl(scene, context());
  const start = async () => { if (route === 'release') await lifecycle.requestRelease(scene, context()); await tick(); };
  const state = coverage => {
    const directory = groupMemoryDir(group, env); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'state.md'), `<!-- zylos-state v1 | scope=${group} | synced_at=2026-11-17T00:00:00Z | coverage=${coverage} | inbox_committed= -->\n`);
  };
  return { env, scene, db, store, controls, events, fences, stopped, lifecycle, deps, context, tick, start, state, first: first.id, end,
    settle: () => { for (const row of controls) row.status = 'done'; },
    advance: ms => { now += ms; }, time: () => now, marker: value => { held = value; },
    newWork: async () => { lastActivity = ++now; await lifecycle.workDelivered({ sessionGroup: group, runId: scene.runId, pastedAt: now }); },
    syncs: () => controls.filter(row => row.content.startsWith('sync') || row.content === 'origin sync'),
    alerts: () => events.filter(row => row.event === 'sync_alert' && row.type === 'repair_failed') };
}

for (const route of ['release', 'ttl']) {
  test(`${route} retries acknowledged Sync without a checkpoint and reclaims after persistent proof`, async t => {
    const f = fixture(t, route); await f.start(); f.settle();
    await f.tick(); assert.equal(f.fences.size, 0); assert.equal(f.syncs().length, 2);
    const retry = f.syncs()[1]; assert.equal(retry.ackDeadlineAt - retry.createdAt, 900);
    assert.match(retry.content, /authorizes the worker.*no new conversations/);
    f.store.createCheckpoint(f.scene.sessionGroup, f.end, 'committed summary'); f.state(f.end); f.settle();
    await f.tick(); assert.equal(f.fences.get(f.scene.sessionGroup)?.reason, route);
    assert.equal(f.alerts().length, 0); assert.equal(f.syncs().length, 2);
  });

  test(`${route} requires checkpoint coverage through the original trigger end`, async t => {
    const f = fixture(t, route); await f.start();
    f.store.createCheckpoint(f.scene.sessionGroup, f.first, 'partial summary'); f.state(f.first); f.settle();
    await f.tick(); assert.equal(f.fences.size, 0); assert.equal(f.syncs().length, 2);
    f.store.createCheckpoint(f.scene.sessionGroup, f.end, 'remaining summary'); f.state(f.end); f.settle();
    await f.tick(); assert.equal(f.fences.size, 1); assert.equal(f.alerts().length, 0);
  });

  test(`${route} retry can repair state for the checkpoint already published by the first attempt`, async t => {
    const f = fixture(t, route); await f.start();
    f.store.createCheckpoint(f.scene.sessionGroup, f.end, 'summary'); f.state(f.first); f.settle();
    await f.tick(); assert.equal(f.syncs().length, 2); assert.equal(f.fences.size, 0);
    f.state(f.end); f.settle(); await f.tick(); assert.equal(f.fences.size, 1); assert.equal(f.alerts().length, 0);
  });

  for (const reason of ['no_checkpoint', 'state_uncommitted', 'INPUT_CHANGED']) {
    test(`${route} reclaims after two failed Sync attempts with one ${reason} repair alert`, async t => {
      const f = fixture(t, route); await f.start(); f.settle(); await f.tick();
      if (reason === 'state_uncommitted') { f.store.createCheckpoint(f.scene.sessionGroup, f.end, 'summary'); f.state(f.first); }
      if (reason === 'INPUT_CHANGED') {
        recordSyncResult({ kind: 'group', scope: f.scene.sessionGroup, runId: f.scene.runId, status: 'error', code: reason },
          { env: f.env, now: f.time() });
      }
      f.settle(); await f.tick();
      assert.equal(f.fences.size, 1); assert.equal(f.syncs().length, 2);
      assert.equal(f.alerts().length, 1); assert.equal(f.alerts()[0].reason, reason);
      await f.tick(); assert.equal(f.alerts().length, 1); assert.equal(f.syncs().length, 2);
    });
  }

  test(`${route} bounds both held-marker attempts and reclaims after the retry deadline`, async t => {
    const f = fixture(t, route); await f.start(); f.controls[0].status = 'done'; f.marker(true);
    f.advance(899999); await f.tick(); assert.equal(f.syncs().length, 1);
    f.advance(1); await f.tick(); assert.equal(f.syncs().length, 2); assert.equal(f.fences.size, 0);
    f.advance(900000); await f.tick(); assert.equal(f.fences.size, 1);
    assert.equal(f.alerts().length, 1); assert.equal(f.alerts()[0].reason, 'control_timeout');
    assert.equal(await f.lifecycle.advanceReclaim(f.fences.get(f.scene.sessionGroup), f.context()), 'done');
    assert.equal(f.stopped.length, 1);
  });

  test(`${route} cancels preparation when real work arrives during retry`, async t => {
    const f = fixture(t, route); await f.start(); f.settle(); await f.tick();
    await f.newWork(); f.settle(); await f.tick(); assert.equal(f.fences.size, 0); assert.equal(f.alerts().length, 0);
    assert.equal((route === 'release' ? f.lifecycle.releasePreparation : f.lifecycle.ttlPreparation).size, 0);
  });
}

test('late delivery of the original release Sync control does not cancel its retry', async t => {
  const f = fixture(t); await f.start(); f.settle(); const original = f.syncs()[0]; await f.tick();
  await f.lifecycle.workDelivered({ sessionGroup: f.scene.sessionGroup, runId: f.scene.runId, controlId: original.id, pastedAt: f.time() });
  assert.equal(f.lifecycle.releasePreparation.size, 1);
});

test('completion proof rejects an old checkpoint while resolved-episode proof may use it', async t => {
  const f = fixture(t); f.store.createCheckpoint(f.scene.sessionGroup, f.end, 'existing summary'); f.state(f.end);
  const target = await captureSyncTarget({ db: f.db, scene: f.scene });
  assert.equal(target.end, f.end, 'missing range uses the real delivered frontier');
  const options = { db: f.db, scene: f.scene, target, env: f.env, readSyncMarker: f.deps.readSyncMarker };
  assert.equal((await observeSyncCompletion(options)).reason, 'no_checkpoint');
  assert.equal((await observeSyncCompletion({ ...options, requireNewCheckpoint: false })).ok, true);
});

test('Origin preparation accepts durable cursor progress from a bounded round with backlog remaining', async t => {
  const f = fixture(t, 'release', 'origin'); await f.start();
  assert.equal(f.syncs().length, 1); assert.equal(f.syncs()[0].content, 'origin sync');
  f.store.advanceOriginSyncCursor('chat:room', { syncedId: f.first, checkpointId: 0 });
  assert.ok(f.store.getOriginSyncBacklog().total > 0);
  f.settle(); await f.tick(); assert.equal(f.fences.size, 1); assert.equal(f.alerts().length, 0);
});

test('Origin preparation retries an acknowledged round with no durable cursor progress', async t => {
  const f = fixture(t, 'release', 'origin'); await f.start(); f.settle(); await f.tick();
  assert.equal(f.syncs().length, 2); assert.equal(f.fences.size, 0);
  f.store.advanceOriginSyncCursor('chat:room', { syncedId: f.first, checkpointId: 0 });
  f.settle(); await f.tick(); assert.equal(f.fences.size, 1); assert.equal(f.alerts().length, 0);
});


test('exhausted pre-reclaim repair tells owner the actual retry method and failed proof', async t => {
  const f = fixture(t); f.deps.prompts.SYNC_BACKLOG_ALERT = SYNC_BACKLOG_ALERT;
  await f.start(); f.settle(); await f.tick(); f.settle(); await f.tick();
  const notice = f.controls.find(row => row.content.startsWith('Memory Sync alert:'));
  assert.ok(notice);
  assert.match(notice.content, /pre-reclaim Sync plus one retry; failed because no_checkpoint/);
  assert.match(notice.content, /Action: Ask the agent to rerun Sync for this scope and verify a covering checkpoint and committed state/);
  assert.equal(f.alerts()[0].repairAttempt, 'pre_reclaim_retry');
});
