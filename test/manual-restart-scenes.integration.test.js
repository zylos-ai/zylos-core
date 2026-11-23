import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { fixture, launch, manual, assertReply } from './fixtures/manual-restart-harness.js';
import { tmuxNameForGroup, groupRunDir } from '../cli/lib/session-group-paths.js';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createSupervisor } from '../skills/activity-monitor/scripts/supervisor.js';
import { RestartRequestStore } from '../skills/activity-monitor/scripts/restart-request-store.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
const Database = createRequire(new URL('../skills/comm-bridge/package.json', import.meta.url))('better-sqlite3');

// Boundary: real entry admission, F9 and exact runtime identity. Run for manual
// request identity/compatibility changes; skip unrelated lifecycle behavior.
// Require runner-isolated HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, a private -S
// tmux socket and temporary C4; child/fixture cleanup closes all resources.
for (const mode of ['single', 'multi']) test(`${mode} actual tmux server restart and reused Origin name cannot redirect accepted intent`, { timeout: 25000 }, async t => {
  const f = fixture(t, mode), m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
  const req = manual('server-replaced', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'accepted');
  f.tmux('kill-server'); await f.waitForServerExit();
  f.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-origin', '-e', 'ZYLOS_RUN_ID=replacement', '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', '-e', 'ZYLOS_SESSION_GROUP=origin', path.join(f.root, 'claude'), '120');
  f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
  fs.writeFileSync(f.readyPath, JSON.stringify({ ...f.ready, runId: 'replacement', sessionId: 'replacement-session' }));
  const state = await m4.command('tick'); assert.equal(state.scene.runId, 'replacement'); assert.equal(state.scene.present, true);
  assert.deepEqual(state.requests, []); assert.deepEqual(state.fences, []); assert.deepEqual(state.stopped, []);
  assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper')); await m4.stop();
});

for (const runtime of ['claude', 'codex']) test(`${runtime} stopping Origin leaves real ready ordinary runtime and its ledger untouched`, { timeout: 25000 }, async t => {
  const f = fixture(t, 'multi', runtime), group = 'fixture:ordinary', name = tmuxNameForGroup(group);
  const directory = groupRunDir(group, f.env); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'current-session.json'), JSON.stringify({ runId: 'ordinary-run', sessionId: 'ordinary-session', ts: 1, startupControlIds: [] }));
  f.tmux('new-session', '-d', '-s', name, '-e', 'ZYLOS_RUN_ID=ordinary-run', '-e', `ZYLOS_SESSION_GROUP=${group}`, '-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify({ runtime, mode: 'default' })}`, path.join(f.root, runtime), '120');
  const pid = f.tmux('display-message', '-p', '-t', `${name}:`, '#{pane_pid}');
  f.db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','fixture','ordinary pending','pending',?)").run(group);
  const before = f.db.prepare('SELECT * FROM conversations').all();
  const m4 = launch(t, f); assert.equal((await m4.next()).ready, true);
  const req = manual('only-origin', { expectedRunId: 'run-1' }); assertReply(await f.submit(req), req, 'accepted');
  const state = await m4.command('tick'); assert.equal(state.scene.present, false); assert.equal(state.stopped.length, 1); assert.equal(state.stopped[0].runId, 'run-1');
  assert.equal(f.tmux('display-message', '-p', '-t', `${name}:`, '#{pane_pid}'), pid);
  assert.equal(f.tmux('show-environment', '-t', `=${name}`, 'ZYLOS_RUN_ID'), 'ZYLOS_RUN_ID=ordinary-run');
  assert.deepEqual(f.db.prepare('SELECT * FROM conversations').all(), before); await m4.stop();
});

async function healthGuardFixture(t, mode = 'multi') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-health-'));
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: root };
  delete env.TMUX;
  fs.mkdirSync(env.TMPDIR);
  fs.mkdirSync(path.join(root, 'activity-monitor'));
  const sqlite = new Database(':memory:');
  guardDatabase(sqlite, schema);
  const config = { mode, runtime: 'claude', capacity: 4 };
  const store = createStore(sqlite, { readConfig: () => ({ state: 'ok', config: { session_mode: mode, runtime: 'claude' } }) });
  const requestStore = new RestartRequestStore({ file: path.join(root, 'activity-monitor/restart-requests.json') });
  const stopped = [], controls = [];
  const groups = mode === 'single' ? ['origin'] : ['fixture:a', 'fixture:b', 'origin'];
  const scenes = new Map(groups.map((sessionGroup, i) => {
    const runDir = groupRunDir(sessionGroup, env);
    fs.mkdirSync(runDir, { recursive: true });
    return [sessionGroup, { sessionGroup, runtime: 'claude', runId: `run-${i}`, sessionId: `session-${i}`,
      present: true, ready: true, processRunning: true, state: 'idle', idleSince: 0, runDir }];
  }));
  const snapshot = () => [...scenes.values()].map(scene => ({ ...scene }));
  const supervisor = createSupervisor({ env, zylosDir: root, now: () => 1000000,
    db: { ...store, insertControl: (content, options) => { controls.push({ content, ...options }); return { id: controls.length }; } },
    scenes: { observe: async () => snapshot(),
      readIdentity: async group => ({ ...scenes.get(group) }), observeGroup: async group => ({ ...scenes.get(group) }),
      bindTarget: async scene => ({ sessionGroup: scene.sessionGroup, expectedRunId: scene.runId }),
      stop: async scene => { stopped.push(scene.sessionGroup); Object.assign(scenes.get(scene.sessionGroup), { present: false, ready: false, processRunning: false }); },
      listRuns: async () => [], readRun: async group => ({ ...scenes.get(group) }) },
    requestStore, readMode: () => ({ mode }), readConfiguration: () => config,
    resolveTargetRuntime: () => 'claude', readSyncMarker: () => ({ held: false, stale: false }),
    prompts: {}, checkAuth: async () => ({ status: 'success' }),
    loopOptions: { schedule: () => assert.fail('fixture must not start a background loop'), cancel() {} }, log() {},
  });
  t.after(async () => { await supervisor.stop(); sqlite.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.ok(root.startsWith(process.env.TMPDIR + path.sep));
  assert.notEqual(root, process.env.HOME);
  console.log(JSON.stringify({ HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME,
    TMPDIR: env.TMPDIR, TMUX_TMPDIR: env.TMUX_TMPDIR, TMUX: env.TMUX ?? null, database: ':memory:', tmux: 'not used' }));
  await supervisor.loop.deps.readConfiguration(null);
  return { root, env, supervisor, store, requestStore, stopped, controls, scenes, snapshot, config,
    pendingA: () => requestStore.write([{ requestId: 'pending-a', reason: 'manual_restart', acceptedAt: 1,
      runIds: ['run-0'], mode: 'multi', expectedRunId: 'run-0', sessionGroup: 'fixture:a' }]) };
}

for (const action of ['stop', 'nudge']) {

  // Boundary: actual health stop/nudge guards match the pending manual row's
  // target before any side effect. Run for group-target mutex changes; skip
  // unrelated lifecycle work. Fresh runner HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR,
  // private F9/health files, in-memory SQLite and fixture terminal providers only;
  // no tmux, services, network or children. Stop supervisor/DB then clean fixture.
  test(`health guard ${action} blocks the pending manual target while other groups and Origin proceed`, { timeout: 2000 }, async t => {
    const f = await healthGuardFixture(t); f.pendingA();
    const act = scene => action === 'stop' ? f.supervisor.observer.stop(scene) : f.supervisor.observer.nudge(scene, async () => true);
    const blocked = await act(f.scenes.get('fixture:a'));
    assert.equal(action === 'stop' ? blocked : blocked.ok, false);
    assert.equal(f.stopped.length, 0); assert.equal(f.controls.length, 0);
    for (const group of ['fixture:b', 'origin']) {
      const result = await act(f.scenes.get(group));
      assert.equal(action === 'stop' ? result : result.ok, true);
    }
    if (action === 'stop') assert.deepEqual(f.stopped, ['fixture:b', 'origin']);
    else assert.deepEqual(f.controls.map(control => ({ group: control.sessionGroup, content: control.content })), [
      { group: 'fixture:b', content: '[KEYSTROKE]Escape' }, { group: 'fixture:b', content: 'continue' },
      { group: 'origin', content: '[KEYSTROKE]Escape' }, { group: 'origin', content: 'continue' },
    ]);
    assert.equal(f.scenes.get('fixture:a').present, true);
    assert.equal(f.requestStore.read()[0].sessionGroup, 'fixture:a');
  });
}
