import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';

// Covers the real Supervisor entry: memory-pressure eviction sends the real
// pre-reclaim check control to a private group session, writes no fence until
// that check is acknowledged (first group) or its 60 second deadline passes
// (second group), then stops only that session on a private tmux server/SQLite DB.
// Run for eviction, memory-pressure, check-control or reclaim wiring changes;
// prompt wording and unrelated Sync changes may skip. The clock is injected, so
// no real minute is waited. No authenticated model process is started.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR first; this
// fixture isolates them again before importing the product entry. Socket,
// Supervisor, SQLite handles and the named sleepers are closed on every exit.
test('memory-pressure eviction checks the private group first and stops it only after the answer or the short deadline', { timeout: 30000 }, async t => {
  const repository = fileURLToPath(new URL('../../../../', import.meta.url));
  const f = readyTmuxTarget(t, { prefix: 'evict-', mode: 'multi', runtimeProcess: true, packageRoot: repository });
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
    fs.writeFileSync(configFile, JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
    const groups = ['alpha', 'beta'];
    for (const group of groups) {
      const runDir = path.join(f.root, 'activity-monitor/session-groups', group);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'current-session.json'),
        JSON.stringify({ runId: `run-${group}`, sessionId: `session-${group}`, ts: 1, startupControlIds: [] }));
      f.tmux('new-session', '-d', '-s', tmuxNameForGroup(group), '-e', `ZYLOS_RUN_ID=run-${group}`,
        '-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify({ runtime: 'claude', mode: 'default' })}`,
        '-e', `ZYLOS_SESSION_GROUP=${group}`, path.join(f.root, 'claude'), '120');
    }
    f.tmux('new-session', '-d', '-s', 'fixture-keeper', 'sleep', '120');
    const { DB_PATH } = await import('../../../comm-bridge/scripts/c4-config.js');
    assert.equal(DB_PATH, path.join(f.root, 'comm-bridge/c4.db'));
    for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
      const actual = fs.realpathSync(process.env[key]);
      assert.ok(actual === fs.realpathSync(f.root) || actual.startsWith(fs.realpathSync(f.root) + path.sep));
    }
    console.log('Eviction check isolation:', JSON.stringify({ root: f.root, configFile, database: DB_PATH,
      socket: f.socketPath, env: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX'].map(k => [k, process.env[k]])) }));
    db = await import('../../../comm-bridge/scripts/c4-db.js');
    const { startSupervisor } = await import('../supervisor-main.js');
    const { PRE_RECLAIM_CHECK_PROMPT } = await import('../reclaim-prompts.js');
    const { SupervisorScenes } = await import('../supervisor-scenes.js');
    const realNow = Date.now();
    let now = realNow + 600000;
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
    const { lifecycle } = service.supervisor;
    const configuration = await service.supervisor.loop.deps.readConfiguration();
    const context = async () => ({ configuration, fences: db.listDrainFences(), restartRequests: [], transition: null,
      scenes: (await Promise.all(groups.map(group => scenes.observeGroup(group)))).filter(scene => scene.present) });
    const checks = () => db.getDb().prepare('SELECT * FROM control_queue ORDER BY id').all();
    const present = async group => (await scenes.readIdentity(group)).present;
    const evicted = [];

    for (const answer of ['acknowledged', 'deadline']) {
      const asked = now;
      assert.equal(await lifecycle.checkCapacityPressure(await context()), null);
      const check = checks().at(-1), group = check.session_group;
      assert.equal(checks().length, evicted.length + 1);
      assert.equal(check.raw_content, PRE_RECLAIM_CHECK_PROMPT); assert.equal(check.require_idle, 1);
      assert.equal(JSON.parse(check.target_binding).expectedRunId, `run-${group}`);
      assert.equal(check.ack_deadline_at, Math.floor((asked + 60000) / 1000));
      assert.equal(db.listDrainFences().length, 0, 'the check control precedes the fence');
      now = asked + 59999;
      assert.equal(await lifecycle.checkCapacityPressure(await context()), null);
      assert.equal(checks().length, evicted.length + 1, 'no second check while the first one waits');
      assert.equal(db.listDrainFences().length, 0);
      if (answer === 'acknowledged') assert.equal(db.ackControl(check.id).status, 'done');
      else now = asked + 60000;
      assert.equal((await lifecycle.checkCapacityPressure(await context())).sessionGroup, group);
      const fence = db.getDrainFence(group);
      assert.equal(fence.reason, 'evict'); assert.equal(fence.runId, `run-${group}`);
      if (answer === 'deadline') {
        db.expireTimedOutControls(Math.floor(now / 1000) + 1);
        assert.equal(checks().at(-1).status, 'timeout');
      }
      assert.equal(await lifecycle.advanceReclaim(fence, await context()), 'done');
      assert.equal(await present(group), false);
      evicted.push(group);
      now += 1000;
    }
    assert.deepEqual([...evicted].sort(), groups);
    assert.equal(await present('origin'), true);
    assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
    console.log('Eviction check outcome:', JSON.stringify({ evicted, checks: checks().map(row => [row.session_group, row.status]),
      originPresent: true, keeperPresent: true, clock: 'injected now ten minutes after private session creation' }));
  } finally {
    await service?.stop(); db?.close();
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(oldEnv, key)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});
