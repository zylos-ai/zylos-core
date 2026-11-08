import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChatSandbox } from './helpers/chat-integration-harness.js';

const enabled = process.env.ZYLOS_TIMEZONE_INTEGRATION === '1';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const settingsPath = '/api/settings/timezone';
const restartPath = '/api/actions/restart-timezone-services';

// Covers the real HTTP auth/controller, private .env and private PM2 daemon through
// the existing named managed-process restart helper. Run when changing timezone writes,
// service discovery, restart or auth contracts; unrelated display changes may skip.
// Opt-in before allocation. HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB paths
// are proven before imports or launches. All resources close on failure/timeout.
// This is a loopback route fixture, not the full Dashboard/Fleet server.
test('timezone HTTP saves require admin access and a separate confirmed service restart',
  { skip: !enabled, timeout: 90_000 }, async t => {
    const sandbox = createChatSandbox(t, { gateEnv: { ...process.env, ZYLOS_CHAT_INTEGRATION: '1' } });
    const previousEnv = process.env;
    process.env = { ...sandbox.env, TZ: 'UTC' };
    try {
      await sandbox.runCase(async ({ signal }) => {
        const proof = sandbox.assertIsolation({ env: process.env });
        const pm2Path = execFileSync('/bin/sh', ['-c', 'command -v pm2'],
          { env: process.env, encoding: 'utf8', timeout: 5000 }).trim();
        assert.ok(path.isAbsolute(pm2Path) && fs.statSync(pm2Path).isFile(), 'PM2 must already be provisioned');
        const root = sandbox.paths.zylos;
        const ecosystem = path.join(root, 'pm2/ecosystem.config.cjs');
        const envFile = path.join(root, '.env');
        const configFile = path.join(root, '.zylos/config.json');
        const source = fileURLToPath(new URL('./fixtures/timezone-service.js', import.meta.url));
        const scripts = [
          ['scheduler', 'scheduler/scripts/daemon.js'],
          ['web-console', 'web-console/scripts/server.js'],
          ['zylos-openmax', 'openmax/src/comm-bridge.js'],
          ['runtime-sentinel', 'runtime/sentinel.js'],
        ];
        for (const [, relative] of scripts) {
          const target = path.join(root, '.claude/skills', relative);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
        }
        fs.writeFileSync(path.join(root, '.claude/skills/package.json'), '{"type":"module"}');
        fs.mkdirSync(path.dirname(ecosystem), { recursive: true });
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, '{}');
        const original = '# preserve instance configuration\r\nexport TZ = "UTC" # local clock\r\nOTHER="keep # bytes"\r\n';
        fs.writeFileSync(envFile, original, { mode: 0o600 });
        const apps = scripts.map(([name, relative]) => ({ name,
          script: path.join(root, '.claude/skills', relative), cwd: root,
          interpreter: process.execPath, autorestart: false,
          env: { ZYLOS_DIR: root, fixture_name: name } }));
        fs.writeFileSync(ecosystem, `module.exports = ${JSON.stringify({ apps })};\n`);
        console.log('Timezone process isolation:', JSON.stringify({ ...proof, pm2Path,
          node: process.execPath, ecosystem, envFile, scripts: apps.map(app => app.script) }));
        const pm2 = args => {
          sandbox.assertIsolation({ env: process.env });
          return execFileSync(process.execPath, [pm2Path, ...args], { env: process.env,
            cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
        };
        let pm2Started = false;
        let daemonPid;
        sandbox.addCleanup(async () => {
          if (pm2Started) {
            // Never fall back to an unscoped PM2 command.
            assert.equal(process.env.PM2_HOME, sandbox.paths.pm2);
            pm2(['kill']);
            let alive = false;
            for (let attempt = 0; daemonPid && attempt < 100; attempt++) {
              try { process.kill(daemonPid, 0); alive = true; }
              catch (error) { if (error.code !== 'ESRCH') throw error; alive = false; break; }
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(alive, false, 'private PM2 daemon must exit before fixture removal');
            console.log('Timezone private PM2 cleanup:', JSON.stringify({ PM2_HOME: sandbox.paths.pm2, daemonPid, killed: true }));
          }
        });
        pm2Started = true;
        pm2(['start', ecosystem]);
        daemonPid = Number(fs.readFileSync(path.join(sandbox.paths.pm2, 'pm2.pid'), 'utf8'));
        pm2(['stop', 'zylos-openmax']);
        const pm2Data = () => ({ processes: JSON.parse(pm2(['jlist'])) });
        const snapshot = () => new Map(pm2Data().processes.map(proc => [proc.name, proc.pid]));
        const before = snapshot();
        assert.ok(before.get('scheduler') > 0 && before.get('web-console') > 0 && before.get('runtime-sentinel') > 0);
        const [{ createInstanceTimezone, handleInstanceTimezone, handleInstanceTimezoneRestart }, { AuthGate, hashPassword },
          { Store }, { handleAction }, { sendJson }] = await Promise.all([
          import('../src/lib/instance-timezone.js'), import('../src/lib/auth.js'),
          import('../src/lib/store.js'), import('../src/lib/actions.js'), import('../src/lib/http.js'),
        ]);
        const store = sandbox.openDatabase(sandbox.paths.dashboardDb, filename => new Store(filename));
        const auth = new AuthGate({ auth: { enabled: true, password: hashPassword('fixture-password') } }, store);
        sandbox.addCleanup(() => clearInterval(auth._cleanupTimer));
        const tokens = {};
        for (const scope of ['read', 'admin']) {
          const key = store.insertApiKey({ name: `fixture-${scope}`, keyHash: hashPassword('fixture-key'), scope });
          const token = `zylos_st_${crypto.randomBytes(32).toString('hex')}`;
          store.insertApiSession({ tokenHash: sha256(token), apiKeyId: key.lastInsertRowid, scope,
            createdAt: Date.now(), expiresAt: Date.now() + 120_000 });
          tokens[scope] = token;
        }
        const timezone = createInstanceTimezone({ zylosDir: root, readPm2: async () => pm2Data(), log() {} });
        let activeTimezone = timezone;
        const pid = process.pid;
        const server = http.createServer(async (req, res) => {
          try {
            const url = new URL(req.url, 'http://localhost');
            if (await auth.handle(req, res, url)) return;
            if (await handleInstanceTimezone(req, res, url, { auth, timezone: activeTimezone })) return;
            if (await handleInstanceTimezoneRestart(req, res, url, { auth, timezone: activeTimezone,
              runAction: body => handleAction('restart-timezone-services', body, { zylosDir: root }, { timezone: activeTimezone }) })) return;
            sendJson(res, 404, { error: 'not_found' });
          } catch { sendJson(res, 500, { error: 'fixture_failed' }); }
        });
        const origin = await sandbox.startHttp(server);
        const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', signal,
          headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=fixture-password' });
        assert.equal(login.status, 302);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        async function request(route, { method = 'GET', identity = 'cookie', body, sameOrigin = true } = {}) {
          const headers = { 'content-type': 'application/json' };
          if (identity === 'cookie') headers.cookie = cookie;
          else if (tokens[identity]) headers.authorization = `Bearer ${tokens[identity]}`;
          if (sameOrigin !== null) headers.origin = sameOrigin ? origin : 'https://other.invalid';
          const response = await fetch(origin + route, { method, headers, signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          return { status: response.status, body: await response.json() };
        }
        // read access views the instance while writes and cross-origin cookies are rejected.
        {
          const view = await request(settingsPath, { identity: 'read' });
          assert.equal(view.status, 200); assert.equal(view.body.tz, 'UTC'); assert.equal(view.body.writable, false);
          assert.equal((await request(settingsPath, { method: 'PUT', identity: 'read', body: { tz: 'Asia/Tokyo' } })).status, 403);
          assert.equal((await request(settingsPath, { method: 'PUT', sameOrigin: false, body: { tz: 'Asia/Tokyo' } })).status, 403);
          assert.equal((await request(settingsPath, { method: 'PUT', body: { tz: 'Invalid/Zone' } })).status, 400);
          assert.equal(fs.readFileSync(envFile, 'utf8'), original);
        }
        // saving changes only the timezone bytes and never restarts a process.
        {
          const saved = await request(settingsPath, { method: 'PUT', identity: 'admin', body: { tz: 'Asia/Tokyo' } });
          assert.equal(saved.status, 200); assert.equal(saved.body.changed, true); assert.equal(saved.body.tz, 'Asia/Tokyo');
          assert.deepEqual(saved.body.restart_services.map(item => item.name), ['scheduler', 'web-console']);
          assert.equal(saved.body.restart_status, 'known');
          assert.equal(fs.readFileSync(envFile, 'utf8'), original.replace('"UTC"', '"Asia/Tokyo"'));
          assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
          const after = snapshot();
          for (const name of ['scheduler', 'web-console', 'runtime-sentinel']) assert.equal(after.get(name), before.get(name));
          assert.equal((await request(restartPath, { method: 'POST', body: { tz: 'Asia/Tokyo' } })).status, 400);
          assert.equal((await request(restartPath, { method: 'POST', body: { tz: 'UTC', confirm: true } })).status, 409);
          assert.equal((await request(restartPath, { method: 'POST', identity: 'read', body: { tz: 'Asia/Tokyo', confirm: true } })).status, 403);
          assert.equal((await request(restartPath, { method: 'POST', sameOrigin: false, body: { tz: 'Asia/Tokyo', confirm: true } })).status, 403);
          const unchanged = snapshot();
          for (const name of ['scheduler', 'web-console', 'runtime-sentinel']) assert.equal(unchanged.get(name), before.get(name));
        }
        // confirmed restart refreshes only owned running timezone consumers.
        {
          const result = await request(restartPath, { method: 'POST', body: { tz: 'Asia/Tokyo', confirm: true } });
          assert.equal(result.status, 200); assert.equal(result.body.ok, true);
          assert.deepEqual(result.body.restarted, ['scheduler', 'web-console']);
          assert.deepEqual(result.body.failed, []);
          const after = snapshot();
          for (const name of ['scheduler', 'web-console']) {
            assert.ok(after.get(name) > 0); assert.notEqual(after.get(name), before.get(name));
            let receipt;
            for (let attempt = 0; attempt < 100; attempt++) {
              signal.throwIfAborted();
              try { receipt = JSON.parse(fs.readFileSync(path.join(root, `${name}.json`), 'utf8')); } catch {}
              if (receipt?.pid === after.get(name)) break;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            console.log('Timezone process receipt:', JSON.stringify({ name, before: before.get(name), after: after.get(name), receipt }));
            assert.equal(receipt?.pid, after.get(name)); assert.equal(receipt.tz, 'Asia/Tokyo');
          }
          assert.equal(after.get('runtime-sentinel'), before.get('runtime-sentinel'));
          assert.equal(after.get('zylos-openmax'), 0, 'stopped optional consumer stays stopped');
          console.log('Timezone untouched processes:', JSON.stringify({ runtimeBefore: before.get('runtime-sentinel'), runtimeAfter: after.get('runtime-sentinel'), httpPid: process.pid, stoppedOptionalPid: after.get('zylos-openmax') }));
          assert.equal(process.pid, pid, 'HTTP host keeps its PID');
          assert.equal((await request(settingsPath)).body.tz, 'Asia/Tokyo', 'same listener remains usable');
        }
        // The same HTTP route retains partial-operation results for retry. Only
        // this transport assertion injects restart outcomes; actual PM2 was above.
        {
          const nextEdit = await request(settingsPath, { method: 'PUT', body: { tz: 'Asia/Seoul' } });
          assert.equal(nextEdit.status, 200); assert.equal(nextEdit.body.tz, 'Asia/Seoul');
          activeTimezone = createInstanceTimezone({ zylosDir: root, readPm2: async () => pm2Data(), log() {},
            restartService: async name => { if (name === 'web-console') throw new Error('fixture restart failure'); } });
          const partial = await request(restartPath, { method: 'POST', body: { tz: 'Asia/Seoul', confirm: true } });
          assert.equal(partial.status, 200); assert.equal(partial.body.ok, false);
          assert.deepEqual(partial.body.restarted, ['scheduler']);
          assert.deepEqual(partial.body.failed, [{ name: 'web-console', error: 'restart_failed' }]);
          assert.deepEqual(partial.body.restart_services.map(item => item.name), ['web-console']);
          activeTimezone = timezone;
        }
        // an explicit managed deployment marker blocks both save and restart.
        {
          fs.writeFileSync(configFile, '{"timezone_managed":true}');
          const view = await request(settingsPath);
          assert.equal(view.body.writable, false); assert.equal(view.body.read_only_reason, 'timezone_managed');
          assert.equal((await request(settingsPath, { method: 'PUT', body: { tz: 'UTC' } })).status, 409);
          assert.equal((await request(restartPath, { method: 'POST', body: { tz: 'Europe/Paris', confirm: true } })).status, 409);
          assert.equal(fs.readFileSync(envFile, 'utf8'), original.replace('"UTC"', '"Asia/Seoul"'));
        }
      }, { timeoutMs: 75_000 });
    } finally { process.env = previousEnv; }
  });
