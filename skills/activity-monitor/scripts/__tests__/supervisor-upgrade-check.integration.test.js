import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';

// Covers the real Supervisor entry: an accepted upgrade restart_all sends the real
// upgrade check control to every private session (Origin and two groups), writes
// no fence until a session's check is acknowledged (alpha) or its 60 second
// deadline passes (Origin, beta), then stops each restarted session and finishes
// the request on a private tmux server/SQLite DB.
// Run for upgrade restart, check-control or reclaim wiring changes; prompt wording
// and unrelated Sync or eviction changes may skip. The clock is injected, so no
// real minute is waited. No authenticated model process is started.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR first; this
// fixture isolates them again before importing the product entry. Socket,
// Supervisor, SQLite handles and the named sleepers are closed on every exit.
test('upgrade restart checks every private session first and restarts after the answer or the short deadline', { timeout: 30000 }, async t => {
  const repository = fileURLToPath(new URL('../../../../', import.meta.url));
  const f = readyTmuxTarget(t, { prefix: 'upgrade-', mode: 'multi', runtimeProcess: true, packageRoot: repository });
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
    console.log('Upgrade check isolation:', JSON.stringify({ root: f.root, configFile, database: DB_PATH,
      socket: f.socketPath, env: Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX'].map(k => [k, process.env[k]])) }));
    db = await import('../../../comm-bridge/scripts/c4-db.js');
    const { startSupervisor } = await import('../supervisor-main.js');
    const { UPGRADE_RESTART_CHECK_PROMPT } = await import('../reclaim-prompts.js');
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
    observation.listRuns = () => scenes.listRuns();
    service = await startSupervisor({ env: { ...process.env }, db, scenes: observation, now: () => now,
      readConfig: () => JSON.parse(fs.readFileSync(configFile, 'utf8')),
      readMode: () => ({ mode: 'multi', keyPresent: true }),
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
      readSyncMarker: () => ({ held: false, stale: false }), loopOptions: { schedule: () => 1, cancel() {} },
      log() {}, sendAlert() { throw Error('External send forbidden'); } });
    assert.equal(service.supervisor.loop.configurationError, null);
    const { lifecycle, admission } = service.supervisor;
    const configuration = await service.supervisor.loop.deps.readConfiguration();
    const all = ['origin', ...groups];
    const context = async () => ({ configuration, fences: db.listDrainFences(), restartRequests: admission.readRequests(), transition: null,
      scenes: (await Promise.all(all.map(group => scenes.observeGroup(group)))).filter(scene => scene.present) });
    const checks = () => db.getDb().prepare('SELECT * FROM control_queue ORDER BY id').all();
    const present = async group => (await scenes.readIdentity(group)).present;
    const finish = async group => {
      const fence = db.getDrainFence(group);
      assert.equal(fence.reason, 'upgrade');
      assert.equal(await lifecycle.advanceReclaim(fence, await context()), 'done');
      assert.equal(await present(group), false);
    };

    const accepted = await admission.handle({ version: 1, type: 'restart_all', requestId: 'upgrade-check', reason: 'upgrade' });
    assert.equal(accepted.result, 'accepted'); assert.equal(accepted.runCount, 3);
    const asked = now;
    await lifecycle.advanceRestarts(await context());
    const rows = checks();
    assert.deepEqual(rows.map(row => row.session_group).sort(), [...all].sort(), 'one check per session');
    for (const row of rows) {
      assert.equal(row.raw_content, UPGRADE_RESTART_CHECK_PROMPT); assert.equal(row.require_idle, 1);
      assert.equal(JSON.parse(row.target_binding).expectedRunId, row.session_group === 'origin' ? 'run-1' : `run-${row.session_group}`);
      assert.equal(row.ack_deadline_at, Math.floor((asked + 60000) / 1000));
    }
    assert.equal(db.listDrainFences().length, 0, 'the check controls precede every fence');
    const alpha = rows.find(row => row.session_group === 'alpha');
    assert.equal(db.ackControl(alpha.id).status, 'done');
    now = asked + 30000;
    await lifecycle.advanceRestarts(await context());
    assert.deepEqual(db.listDrainFences().map(fence => fence.sessionGroup), ['alpha'], 'the answered group does not wait for the others');
    await finish('alpha');
    now = asked + 59999;
    await lifecycle.advanceRestarts(await context());
    assert.equal(db.listDrainFences().length, 0);
    assert.equal(checks().length, 3, 'no second check while waiting');
    now = asked + 60000;
    await lifecycle.advanceRestarts(await context());
    assert.deepEqual(db.listDrainFences().map(fence => fence.sessionGroup).sort(), ['beta', 'origin']);
    db.expireTimedOutControls(Math.floor(now / 1000) + 1);
    assert.deepEqual(checks().map(row => row.status).sort(), ['done', 'timeout', 'timeout']);
    await finish('beta'); await finish('origin');
    await lifecycle.advanceRestarts(await context());
    assert.deepEqual(admission.readRequests(), []);
    const events = fs.readFileSync(path.join(f.root, 'activity-monitor/supervisor-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.event === 'restart_done' && event.requestId === 'upgrade-check').length, 1);
    assert.equal(checks().length, 3);
    assert.doesNotThrow(() => f.tmux('has-session', '-t', '=fixture-keeper'));
    console.log('Upgrade check outcome:', JSON.stringify({ checks: checks().map(row => [row.session_group, row.status]),
      restarted: all, keeperPresent: true, clock: 'injected now ten minutes after private session creation' }));
  } finally {
    await service?.stop(); db?.close();
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(oldEnv, key)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});
