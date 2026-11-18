import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture as databaseFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { getMaxConversationId } from '../skills/comm-bridge/scripts/c4-db.js';
import { GlobalMemoryHandoverCoordinator } from '../skills/activity-monitor/scripts/global-memory-handover.js';
import { withMemoryLock } from '../skills/zylos-memory/scripts/sync-lock.js';
import { appendInbox } from '../skills/zylos-memory/scripts/memory-append.js';

const worker = fileURLToPath(new URL('../skills/activity-monitor/scripts/__tests__/fixtures/global-memory-handover-worker.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-integration-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const { db, store, filename } = databaseFixture(t, {}, true);
  const memory = path.join(root, 'memory'); fs.mkdirSync(memory);
  fs.writeFileSync(path.join(memory, 'state.md'), 'old single working state');
  fs.writeFileSync(path.join(memory, 'inbox.md'), 'global inbox');
  db.prepare("INSERT INTO mode_transitions(run_id,kind,source_mode,target_mode,phase,cutoff,created_at,updated_at) VALUES('old-single','switch','multi','single','complete',0,100,101)").run();
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group) VALUES(8,'in','test','a','old message','delivered','group-a')").run();
  db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status,session_group) VALUES(19,'in','test','b','origin message','delivered','origin')").run();
  db.prepare("INSERT INTO checkpoints(start_conversation_id,end_conversation_id,summary,session_group) VALUES(1,8,'old summary','*')").run();
  const api = { ...store, getMaxConversationId: () => getMaxConversationId(db) };
  const deps = { zylosDir: root, db: api, readMode: () => ({ keyPresent: true, mode: 'multi' }),
    readRequests: () => [], legacyPresent: () => false, observe: () => [] };
  const snapshot = () => Object.fromEntries(['mode_transitions', 'drain_fences', 'conversations', 'checkpoints', 'origin_sync_cursors', 'run_endings'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  return { root, memory, db, store, filename, deps, snapshot, owner: () => new GlobalMemoryHandoverCoordinator(deps) };
}

// Boundary: installation-template classification through real C4 and memory
// append. Run when archive-only rules or template installation change; no
// runtime or external service is started. The two independent branches are
// exclusive Origin-state installation and optional daily-record fact append.
for (const [originExists, daily] of [[false, false], [true, true]]) {
  test(`installation template archives without delivery with Origin state ${originExists} and daily records ${daily}`, async t => {
    const f = fixture(t), before = f.snapshot();
    const template = fs.readFileSync(new URL('../templates/memory/state.md', import.meta.url), 'utf8');
    fs.writeFileSync(path.join(f.memory, 'state.md'), template);
    fs.unlinkSync(path.join(f.memory, 'inbox.md'));
    const origin = path.join(f.memory, 'session-groups/origin');
    fs.mkdirSync(origin, { recursive: true });
    if (originExists) fs.writeFileSync(path.join(origin, 'state.md'), 'preserved Origin state');
    fs.writeFileSync(path.join(origin, 'inbox.md'), 'preserved Origin inbox\n');
    fs.writeFileSync(path.join(origin, 'handoff.md'), 'preserved Origin handoff');
    if (daily) {
      fs.mkdirSync(path.join(f.memory, 'sessions'));
      fs.writeFileSync(path.join(f.memory, 'sessions/old.md'), 'daily history');
    }
    const owner = f.owner(), plan = await owner.advance();
    assert.equal(plan.rule, 2); assert.equal(plan.deliver, false); assert.equal(plan.interval, undefined);
    assert.equal(owner.pending(), false);
    const archive = path.join(f.memory, 'mode-switch', plan.id, 'previous/_global');
    assert.equal(fs.readFileSync(path.join(archive, 'state.md'), 'utf8'), template);
    assert.equal(fs.existsSync(path.join(archive, '.done')), true);
    assert.equal(fs.readFileSync(path.join(origin, 'state.md'), 'utf8'),
      originExists ? 'preserved Origin state' : template.replace('scope=*', 'scope=origin'));
    assert.equal(fs.readFileSync(path.join(origin, 'handoff.md'), 'utf8'), 'preserved Origin handoff');
    const inbox = fs.readFileSync(path.join(origin, 'inbox.md'), 'utf8');
    assert.doesNotMatch(inbox, /commitment:|onboarding|installation template/);
    if (daily) {
      assert.match(inbox, /^preserved Origin inbox\n/);
      assert.equal([...inbox.matchAll(/ fact: /g)].length, 1);
      assert.match(inbox, /daily records remain at/); assert.match(inbox, /not moved/);
      assert.equal(fs.readFileSync(path.join(f.memory, 'sessions/old.md'), 'utf8'), 'daily history');
    } else assert.equal(inbox, 'preserved Origin inbox\n');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
    assert.deepEqual(f.snapshot(), before);
    await owner.advance();
    assert.equal(fs.readFileSync(path.join(origin, 'inbox.md'), 'utf8'), inbox);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
  });
}

for (const point of ['before-plan', 'plan', 'rename', 'append', 'enqueue']) test(`actual SIGKILL after ${point} recovers through real C4 and memory append without transition writes`, async t => {
  const f = fixture(t), before = f.snapshot();
  const crashed = spawnSync(process.execPath, [worker, f.root, f.filename, point], { encoding: 'utf8', timeout: 10000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const dirs = fs.readdirSync(path.join(f.memory, 'mode-switch')); assert.equal(dirs.length, 1);
  const id = dirs[0], archive = path.join(f.memory, 'mode-switch', id, 'previous/_global');
  assert.equal(fs.existsSync(path.join(archive, '.done')), false);
  const planPath = path.join(f.memory, 'mode-switch', id, 'plan.json'); const saved = point === 'before-plan' ? null : fs.readFileSync(planPath, 'utf8');
  if (saved) assert.deepEqual(JSON.parse(saved).interval, { B: 8, M: 19 });
  const owner = f.owner(); assert.equal(owner.pending(), true); const plan = await owner.advance();
  assert.equal(plan.id, id); assert.equal(owner.pending(), false); if (saved) assert.equal(fs.readFileSync(planPath, 'utf8'), saved);
  assert.deepEqual(plan.interval, { B: 8, M: 19 });
  assert.equal(fs.existsSync(path.join(archive, '.done')), true);
  assert.equal(fs.readFileSync(path.join(archive, 'state.md'), 'utf8'), 'old single working state');
  assert.equal(fs.readFileSync(path.join(archive, 'inbox.md'), 'utf8'), 'global inbox');
  const inbox = fs.readFileSync(path.join(f.memory, 'session-groups/origin/inbox.md'), 'utf8');
  assert.match(inbox, /C4 interval \(8, 19\]/);
  assert.equal([...inbox.matchAll(/commitment:/g)].length, ['append', 'enqueue'].includes(point) ? 2 : 1);
  const controls = f.db.prepare("SELECT * FROM control_queue WHERE status='pending'").all();
  assert.equal(controls.length, 1); assert.equal(controls[0].session_group, 'origin');
  assert.equal(controls[0].target_binding, null); assert.equal(controls[0].priority, 2); assert.equal(controls[0].ack_deadline_at, null);
  assert.doesNotMatch(controls[0].content, /ack via/); assert.match(controls[0].content, new RegExp(id.replaceAll('.', '\\.')));
  assert.deepEqual(f.snapshot(), before);
});

test('real Origin memory lock timeout preserves pending handover and next pass resumes', async t => {
  const f = fixture(t), events = []; f.deps.waitMs = 20; f.deps.diagnostic = event => events.push(event);
  let release, acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const held = withMemoryLock(path.join(f.root, 'activity-monitor/session-groups/origin'), async () => {
    acquired(); await new Promise(resolve => { release = resolve; });
  });
  await ready;
  try {
    const owner = f.owner(), result = await owner.advance(); assert.equal(result.code, 'LOCK_TIMEOUT');
    assert.equal(events.at(-1).event, 'global_memory_handover_failed'); assert.equal(owner.pending(), true);
  } finally { release(); await held; }
  f.deps.waitMs = 1000;
  assert.equal((await f.owner().advance()).rule, 3); assert.equal(f.owner().pending(), false);
});

test('handover and ordinary concurrent Origin append share lock and preserve complete entries', async t => {
  const f = fixture(t); const env = { ZYLOS_DIR: f.root, ZYLOS_SESSION_GROUP: 'origin' };
  const results = await Promise.all([f.owner().advance(), appendInbox({ kind: 'fact', content: 'ordinary Origin entry', env })]);
  assert.equal(results[0].rule, 3);
  const inbox = fs.readFileSync(path.join(f.memory, 'session-groups/origin/inbox.md'), 'utf8');
  assert.equal([...inbox.matchAll(/commitment:/g)].length, 1); assert.equal([...inbox.matchAll(/fact: ordinary Origin entry/g)].length, 1);
  assert.equal(inbox.split('\n').filter(line => line.startsWith('- ')).length, 2);
});

test('composed supervisor defers global handover then socket switch and immediate cancellation succeed', async () => {
  const { startSupervisor } = await import('../skills/activity-monitor/scripts/supervisor-main.js');
  const { submit } = await import('../cli/lib/am-sock-client.js');
  // Keep this private socket below the Unix path limit even when the runner's
  // temporary root is deeply nested. No tmux or PM2 process is started.
  const root = fs.mkdtempSync('/tmp/gmh-'), cleanup = [];
  const { db, store } = databaseFixture({ after: fn => cleanup.push(fn) }, {}, path.join(root, 'c4.db'));
  const memory = path.join(root, 'memory'), configFile = path.join(root, 'config.json');
  fs.mkdirSync(memory);
  fs.writeFileSync(path.join(memory, 'state.md'), 'global work awaiting handover');
  fs.writeFileSync(path.join(memory, 'inbox.md'), 'global commitment');
  fs.writeFileSync(configFile, '{"runtime":"claude","session_mode":"multi"}\n');
  const configBytes = fs.readFileSync(configFile);
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const readMode = () => ({ keyPresent: true, mode: readConfig().session_mode });
  const socketPath = path.join(root, 'activity-monitor/am.sock');
  const snapshot = () => Object.fromEntries(['mode_transitions', 'drain_fences', 'conversations', 'checkpoints', 'origin_sync_cursors', 'run_endings'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  let legacy = true, service;
  try {
    db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('in','test','a','already delivered','delivered','group-a')").run();
    const before = snapshot();
    service = await startSupervisor({ env: { ...process.env, HOME: root, ZYLOS_DIR: root },
      db: { ...store, getDb: () => db, getMaxConversationId: () => getMaxConversationId(db) },
      readMode, readConfig, legacyPresent: () => legacy, resolveTargetRuntime: () => 'claude',
      checkAuth: async () => ({ status: 'authenticated' }),
      scenes: { observe: async () => [], observeGroup: async () => ({ present: false }),
        readIdentity: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null },
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
      loopOptions: { schedule: () => 1, cancel() {} }, readSyncMarker: () => ({ held: false, stale: false }),
      writeMode: () => { throw new Error('configuration write forbidden before acceptance/cancellation'); },
      restartDispatcherConfirmation: { advance: () => { throw new Error('dispatcher restart forbidden'); } },
      sendAlert: () => { throw new Error('external notification forbidden'); }, log() {},
    });
    assert.equal(service.server.listening, true);
    assert.equal(service.supervisor.globalMemoryHandover.pending(), true);
    assert.equal(fs.readFileSync(path.join(memory, 'state.md'), 'utf8'), 'global work awaiting handover');
    assert.deepEqual(snapshot(), before);
    const rejected = await submit({ version: 1, type: 'mode_switch', requestId: 'global-work-pending', target: 'single' }, { socketPath });
    assert.equal(rejected.kind, 'rejected'); assert.equal(rejected.reply.ok, false);
    assert.equal(rejected.reply.code, 'global_memory_pending'); assert.deepEqual(snapshot(), before);

    legacy = false;
    await service.supervisor.loop.tick();
    assert.equal(service.supervisor.globalMemoryHandover.pending(), false);
    const inbox = fs.readFileSync(path.join(memory, 'session-groups/origin/inbox.md'), 'utf8');
    assert.match(inbox, /commitment: Global memory handover gm-/);
    const pending = db.prepare("SELECT * FROM control_queue WHERE status='pending'").all();
    assert.equal(pending.length, 1); assert.equal(pending[0].session_group, 'origin');
    assert.equal(pending[0].target_binding, null); assert.equal(pending[0].ack_deadline_at, null);
    assert.deepEqual(snapshot(), before); assert.deepEqual(fs.readFileSync(configFile), configBytes);

    const accepted = await submit({ version: 1, type: 'mode_switch', requestId: 'after-global-handover', target: 'single' }, { socketPath });
    assert.equal(accepted.kind, 'accepted'); assert.equal(accepted.reply.ok, true); assert.equal(accepted.reply.result, 'accepted');
    assert.equal(store.getModeTransition().phase, 'gating');
    const cancelled = await submit({ version: 1, type: 'mode_switch_cancel', requestId: 'cancel-before-next-tick', runId: accepted.reply.runId }, { socketPath });
    assert.equal(cancelled.kind, 'accepted'); assert.equal(cancelled.reply.ok, true); assert.equal(cancelled.reply.result, 'cancelled');
    assert.equal(store.getModeTransition(), null); assert.deepEqual(store.listDrainFences(), []);
    assert.equal(store.getModeTransition({ runId: accepted.reply.runId }).phase, 'cancelled');
    assert.deepEqual(fs.readFileSync(configFile), configBytes);
  } finally {
    if (service) { await service.stop(); assert.equal(service.server.listening, false); }
    for (const close of cleanup.reverse()) close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Boundary: real environment decoding, target observation, scene projection and
// handover coordinator, with private C4/files. The bounded connection returns
// environment readback instead of contacting tmux. These cases prove the
// environment-to-scene contract, not observation of a real running runtime.
for (const scoped of [true, false]) test(`observed single Origin environment ${scoped ? 'with group permits handover' : 'without group defers handover'}`, async t => {
  const { SupervisorScenes } = await import('../skills/activity-monitor/scripts/supervisor-scenes.js');
  const { observeSessionTarget } = await import('../cli/lib/runtime/session-target.js');
  const f = fixture(t), before = f.snapshot();
  const environment = String.raw`ZYLOS_RUN_ID="observed-origin-run"; export ZYLOS_RUN_ID;
ZYLOS_MODEL_CONFIG="{\"runtime\":\"claude\"}"; export ZYLOS_MODEL_CONFIG;` +
    (scoped ? '\nZYLOS_SESSION_GROUP="origin"; export ZYLOS_SESSION_GROUP;' : '');
  let opens = 0, closes = 0, observations = 0;
  const scenes = new SupervisorScenes({ env: { ZYLOS_DIR: f.root }, readMode: () => ({ keyPresent: true, mode: 'single' }),
    readUsage: () => null, readActivity: () => ({ state: 'idle', idleSince: 1 }),
    readProcessTree: () => { throw new Error('configured environment must not scan host processes'); },
    open: async () => {
      opens++;
      let commands = 0;
      return { bindTarget() {}, close() { closes++; }, command: async argv => {
        assert.ok(++commands <= 3, 'one observation and its revalidation have bounded readback');
        if (argv[0] === 'display-message') return '100:200\t$1\t%1\t123\t10';
        assert.equal(argv[0], 'show-environment'); assert.ok(argv.includes('-s'));
        return environment;
      } };
    },
    observeTarget: options => {
      observations++;
      // Keep the real target's connection binding so observeGroup also runs
      // its normal identity revalidation. No sourceScope is supplied here.
      return observeSessionTarget({ ...options,
        readReady: async () => ({ runId: 'observed-origin-run', sessionId: 'observed-origin-session', ts: 1, startupControlIds: [] }) });
    },
  });
  const observed = await scenes.observeGroup('origin');
  assert.equal(observed.present, true); assert.equal(observed.ready, true);
  assert.equal(observed.sessionGroup, 'origin');
  assert.equal(observed.sourceScope, scoped ? 'origin' : null);
  f.deps.readMode = () => ({ keyPresent: true, mode: 'single' });
  f.deps.observe = async () => [await scenes.observeGroup('origin')];
  const owner = f.owner(), result = await owner.advance();
  assert.deepEqual(f.snapshot(), before);
  if (scoped) {
    assert.equal(result.rule, 3); assert.equal(owner.pending(), false);
    assert.match(fs.readFileSync(path.join(f.memory, 'session-groups/origin/inbox.md'), 'utf8'), /commitment: Global memory handover/);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM control_queue WHERE status='pending' AND session_group='origin'").get().n, 1);
  } else {
    assert.equal(result, undefined); assert.equal(owner.pending(), true);
    assert.equal(fs.readFileSync(path.join(f.memory, 'state.md'), 'utf8'), 'old single working state');
    assert.equal(fs.readFileSync(path.join(f.memory, 'inbox.md'), 'utf8'), 'global inbox');
    assert.equal(fs.existsSync(path.join(f.memory, 'mode-switch')), false);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM control_queue').get().n, 0);
  }
  assert.equal(observations, 2); assert.equal(opens, 2); assert.equal(closes, 2);
});
