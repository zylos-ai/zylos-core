// Boundary: actual index.js HTTP server -> real Core receive -> a stalled
// Dashboard channel child. Run for notice transport/receive await changes;
// unrelated UI changes may skip. Opt-in before allocating any resource.
// Each case proves private HOME/ZYLOS_DIR/PM2_HOME/short temp/socket/DB paths;
// sandbox deadlines and process-group teardown reclaim all test descendants.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { hashPassword } from '../src/lib/auth.js';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';

const core = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function waitFor(check, message, signal) {
  for (let attempt = 0; attempt < 1000 && !signal.aborted; attempt++) {
    const value = check();
    if (value) return value;
    await delay(10, undefined, { signal });
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

test('stalled status notice leaves health and another conversation responsive with a committed uncertain receipt',
  { skip: !chatEnabled(), timeout: 20_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async ({ signal }) => {
      const { zylos, home, tmp, pm2 } = sandbox.paths;
      for (const directory of ['.zylos', '.claude/skills', 'activity-monitor']) fs.mkdirSync(path.join(zylos, directory), { recursive: true });
      for (const name of ['comm-bridge', 'web-console', 'activity-monitor']) {
        fs.symlinkSync(path.join(core, 'skills', name), path.join(zylos, '.claude/skills', name));
      }
      // Install the real channel layout with a private transport fixture. Core
      // launches process.execPath directly, so PATH wrappers cannot intercept it.
      const channel = path.join(zylos, '.claude/skills/dashboard');
      fs.mkdirSync(path.join(channel, 'scripts'), { recursive: true });
      for (const entry of fs.readdirSync(path.join(core, 'skills/dashboard'))) {
        if (entry !== 'scripts') fs.symlinkSync(path.join(core, 'skills/dashboard', entry), path.join(channel, entry));
      }
      for (const entry of fs.readdirSync(path.join(core, 'skills/dashboard/scripts'))) {
        if (entry === 'send.js') continue;
        const source = path.join(core, 'skills/dashboard/scripts', entry), target = path.join(channel, 'scripts', entry);
        // The hook contract requires its entry to resolve inside this channel.
        if (entry === 'send-hook.js') fs.copyFileSync(source, target);
        else fs.symlinkSync(source, target);
      }
      const stalledScript = path.join(channel, 'scripts/send.js');
      fs.copyFileSync(fixture('chat-stalled-channel.js'), stalledScript);
      assert.equal(fs.lstatSync(stalledScript).isFile(), true);
      assert.ok(stalledScript.startsWith(zylos + path.sep));
      fs.writeFileSync(path.join(zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
      const bin = path.join(sandbox.root, 'bin'); fs.mkdirSync(bin);
      for (const name of ['zylos', 'claude', 'codex', 'pm2', 'tmux']) {
        const file = path.join(bin, name);
        // tmux never reaches a shared server; its only configured socket is private.
        fs.writeFileSync(file, `#!/bin/sh\n${name === 'tmux' ? 'exit 1' : `echo '${name === 'pm2' ? '[]' : '0.0.0'}'`}\n`, { mode: 0o755 });
      }
      // BeforeSend still resolves node through PATH; keep the real executable.
      fs.symlinkSync(process.execPath, path.join(bin, 'node'));
      const available = net.createServer();
      const availableOrigin = await sandbox.startHttp(available);
      const port = Number(new URL(availableOrigin).port);
      await new Promise(resolve => available.close(resolve));
      fs.writeFileSync(path.join(zylos, 'components/dashboard/config.json'), JSON.stringify({
        port, host: '127.0.0.1', auth: { enabled: true, password: hashPassword('isolated-notice-password') },
        observer: { enabled: false },
      }));
      const marker = path.join(sandbox.root, 'notice-started.json');
      const failure = path.join(sandbox.root, 'receive-error.json');
      const amSocket = path.join(zylos, 'activity-monitor/am.sock');
      assert.ok(Buffer.byteLength(amSocket) < 100);
      const connections = new Set();
      const am = net.createServer(socket => {
        connections.add(socket); socket.on('close', () => connections.delete(socket));
        let input = '';
        socket.on('data', chunk => {
          input += chunk;
          if (!input.includes('\n')) return;
          const request = JSON.parse(input.slice(0, input.indexOf('\n')));
          socket.end(JSON.stringify({ version: 2, type: request.type, requestId: request.requestId,
            recovered: false, runtime: 'codex', health: 'unavailable', reason: 'unavailable',
            transitionHold: false, userMessage: 'Agent temporarily unavailable.' }) + '\n');
        });
      });
      sandbox.addCleanup(async () => {
        for (const socket of connections) socket.destroy();
        if (am.listening) await new Promise(resolve => am.close(resolve));
      });
      await new Promise((resolve, reject) => { am.once('error', reject); am.listen(amSocket, resolve); });
      const env = { PATH: bin, ZYLOS_PACKAGE_ROOT: core, CHAT_NOTICE_STARTED: marker, CHAT_RECEIVE_ERROR: failure };
      console.log('Notice process targets:', JSON.stringify({ ...sandbox.assertIsolation(), amSocket,
        PATH: bin, stalledScript, index: path.join(core, 'skills/dashboard/src/index.js') }));
      const child = sandbox.startChild(process.execPath, ['--experimental-test-module-mocks',
        '--import', fixture('chat-notice-preload.js'), path.join(core, 'skills/dashboard/src/index.js')],
      { env, timeoutMs: 15_000 });
      let output = '';
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); });
      child.stderr.on('data', chunk => { output = (output + chunk).slice(-8192); });
      await waitFor(() => output.includes('zylos-dashboard listening'), 'Actual Dashboard must listen', signal);
      const origin = `http://127.0.0.1:${port}`;
      const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'isolated-notice-password' }), signal });
      assert.equal(login.status, 302);
      const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_dashboard_session='))?.split(';')[0];
      assert.ok(cookie);
      const headers = { cookie, origin, 'content-type': 'application/json' };
      const draft = async displayName => {
        const response = await fetch(`${origin}/api/chat/drafts`, { method: 'POST', headers,
          body: JSON.stringify({ displayName }), signal });
        assert.equal(response.status, 201);
        return (await response.json()).conversation.id;
      };
      const target = await draft('Send target'), other = await draft('Other conversation');
      let settled = false;
      const sending = fetch(`${origin}/api/chat/conversations/${target}/send`, { method: 'POST', headers,
        body: JSON.stringify({ content: 'Keep the committed error receipt.' }), signal })
        .then(async response => ({ status: response.status, body: await response.json() }))
        .finally(() => { settled = true; });
      // Always consume the pending request if a responsiveness assertion fails.
      sending.catch(() => {});
      await waitFor(() => {
        if (fs.existsSync(marker)) return true;
        const noticeLog = path.join(zylos, 'activity-monitor/status-notices.log');
        assert.equal(settled, false, `Send completed before the channel stalled: ${fs.existsSync(noticeLog) ? fs.readFileSync(noticeLog, 'utf8').slice(-8192) : output}`);
        return false;
      }, () => `Actual notification worker must start: ${output}`, signal);
      const actual = JSON.parse(fs.readFileSync(marker, 'utf8'));
      for (const [key, expected] of [['HOME', home], ['ZYLOS_DIR', zylos], ['PM2_HOME', pm2], ['TMPDIR', tmp], ['TMUX_TMPDIR', tmp]]) {
        assert.equal(actual[key], expected);
      }
      assert.equal(settled, false, 'Send must still wait for the notice child');
      await Promise.all(['/api/health', `/api/chat/conversations/${other}`].map(async route => {
        const started = performance.now();
        const response = await fetch(origin + route, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(800)]) });
        assert.equal(response.status, 200); await response.json();
        assert.ok(performance.now() - started < 500, `${route} must return while the notice remains stalled`);
      }));
      assert.equal(settled, false, 'Unrelated reads must finish before this send');
      assert.doesNotThrow(() => process.kill(actual.pid, 0), 'The private channel worker must remain alive during unrelated reads');
      const result = await sending;
      assert.equal(result.status, 200);
      assert.equal(result.body.stored, true);
      assert.equal(result.body.error, 'UNHEALTHY_NOTIFY_UNCERTAIN');
      assert.equal(result.body.retryAllowed, false);
      const received = JSON.parse(fs.readFileSync(failure, 'utf8'));
      assert.equal(received.code, 'UNHEALTHY_NOTIFY_UNCERTAIN');
      assert.deepEqual(received.persisted, ['D1']);
      assert.equal(received.id, result.body.messageId);
      const db = sandbox.openDatabase(sandbox.paths.c4Db, file => new Database(file, { readonly: true }));
      const row = db.prepare('SELECT direction,status FROM conversations WHERE id=?').get(received.id);
      assert.equal(row.direction, 'in'); assert.equal(row.status, 'failed');
      assert.equal(db.prepare("SELECT COUNT(*) n FROM conversations WHERE direction='in'").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM conversations WHERE direction='out'").get().n, 1);
    }, { timeoutMs: 15_000 });
    assert.equal(sandbox.children.size, 0);
    assert.equal(fs.existsSync(sandbox.root), false);
  });
