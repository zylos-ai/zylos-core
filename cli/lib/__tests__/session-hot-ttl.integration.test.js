import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../test/helpers/ready-tmux-target.js';

// Covers Dashboard's locked write -> same Supervisor's fresh configuration ->
// real pre-reclaim check control, its acknowledgment, then the TTL fence and
// identity-guarded stop on a private tmux server/SQLite DB.
// Run for TTL writes, effective configuration or reclaim wiring changes; text
// and unrelated settings may skip. The clock advances the idle observation,
// rather than waiting five minutes. No authenticated model process is started.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR first; this
// fixture isolates them again before importing the product entry. Socket,
// Supervisor, SQLite handles and the named sleeper are closed on every exit.
test('saving idle reclamation takes effect in the same Supervisor and stops only its private session', { timeout: 30000 }, async t => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const f = readyTmuxTarget(t, { prefix: 'ttl-', mode: 'multi', runtimeProcess: true, packageRoot: repository });
  const oldEnv = { ...process.env };
  let service, db;
  try {
    for (const key of ['HOME', 'ZYLOS_DIR', 'TMUX', 'TMUX_TMPDIR', 'ZYLOS_PACKAGE_ROOT', 'PATH']) process.env[key] = f.env[key];
    for (const [key, dir] of [['PM2_HOME', 'pm2'], ['TMPDIR', 'tmp']]) {
      process.env[key] = path.join(f.root, dir); fs.mkdirSync(process.env[key]);
    }
    for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'ZYLOS_SESSION_HOT_TTL_SECONDS', 'ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID']) delete process.env[key];
    process.env.ZYLOS_SESSION_POOL_SIZE = '2';
    const configFile = path.join(f.root, '.zylos/config.json');
    const memoryFile = path.join(f.root, 'memory/identity.md');
    fs.mkdirSync(path.dirname(memoryFile)); fs.writeFileSync(memoryFile, 'Private retained memory\n');
    fs.writeFileSync(configFile, JSON.stringify({ runtime: 'claude', session_mode: 'multi', session_hot_ttl_seconds: 1800 }));
    f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
    const { DB_PATH } = await import('../../../skills/comm-bridge/scripts/c4-config.js');
    assert.equal(DB_PATH, path.join(f.root, 'comm-bridge/c4.db'));
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
      const actual = fs.realpathSync(process.env[key]);
      assert.ok(actual === fs.realpathSync(f.root) || actual.startsWith(fs.realpathSync(f.root) + path.sep));
    }
    console.log('Idle reclamation isolation:', JSON.stringify({ root: f.root, configFile, database: DB_PATH,
      socket: f.socketPath, env: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX'].map(k => [k, process.env[k]])) }));
    db = await import('../../../skills/comm-bridge/scripts/c4-db.js');
    const { startSupervisor } = await import('../../../skills/activity-monitor/scripts/supervisor-main.js');
    const { PRE_RECLAIM_CHECK_PROMPT } = await import('../../../skills/activity-monitor/scripts/reclaim-prompts.js');
    const { SupervisorScenes } = await import('../../../skills/activity-monitor/scripts/supervisor-scenes.js');
    const { handleAction, getActionsMeta } = await import('../../../skills/dashboard/src/lib/actions.js');
    const realNow = Date.now(), now = realNow + 600000;
    const scenes = new SupervisorScenes({ env: { ...process.env },
      connectionOptions: { socketPath: f.socketPath, binary: f.binary },
      readMode: () => ({ mode: 'multi' }), readActivity: () => ({ state: 'idle', idleSince: realNow }), now: () => now });
    // The integration drives the real lifecycle decisions explicitly so health,
    // machine tasks and unrelated admission workers cannot launch anything.
    const observation = Object.create(scenes);
    observation.observe = async () => [];
    observation.listRuns = async () => [];
    service = await startSupervisor({ env: { ...process.env }, db, scenes: observation, now: () => now,
      readConfig: () => JSON.parse(fs.readFileSync(configFile, 'utf8')),
      readMode: () => ({ mode: 'multi', keyPresent: true }),
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
      readSyncMarker: () => ({ held: false, stale: false }), loopOptions: { schedule: () => 1, cancel() {} },
      log() {}, sendAlert() { throw Error('External send forbidden'); } });
    assert.equal(service.supervisor.loop.configurationError, null);
    const supervisor = service.supervisor, pid = process.pid;
    const scene = await scenes.observeGroup('origin');
    assert.equal(scene.ready, true); assert.equal(scene.processRunning, true);
    const before = await supervisor.loop.deps.readConfiguration();
    const context = configuration => ({ configuration, scenes: [scene], fences: [], restartRequests: [], transition: null });
    await supervisor.lifecycle.checkTtl(scene, context(before));
    assert.equal(db.getDrainFence('origin'), null, 'ten minutes idle stays below the original thirty-minute TTL');
    const saved = await handleAction('set-session-hot-ttl', { minutes: 5 }, { runtime: 'claude', zylosDir: f.root });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).session_hot_ttl_seconds, 300);
    const after = await supervisor.loop.deps.readConfiguration();
    assert.equal(before.hotTtlSeconds, 1800); assert.equal(after.hotTtlSeconds, 300);
    const next = context(after);
    await supervisor.lifecycle.checkTtl(scene, next);
    assert.equal(db.getDrainFence('origin'), null, 'the check control precedes the fence');
    const [check, ...extra] = db.getDb().prepare("SELECT * FROM control_queue WHERE session_group='origin' ORDER BY id").all();
    assert.equal(extra.length, 0); assert.equal(check.raw_content, PRE_RECLAIM_CHECK_PROMPT);
    assert.equal(JSON.parse(check.target_binding).expectedRunId, scene.runId); assert.equal(check.require_idle, 1);
    assert.equal(db.ackControl(check.id).status, 'done');
    await supervisor.lifecycle.checkTtl(scene, next);
    const fence = db.getDrainFence('origin');
    assert.equal(fence.reason, 'ttl'); assert.equal(fence.runId, scene.runId);
    assert.equal(await supervisor.lifecycle.advanceReclaim(fence, next), 'done');
    assert.equal((await scenes.readIdentity('origin')).present, false);
    assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
    assert.equal(fs.readFileSync(memoryFile, 'utf8'), 'Private retained memory\n');
    assert.equal(service.supervisor, supervisor); assert.equal(process.pid, pid);
    const meta = getActionsMeta({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), zylosDir: f.root }, null);
    assert.equal(meta.session_hot_ttl.seconds, 300);
    console.log('Immediate idle reclamation:', JSON.stringify({ pid, beforeSeconds: before.hotTtlSeconds,
      afterSeconds: after.hotTtlSeconds, effectiveMinutes: meta.session_hot_ttl.minutes, idleSeconds: (now - scene.createdAt) / 1000,
      checkControl: 'done', fence: fence.reason, stopped: true, keeperPresent: true, memoryRetained: true, restarts: 0,
      clock: 'injected now ten minutes after private session creation' }));
  } finally {
    await service?.stop(); db?.close();
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(oldEnv, key)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});
