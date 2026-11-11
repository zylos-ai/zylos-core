import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChatSandbox } from './helpers/chat-integration-harness.js';
const enabled = process.env.ZYLOS_TIMEZONE_INTEGRATION === '1';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function processGone(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Private process ${pid} did not exit`);
}
function instanceDate(timeZone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Covers production monitor startup, supervisor loop, signal drain and real tmux
// survival across ordinary private PM2 restart. Run for monitor startup/stop or
// timezone service-list changes; unrelated frontend edits may skip. No runtime
// API or authentication is invoked: the occupied session is a private sleeper.
test('monitor ordinary restart loads instance timezone and preserves its tmux session',
  { skip: !enabled, timeout: 60_000 }, async t => {
    const sandbox = createChatSandbox(t, { gateEnv: { ...process.env, ZYLOS_CHAT_INTEGRATION: '1' } });
    await sandbox.runCase(async ({ signal }) => {
      const env = { ...sandbox.env, TZ: 'UTC', ZYLOS_PACKAGE_ROOT: repo,
        TMUX: `${sandbox.paths.socket},0,0` };
      console.log('Monitor restart isolation:', JSON.stringify(sandbox.assertIsolation({ env })));
      const root = sandbox.paths.zylos;
      fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
      fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({
        session_mode: 'multi', runtime: 'claude', session_pool_size: 2,
        upgrade_check_enabled: false, daily_upgrade_enabled: false, usage_monitor_enabled: false, health_check_enabled: false, usage_alert_enabled: false,
      }));
      fs.writeFileSync(path.join(root, '.env'), 'TZ=UTC\n');
      fs.mkdirSync(path.join(root, 'activity-monitor/session-groups/preserved'), { recursive: true });
      fs.writeFileSync(path.join(root, 'activity-monitor/session-groups/preserved/current-session.json'),
        JSON.stringify({ runId: 'preserved-run', sessionId: 'preserved-session', ts: Math.floor(Date.now() / 1000), startupControlIds: [] }));
      const today = instanceDate('UTC');
      fs.writeFileSync(path.join(root, 'activity-monitor/daily-memory-commit-state.json'), JSON.stringify({ last_date: today }));
      const cfile = path.join(root, 'sleeper.c'), runtime = path.join(root, 'claude');
      fs.writeFileSync(cfile, '#include <unistd.h>\nint main(void) { sleep(120); return 0; }\n');
      execFileSync('cc', [cfile, '-o', runtime], { env, timeout: 20000 });
      const tmux = args => execFileSync('tmux', ['-S', sandbox.paths.socket, ...args], { env, encoding: 'utf8', timeout: 5000 }).trim();
      sandbox.addCleanup(async () => {
        try { tmux(['kill-server']); } catch {}
        const { waitForServerExit } = await import('../../../test/helpers/isolated-tmux.js');
        await waitForServerExit({ binary: 'tmux', socketPath: sandbox.paths.socket });
        console.log('Private tmux cleanup:', JSON.stringify({ socket: sandbox.paths.socket, exited: true }));
      });
      tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-preserved',
        '-e', 'ZYLOS_SESSION_GROUP=preserved', '-e', 'ZYLOS_RUN_ID=preserved-run',
        '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', runtime, '120']);
      const identity = () => tmux(['display-message', '-p', '-t', '=zylos-group-preserved:', '#{session_id}:#{pane_id}:#{pane_pid}:#{session_created}']);
      const before = identity();
      const pm2Path = execFileSync('/bin/sh', ['-c', 'command -v pm2'], { env, encoding: 'utf8', timeout: 5000 }).trim();
      const pm2 = args => { sandbox.assertIsolation({ env }); return execFileSync(process.execPath, [pm2Path, ...args], { env, cwd: root, encoding: 'utf8', timeout: 15000 }); };
      let started = false, daemonPid;
      sandbox.addCleanup(async () => { if (started) {
        daemonPid ??= Number(fs.readFileSync(path.join(env.PM2_HOME, 'pm2.pid')));
        pm2(['kill']); await processGone(daemonPid); console.log('Monitor cleanup:', JSON.stringify({ PM2_HOME: env.PM2_HOME, socket: sandbox.paths.socket, killed: true })); } });
      const ecosystem = path.join(root, 'ecosystem.config.cjs');
      fs.writeFileSync(ecosystem, `module.exports = ${JSON.stringify({ apps: [{ name: 'activity-monitor',
        script: fileURLToPath(new URL('./fixtures/timezone-monitor.js', import.meta.url)),
        interpreter: process.execPath, cwd: root, autorestart: false, env }] })};`);
      started = true; pm2(['start', ecosystem]);
      daemonPid = Number(fs.readFileSync(path.join(env.PM2_HOME, 'pm2.pid')));
      const receiptPath = path.join(root, 'activity-monitor.json');
      async function receipt(predicate) {
        for (let i = 0; i < 200; i++) {
          signal.throwIfAborted(); let value;
          try { value = JSON.parse(fs.readFileSync(receiptPath)); } catch {}
          if (value && predicate(value)) return value;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const rows = JSON.parse(pm2(['jlist']));
        for (const row of rows) if (row.pm2_env.pm_err_log_path) console.log(fs.readFileSync(row.pm2_env.pm_err_log_path, 'utf8').slice(-8000));
        assert.fail('Monitor did not complete expected supervisor rounds');
      }
      const first = await receipt(v => v.rounds >= 2);
      assert.equal(first.tz, 'UTC'); assert.equal(identity(), before);
      assert.equal(first.scene.ready, true); assert.equal(first.scene.processRunning, true);
      assert.equal(first.scene.runId, 'preserved-run');
      fs.writeFileSync(path.join(root, '.env'), 'TZ=Asia/Tokyo\n');
      fs.writeFileSync(path.join(root, 'activity-monitor/daily-memory-commit-state.json'),
        JSON.stringify({ last_date: instanceDate('Asia/Tokyo') }));
      pm2(['restart', 'activity-monitor']);
      const second = await receipt(v => v.pid !== first.pid && v.rounds >= 2);
      assert.equal(second.tz, 'Asia/Tokyo');
      assert.equal(second.scene.ready, true); assert.equal(second.scene.runtimePid, first.scene.runtimePid);
      assert.equal(second.scene.runId, first.scene.runId); assert.equal(second.scene.sessionId, first.scene.sessionId);
      assert.deepEqual(second.scene.tmuxTarget, first.scene.tmuxTarget);
      assert.equal(identity(), before, 'session/pane/pid/creation time must not change');
      const third = await receipt(v => v.pid === second.pid && v.rounds > second.rounds);
      assert.equal(identity(), before);
      console.log('Monitor restart proof:', JSON.stringify({ before, after: identity(), first, second, third }));
    }, { timeoutMs: 50_000 });
  });

// Covers production dispatcher main/factory/router/delivery and persisted SQLite
// claim/settlement across PM2 SIGINT drain, including the pasted-but-unsettled
// require_idle window. Only READY/status/terminal adapter are test boundaries;
// paste is issued to a real private tmux. Run for dispatcher stop/start/timezone
// changes; skip unrelated UI. Does not promise exactly-once under SIGKILL.
for (const scenario of [
  { name: 'first verification', retries: 0, long: false },
  { name: 'verification retries for a long message', retries: 2, long: true },
]) test(`dispatcher named restart drains ${scenario.name} without replay and reads new timezone`,
  { skip: !enabled, timeout: 60_000 }, async t => {
    const sandbox = createChatSandbox(t, { gateEnv: { ...process.env, ZYLOS_CHAT_INTEGRATION: '1' } });
    await sandbox.runCase(async ({ signal }) => {
      const env = { ...sandbox.env, TZ: 'UTC', ZYLOS_PACKAGE_ROOT: repo,
        TIMEZONE_TEST_SOCKET: sandbox.paths.socket, TMUX: `${sandbox.paths.socket},0,0` };
      console.log('Dispatcher restart isolation:', JSON.stringify(sandbox.assertIsolation({ env })));
      const root = sandbox.paths.zylos;
      fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
      fs.writeFileSync(path.join(root, '.zylos/config.json'), '{"session_mode":"single","runtime":"codex"}');
      fs.writeFileSync(path.join(root, '.env'), 'TZ=UTC\n');
      const tmux = args => execFileSync('tmux', ['-S', sandbox.paths.socket, ...args], { env, encoding: 'utf8', timeout: 5000 }).trim();
      sandbox.addCleanup(async () => {
        try { tmux(['kill-server']); } catch {}
        const { waitForServerExit } = await import('../../../test/helpers/isolated-tmux.js');
        await waitForServerExit({ binary: 'tmux', socketPath: sandbox.paths.socket });
        console.log('Private tmux cleanup:', JSON.stringify({ socket: sandbox.paths.socket, exited: true }));
      });
      tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'zylos-group-origin', '/bin/cat']);
      const { default: Database } = await import('../../comm-bridge/scripts/sqlite-driver.js');
      const { guardDatabase } = await import('../../comm-bridge/scripts/sqlite-schema.js');
      const schema = await import('../../comm-bridge/scripts/c4-schema.js');
      const { createStore } = await import('../../comm-bridge/scripts/c4-v2-store.js');
      const sqlite = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
      guardDatabase(sqlite, schema);
      const store = createStore(sqlite, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { session_mode: 'single', runtime: 'codex' } }) });
      const message = store.insertConversation('in', 'fixture', 'endpoint',
        scenario.long ? '时'.repeat(500) : 'timezone restart drain');
      sqlite.prepare('UPDATE conversations SET require_idle=1 WHERE id=?').run(message.id);
      const row = () => sqlite.prepare('SELECT id,status,retry_count,session_id FROM conversations WHERE id=?').get(message.id);
      const pm2Path = execFileSync('/bin/sh', ['-c', 'command -v pm2'], { env, encoding: 'utf8', timeout: 5000 }).trim();
      const pm2 = args => { sandbox.assertIsolation({ env }); return execFileSync(process.execPath, [pm2Path, ...args], { env, cwd: root, encoding: 'utf8', timeout: 15000 }); };
      let started = false, daemonPid;
      sandbox.addCleanup(async () => { if (started) {
        daemonPid ??= Number(fs.readFileSync(path.join(env.PM2_HOME, 'pm2.pid')));
        pm2(['kill']); await processGone(daemonPid); console.log('Dispatcher cleanup:', JSON.stringify({ PM2_HOME: env.PM2_HOME, killed: true })); } });
      const ecosystem = path.join(root, 'ecosystem.config.cjs');
      fs.writeFileSync(ecosystem, `module.exports = ${JSON.stringify({ apps: [{ name: 'c4-dispatcher',
        script: fileURLToPath(new URL('./fixtures/timezone-dispatcher.js', import.meta.url)),
        args: [String(scenario.retries)],
        interpreter: process.execPath, cwd: root, autorestart: false, env }] })};`);
      async function wait(predicate, label) {
        for (let i = 0; i < 200; i++) { signal.throwIfAborted(); if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
        for (const proc of JSON.parse(pm2(['jlist']))) console.log(fs.readFileSync(proc.pm2_env.pm_err_log_path, 'utf8').slice(-8000));
        assert.fail(label);
      }
      const receipts = () => { try { return fs.readFileSync(path.join(root, 'paste-receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
      started = true; pm2(['start', ecosystem]);
      daemonPid = Number(fs.readFileSync(path.join(env.PM2_HOME, 'pm2.pid')));
      await wait(() => receipts().length > 0, 'Dispatcher must paste before restart');
      const before = row(); assert.equal(before.status, 'running'); assert.equal(before.retry_count, 0);
      const first = JSON.parse(fs.readFileSync(path.join(root, 'c4-dispatcher.json')));
      const processBefore = JSON.parse(pm2(['jlist']))[0];
      fs.writeFileSync(path.join(root, '.env'), 'TZ=Asia/Tokyo\n');
      const { createPm2Helpers } = await import('../../../cli/lib/pm2.js');
      const restartCallerEnv = { ...env, PORT: '47992', DASHBOARD_CALLER_SENTINEL: 'must-not-leak',
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH}` };
      sandbox.assertIsolation({ env: restartCallerEnv });
      createPm2Helpers({ exec: command => execFileSync('/bin/sh', ['-c', command],
        { env: restartCallerEnv, cwd: root, encoding: 'utf8', timeout: 15000 }) })
        .restartManagedProcess('c4-dispatcher', { killTimeoutMs: 10000 });
      await wait(() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'c4-dispatcher.json'))).pid !== first.pid; } catch { return false; } }, 'Restart must publish startup');
      await wait(() => row().status === 'delivered', 'In-flight delivery must settle');
      const after = row(), second = JSON.parse(fs.readFileSync(path.join(root, 'c4-dispatcher.json')));
      console.log('Dispatcher restart proof:', JSON.stringify({ before, after, first, second, verification: JSON.parse(fs.readFileSync(path.join(root, 'verification.json'))), receipts: receipts().map(receipt => ({ pid: receipt.pid, bytes: Buffer.byteLength(receipt.text) })), pm2KillTimeout: JSON.parse(pm2(['jlist']))[0].pm2_env.kill_timeout ?? 'default' }));
      assert.equal(second.tz, 'Asia/Tokyo');
      if (processBefore) {
        const processAfter = JSON.parse(pm2(['jlist']))[0];
        assert.equal(processAfter.pm2_env.PORT, undefined);
        assert.equal(processAfter.pm2_env.DASHBOARD_CALLER_SENTINEL, undefined);
        assert.equal(processAfter.pm2_env.kill_timeout, 10000);
        assert.equal(processAfter.pm2_env.unique_id, processBefore.pm2_env.unique_id);
        const oldKeys = Object.keys(processBefore.pm2_env.env).sort(), newKeys = Object.keys(processAfter.pm2_env.env).sort();
        assert.equal(newKeys.length, oldKeys.length);
        for (let i = 0; i < oldKeys.length; i++) {
          assert.equal(newKeys[i], oldKeys[i]);
          assert.deepEqual(processAfter.pm2_env.env[oldKeys[i]], processBefore.pm2_env.env[oldKeys[i]]);
        }
        console.log('Dispatcher timeout metadata:', JSON.stringify({ uniqueId: processAfter.pm2_env.unique_id,
          killTimeout: processAfter.pm2_env.kill_timeout, environmentKeys: oldKeys, unchanged: true }));
      }
      assert.equal(after.retry_count, 0, 'normal restart must drain instead of orphan-requeue');
      assert.equal(receipts().length, 1, 'pasted message must not replay');
      const verification = JSON.parse(fs.readFileSync(path.join(root, 'verification.json')));
      assert.equal(verification.pid, first.pid, 'old dispatcher must verify before settlement');
      assert.equal(verification.checks, scenario.retries + 1);
    }, { timeoutMs: 50_000 });
  });
