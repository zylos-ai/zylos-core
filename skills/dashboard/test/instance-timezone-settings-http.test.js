import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChatSandbox } from './helpers/chat-integration-harness.js';
const enabled = process.env.ZYLOS_TIMEZONE_INTEGRATION === '1';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const settingsPath = '/api/settings/timezone', restartPath = '/api/actions/restart-timezone-services';

// Covers real HTTP auth/controller in a private PM2-hosted caller, actual
// scheduler daemon/.env/database and ordinary named restart. Compares the full
// target saved environment key/value set and unique_id to catch caller pollution.
// Run for timezone writes/restarts/auth/process discovery changes; unrelated UI
// may skip. All HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB paths are read back before
// launch. No full Dashboard/Fleet transport is claimed. Cleanup owns the daemon.
test('timezone HTTP save and confirmed restart use real scheduler without caller environment pollution',
  { skip: !enabled, timeout: 90_000 }, async t => {
    const sandbox = createChatSandbox(t, { gateEnv: { ...process.env, ZYLOS_CHAT_INTEGRATION: '1' } });
    await sandbox.runCase(async ({ signal }) => {
      const env = { ...sandbox.env, TZ: 'UTC', ZYLOS_PACKAGE_ROOT: repo };
      const root = sandbox.paths.zylos, envFile = path.join(root, '.env');
      const pm2Path = execFileSync('/bin/sh', ['-c', 'command -v pm2'], { env, encoding: 'utf8', timeout: 5000 }).trim();
      assert.ok(path.isAbsolute(pm2Path));
      fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      const installedSkills = path.join(root, '.claude/skills');
      fs.mkdirSync(installedSkills);
      fs.cpSync(path.join(repo, 'skills/scheduler'), path.join(installedSkills, 'scheduler'), { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
      fs.symlinkSync(path.join(repo, 'skills/comm-bridge'), path.join(installedSkills, 'comm-bridge'), 'dir');
      const dependencies = path.join(installedSkills, 'scheduler/node_modules'); fs.mkdirSync(dependencies);
      for (const dependency of ['better-sqlite3', 'dotenv']) fs.symlinkSync(fs.realpathSync(path.join(repo, 'node_modules', dependency)), path.join(dependencies, dependency), 'dir');
      const schedulerDependencies = process.env.ZYLOS_SCHEDULER_TEST_DEPENDENCIES;
      assert.ok(schedulerDependencies && path.isAbsolute(schedulerDependencies), 'Use an explicit existing scheduler dependency directory');
      for (const dependency of ['cron-parser', 'chrono-node']) fs.symlinkSync(fs.realpathSync(path.join(schedulerDependencies, dependency)), path.join(dependencies, dependency), 'dir');
      console.log('Scheduler dependency sources:', JSON.stringify({ schedulerDependencies, dependencies, copiedSource: path.join(installedSkills, 'scheduler') }));
      fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
      fs.writeFileSync(path.join(root, '.zylos/config.json'), '{}');
      const original = '# preserve instance configuration\r\nexport TZ = "UTC" # local clock\r\nOTHER="keep # bytes"\r\n';
      fs.writeFileSync(envFile, original, { mode: 0o600 });
      const ecosystem = path.join(root, 'ecosystem.config.cjs');
      const apps = [
        { name: 'scheduler', script: path.join(root, '.claude/skills/scheduler/scripts/daemon.js'), env },
        { name: 'dashboard-caller', script: fileURLToPath(new URL('./fixtures/timezone-dashboard.js', import.meta.url)),
          env: { ...env, PORT: '47991', DASHBOARD_CALLER_SENTINEL: 'must-not-leak', TIMEZONE_TEST_PM2: pm2Path } },
      ].map(app => ({ ...app, interpreter: process.execPath, cwd: root, autorestart: false }));
      fs.writeFileSync(ecosystem, `module.exports = ${JSON.stringify({ apps })};`);
      console.log('Timezone HTTP process isolation:', JSON.stringify({ ...sandbox.assertIsolation({ env }), node: process.execPath,
        pm2Path, ecosystem, envFile, schedulerDb: path.join(root, 'scheduler/scheduler.db'), scripts: apps.map(app => app.script) }));
      const pm2 = args => { sandbox.assertIsolation({ env }); return execFileSync(process.execPath, [pm2Path, ...args],
        { env, cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }); };
      let started = false, daemonPid;
      sandbox.addCleanup(async () => {
        if (!started) return;
        pm2(['kill']);
        for (let i = 0; i < 100; i++) {
          try { process.kill(daemonPid, 0); } catch (error) { if (error.code === 'ESRCH') {
            console.log('Timezone HTTP cleanup:', JSON.stringify({ PM2_HOME: env.PM2_HOME, daemonPid, killed: true })); return;
          } throw error; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail('Private PM2 daemon must exit');
      });
      const processes = () => JSON.parse(pm2(['jlist']));
      const scheduler = () => processes().find(row => row.name === 'scheduler');
      async function wait(predicate, label) {
        for (let i = 0; i < 200; i++) { signal.throwIfAborted(); const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
        for (const row of processes()) console.log(JSON.stringify({name: row.name, status: row.pm2_env.status, stdout: fs.readFileSync(row.pm2_env.pm_out_log_path, 'utf8').slice(-8000), stderr: fs.readFileSync(row.pm2_env.pm_err_log_path, 'utf8').slice(-8000)}));
        assert.fail(label);
      }
      started = true; pm2(['start', ecosystem]);
      daemonPid = Number(fs.readFileSync(path.join(env.PM2_HOME, 'pm2.pid')));
      const listener = await wait(() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'dashboard-listener.json'))); } catch { return null; } }, 'Dashboard caller must start');
      const before = scheduler();
      const log = () => fs.readFileSync(scheduler().pm2_env.pm_out_log_path, 'utf8');
      await wait(() => /Scheduler started \(TZ: UTC\)/.test(log()), 'Real scheduler must start with UTC');
      assert.ok(fs.statSync(path.join(root, 'scheduler/scheduler.db')).isFile());
      assert.equal(before.pm2_env.PORT, undefined); assert.equal(before.pm2_env.DASHBOARD_CALLER_SENTINEL, undefined);
      async function request(route, { method = 'GET', scope = 'admin', body, origin = listener.origin, cookie } = {}) {
        const headers = { 'content-type': 'application/json', origin };
        if (cookie) headers.cookie = cookie; else headers.authorization = `Bearer ${listener.tokens[scope]}`;
        const response = await fetch(listener.origin + route, { method, headers, signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      }
      const login = await fetch(listener.origin + '/login', { method: 'POST', redirect: 'manual', signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=fixture-password' });
      assert.equal(login.status, 302); const cookie = login.headers.get('set-cookie').split(';')[0];
      const view = await request(settingsPath, { scope: 'read' }); assert.equal(view.body.writable, false);
      assert.equal((await request(settingsPath, { method: 'PUT', scope: 'read', body: { tz: 'Asia/Tokyo' } })).status, 403);
      assert.equal((await request(settingsPath, { method: 'PUT', cookie, origin: 'https://other.invalid', body: { tz: 'Asia/Tokyo' } })).status, 403);
      assert.equal((await request(settingsPath, { method: 'PUT', body: { tz: 'Invalid/Zone' } })).status, 400);
      assert.equal(fs.readFileSync(envFile, 'utf8'), original);
      const saved = await request(settingsPath, { method: 'PUT', body: { tz: 'Asia/Tokyo' } });
      assert.equal(saved.status, 200); assert.equal(saved.body.changed, true);
      assert.deepEqual(saved.body.restart_services.map(row => row.name), ['scheduler']);
      assert.equal(fs.readFileSync(envFile, 'utf8'), original.replace('"UTC"', '"Asia/Tokyo"'));
      assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
      assert.equal(scheduler().pid, before.pid, 'saving does not restart');
      assert.equal((await request(restartPath, { method: 'POST', body: { tz: 'Asia/Tokyo' } })).status, 400);
      assert.equal((await request(restartPath, { method: 'POST', body: { tz: 'UTC', confirm: true, services: ['scheduler'] } })).status, 409);
      assert.equal((await request(restartPath, { method: 'POST', scope: 'read', body: { tz: 'Asia/Tokyo', confirm: true, services: ['scheduler'] } })).status, 403);
      const result = await request(restartPath, { method: 'POST', cookie, body: { tz: 'Asia/Tokyo', confirm: true, services: ['scheduler'] } });
      assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.deepEqual(result.body.restarted, ['scheduler']);
      const after = await wait(() => { const row = scheduler(); return row.pid > 0 && row.pid !== before.pid && row; }, 'Scheduler PID must change');
      await wait(() => /Scheduler started \(TZ: Asia\/Tokyo\)/.test(log()), 'Real restarted scheduler must read new .env TZ');
      assert.equal(after.pm2_env.PORT, undefined); assert.equal(after.pm2_env.DASHBOARD_CALLER_SENTINEL, undefined);
      assert.equal(after.pm2_env.unique_id, before.pm2_env.unique_id, 'normal restart preserves PM2 identity');
      const beforeKeys = Object.keys(before.pm2_env.env).sort(), afterKeys = Object.keys(after.pm2_env.env).sort();
      assert.equal(afterKeys.length, beforeKeys.length, 'target environment must not gain keys');
      for (let i = 0; i < beforeKeys.length; i++) {
        assert.equal(afterKeys[i], beforeKeys[i], 'target environment keys must be identical');
        const key = beforeKeys[i]; assert.deepEqual(after.pm2_env.env[key], before.pm2_env.env[key], `environment ${key} must not change`);
      }
      assert.equal(processes().find(row => row.name === 'dashboard-caller').pid, listener.pid);
      assert.equal((await request(settingsPath)).body.tz, 'Asia/Tokyo');
      console.log('Timezone scheduler restart evidence:', JSON.stringify({ beforePid: before.pid, afterPid: after.pid,
        uniqueId: after.pm2_env.unique_id, callerPid: listener.pid, environmentKeys: beforeKeys, noPort: after.pm2_env.PORT === undefined,
        noCallerSentinel: after.pm2_env.DASHBOARD_CALLER_SENTINEL === undefined, startup: log().split('\n').filter(line => line.includes('Scheduler started')) }));
    }, { timeoutMs: 75000 });
  });
