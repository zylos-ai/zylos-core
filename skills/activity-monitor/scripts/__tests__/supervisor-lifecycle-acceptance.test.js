import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { fixture as databaseFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';

function localFixture(t, Class = SupervisorLifecycle, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, now: 1792000000000, controls: [], markerCalls: [], events: [],
    context: { configuration: { mode: 'multi' } }, marker: { held: false, stale: false, runId: null, expiresAt: null, reason: 'absent' },
    transition: null, range: { count: 20, firstAt: 1791999990000 }, backlog: { total: 60, groups: [{ count: 60, firstAt: 1791999990000 }] } };
  f.scene = { sessionGroup: 'origin', runtime: 'claude', runId: 'old-run', sessionId: 's1',
    present: true, ready: true, processRunning: true, state: 'idle', idleSince: f.now - 10000,
    runDir: root, usagePercent: 80, launchConfig: { runtime: 'claude', mode: 'default' } };
  f.db = { getModeTransition: () => f.transition, getDrainFence: () => null, listDrainFences: () => [],
    getUnsummarizedRange: () => f.range, getGlobalUnsummarizedRange: () => f.range,
    getOriginSyncBacklog: () => f.backlog,
    insertControl: (content, opts) => { f.controls.push({ content, ...opts }); return { id: f.controls.length }; },
    ...options.db };
  f.deps = { db: f.db, observeGroup: () => f.scene, observe: () => [f.scene],
    requests: { read: () => [] }, diagnostic: e => f.events.push(e),
    readSyncMarker: args => { f.markerCalls.push(args); return f.marker; },
    prompts: { GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync',
      ROTATION_PROMPT: 'rotate', CONFIG_RECLAIM_PROMPT: 'config' },
    ...options.deps };
  const configuration = f.context.configuration;
  Object.defineProperty(f, 'context', { get: () => ({ configuration, transition: f.db.getModeTransition(),
    fences: f.db.listDrainFences(), restartRequests: [], scenes: [{ ...f.scene }] }) });
  f.lifecycle = new Class(f.deps, { now: () => f.now });
  return f;
}

async function gateScenario(t, Class) {
  const sql = databaseFixture(t);
  const f = localFixture(t, Class, { db: sql.store });
  sql.db.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('transition','single','multi','gating',0,0)");
  // Keep demand facts in the fixture while D9 and every D3 write are real SQLite.
  f.db.getUnsummarizedRange = () => f.range;
  f.db.getOriginSyncBacklog = () => f.backlog;
  await f.lifecycle.checkSync([f.scene], f.context);
  assert.equal(sql.db.prepare('SELECT count(*) FROM control_queue').pluck().get(), 0, 'Sync enqueued during D9');
  sql.db.exec("UPDATE mode_transitions SET phase='complete'");
  await f.lifecycle.checkSync([f.scene], f.context);
  assert.equal(sql.db.prepare("SELECT count(*) FROM control_queue WHERE status='pending'").pluck().get(), 2);
}
test('Sync respects real and resumes group/Origin production after completion', async t => {
  await gateScenario(t, SupervisorLifecycle);
});


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


// Frozen outputs are the boundary. Raw marker contents are only used
// by the deliberately wrong existence-only consumer; no second production
// marker parser is introduced and no real provider claim is made.
async function markerScenario(t, Class, existenceOnly = false) {
  const cases = [
    ['valid', { held: true, stale: false, runId: 'old-run', expiresAt: 1792000060000, reason: 'held' }, false],
    ['expired', { held: true, stale: true, runId: 'old-run', expiresAt: 1791999999999, reason: 'expired' }, true],
    ['wrong-run', { held: true, stale: true, runId: 'previous-run', expiresAt: 1792000060000, reason: 'run_mismatch' }, true],
    ['corrupt', { held: false, stale: false, runId: null, expiresAt: null, reason: 'invalid' }, true],
  ];
  for (const [name, marker, idle] of cases) {
    const f = localFixture(t, Class);
    f.scene.sessionGroup = 'telegram:a'; f.marker = marker;
    const file = path.join(f.root, 'sync.lock'); fs.writeFileSync(file, name === 'corrupt' ? '{broken' : JSON.stringify(marker));
    if (existenceOnly) f.deps.readSyncMarker = args => { f.markerCalls.push(args); return { ...marker, held: fs.existsSync(file), stale: false }; };
    assert.equal(await f.lifecycle.idle(f.scene, f.context), idle, `marker ${name} blocked idle incorrectly`);
    assert.deepEqual(f.markerCalls, [{ runDir: f.root, kind: 'group', currentRunId: 'old-run' }]);
    await f.lifecycle.checkSync([f.scene], f.context);
    assert.equal(f.controls.length, idle ? 1 : 0);
  }
}
test('consumer accepts expired/wrong-run/corrupt marker results and blocks only valid ownership', async t => {
  await markerScenario(t, SupervisorLifecycle);
});
test('oracle: detects checking marker existence instead of its reader result', async t => {
  await assert.rejects(markerScenario(t, SupervisorLifecycle, true),
    error => error.code === 'ERR_ASSERTION' && error.message.includes('marker expired blocked idle incorrectly'));
});

async function configScenario(t, Class) {
  const target = readyTmuxTarget(t, { prefix: 'supervisor-config-f2-', mode: 'multi' });
  const store = createStore(target.db, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateModel: () => true });
  const scenes = new SupervisorScenes({ env: target.env, connectionOptions: { socketPath: target.socketPath, binary: target.binary },
    readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state: 'idle', idleSince: 1 }), readUsage: () => null });
  const old = await scenes.observeGroup('origin');
  assert.deepEqual(old.launchConfig, { runtime: 'claude', mode: 'default' });
  store.setSessionRuntimeConfig({ sessionGroup: 'origin', runtime: 'codex' });
  store.setSessionModelConfig({ sessionGroup: 'origin', runtime: 'codex', model: 'new-model', effort: 'high' });
  const expected = store.resolveSessionLaunchConfig({ sessionGroup: 'origin', sessionMode: 'multi' });
  assert.deepEqual(expected, { runtime: 'codex', mode: 'override', model: 'new-model', effort: 'high' });
  let calls = 0;
  const lifecycle = new Class({ db: store, observe: () => scenes.observe({ configuration: { mode: 'multi' } }),
    observeGroup: group => scenes.observeGroup(group), bindTarget: scene => scenes.bindTarget(scene), requests: { read: () => [] },
    prompts: { CONFIG_RECLAIM_PROMPT: (scene, desired) => { calls++; assert.deepEqual(scene.launchConfig, old.launchConfig); assert.deepEqual(desired, expected); return 'config reclaim'; } } });
  await lifecycle.reconcileConfiguration({ configuration: { mode: 'multi' }, transition: store.getModeTransition(),
    fences: store.listDrainFences(), restartRequests: [], scenes: await scenes.observe({ configuration: { mode: 'multi' } }) });
  assert.equal(calls, 1, 'new desired config hid the old running snapshot');
  const rows = target.db.prepare('SELECT * FROM control_queue').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].priority, 1);
  assert.equal(JSON.parse(rows[0].target_binding).expectedRunId, 'run-1');
  assert.deepEqual((await scenes.observeGroup('origin')).launchConfig, old.launchConfig);
  assert.equal(store.getDrainFence('origin'), null);
}
test('real running snapshot stays old after / changes and produces reclaim control', { timeout: 15000 }, async t => {
  await configScenario(t, SupervisorLifecycle);
});


async function syncScopeScenario(t, Class) {
  for (const mode of ['single', 'multi']) {
    const f = localFixture(t, Class); f.context.configuration.mode = mode;
    const insert = f.db.insertControl; let fail = true;
    f.db.insertControl = (...args) => { if (fail) throw new Error('injected write failure'); return insert(...args); };
    await assert.rejects(f.lifecycle.checkSync([f.scene], f.context), /injected write failure/);
    assert.equal(f.lifecycle.syncSent.size, 0, 'failed Sync write marked the scope sent'); assert.equal(f.lifecycle.syncRuns.size, 0);
    fail = false; f.now += 60000; await f.lifecycle.checkSync([f.scene], f.context);
    assert.deepEqual(f.markerCalls.map(c => c.kind), mode === 'single' ? ['global', 'global'] : ['group', 'group', 'origin']);
    assert.ok(f.markerCalls.every(c => c.currentRunId === 'old-run' && c.runDir === f.root));
    assert.ok(f.controls.every(c => c.sessionGroup === (mode === 'single' ? null : 'origin') && c.priority === 2 && c.appendAckSuffix === false));
    const count = f.controls.length;
    f.scene = { ...f.scene, present: false }; f.now += 600000;
    await f.lifecycle.checkSync([f.scene], f.context); assert.equal(f.controls.length, count);
  }
}
test('Sync reads all three marker scopes and failed writes do not mark a scope sent', async t => {
  await syncScopeScenario(t, SupervisorLifecycle);
});


async function rotationScenario(t, Class) {
  for (const mode of ['single', 'multi']) {
    const f = localFixture(t, Class); f.context.configuration.mode = mode;
    await f.lifecycle.checkRotation(f.scene, f.context);
    f.now += 299999; await f.lifecycle.checkRotation(f.scene, f.context); assert.equal(f.controls.length, 1);
    f.now++; await f.lifecycle.checkRotation(f.scene, f.context); assert.equal(f.controls.length, 2);
    f.scene.sessionId = 's2'; await f.lifecycle.checkRotation(f.scene, f.context); assert.equal(f.controls.length, 3, 'session identity change inherited old rotation cooldown');
    f.scene.runId = 'new-run'; await f.lifecycle.checkRotation(f.scene, f.context); assert.equal(f.controls.length, 4);
    f.scene.sessionId = 's3'; const insert = f.db.insertControl;
    f.db.insertControl = () => { throw new Error('rotation write failed'); };
    await assert.rejects(f.lifecycle.checkRotation(f.scene, f.context), /rotation write failed/);
    f.db.insertControl = insert; await f.lifecycle.checkRotation(f.scene, f.context); assert.equal(f.controls.length, 5);
    assert.ok(f.controls.every(c => c.sessionGroup === (mode === 'single' ? null : 'origin') && c.bypassState === true && c.appendAckSuffix === false));
    assert.equal(f.events.filter(e => e.event === 'rotate_done').length, 0);
    f.scene.present = false; f.now += 300000;
    await f.lifecycle.checkRotation(f.scene, f.context); assert.equal(f.controls.length, 5);
  }
}
test('rotation scope, exact cooldown boundary, run/session identity and failed write retry', async t => {
  await rotationScenario(t, SupervisorLifecycle);
});
