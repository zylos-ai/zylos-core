import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { MessageRouter } from '../../../activity-monitor/scripts/message-router.js';
import { RuntimeHealthCoordinator } from '../../../activity-monitor/scripts/runtime-health.js';

const run = promisify(execFile);
const receiver = fileURLToPath(new URL('../c4-receive.js', import.meta.url));

// Integration boundary: actual receiver CLI, private IPC socket, MessageRouter,
// HealthStore and SQLite. Only checkAuth and channel sending are injected.
// Run for internal/external authentication routing changes; skip unrelated UI,
// runtime launch and delivery work. The official runner isolates the parent;
// every child also gets private HOME/ZYLOS_DIR/PM2_HOME and short TMPDIR/socket.
// No live tmux, PM2, network or credential is used. execFile has a timeout and
// output cap; teardown destroys owned sockets and closes the server/database.
async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/c4-auth-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['home', 'tmp', 'pm2', 'tmux', '.zylos', 'activity-monitor',
    '.claude/skills/telegram/scripts', '.claude/skills/system/scripts']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  await fs.writeFile(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'single' }));
  for (const channel of ['telegram', 'system']) {
    await fs.writeFile(path.join(root, '.claude/skills', channel, 'scripts/send.js'), 'process.exit(0);\n');
  }
  const now = 1792000000000;
  const coordinator = new RuntimeHealthCoordinator({ zylosDir: root, now: () => now });
  const store = coordinator.store('claude'), state = store.read();
  state.health = 'auth_failed'; state.reason = 'authentication_failed'; store.write(state);
  const requests = []; let checks = 0;
  const router = new MessageRouter({ healthCoordinator: coordinator, resolveTargetRuntime: () => 'claude',
    cacheDirectory: path.join(root, 'cache'), now: () => now,
    checkAuth: () => { checks++; return { status: 'failure', reason: 'not_logged_in' }; } });
  const sockets = new Set(); const errors = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => { if (!errors.length) errors.push(error); });
    let input = '', handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      input += chunk;
      if (input.length > 65536) {
        handled = true;
        if (!errors.length) errors.push(new Error('Route request exceeded fixture buffer'));
        socket.destroy(); return;
      }
      const end = input.indexOf('\n');
      if (end < 0) return;
      handled = true;
      try {
        const request = JSON.parse(input.slice(0, end)); requests.push(request);
        socket.end(JSON.stringify(await router.route(request)) + '\n');
      } catch (error) { if (!errors.length) errors.push(error); socket.destroy(); }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path.join(root, 'activity-monitor/am.sock'), resolve);
  });
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: root,
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp'), TMUX_TMPDIR: path.join(root, 'tmux') };
  delete env.TMUX;
  return { requests, errors, checks: () => checks,
    async receive(args) {
      const { stdout } = await run(process.execPath, [receiver, ...args, '--json', '--content', 'component task'],
        { env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 });
      const result = JSON.parse(stdout.trim().split('\n').at(-1));
      const db = new Database(path.join(root, 'comm-bridge/c4.db'));
      try { return { result, row: db.prepare('SELECT * FROM conversations WHERE id=?').get(result.id) }; }
      finally { db.close(); }
    } };
}

test('channel-less internal no-reply input queues during authentication failure without checking credentials', async t => {
  const f = await fixture(t);
  const { result, row } = await f.receive(['--no-reply']);
  assert.equal(result.action, 'queued'); assert.equal(row.status, 'pending');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].channel, 'system');
  assert.equal(f.requests[0].componentName, null); assert.equal(f.requests[0].sessionGroup, 'origin');
  assert.equal(f.checks(), 0); assert.equal(f.errors.length, 0);
});

for (const args of [['--channel', 'telegram', '--endpoint', 'ep1'],
  ['--channel', 'telegram', '--no-reply'], ['--channel', 'system', '--no-reply']]) {
  test(`explicit channel input remains authentication rejected: ${args.join(' ')}`, async t => {
    const f = await fixture(t);
    const { result, row } = await f.receive(args);
    assert.equal(result.action, 'auth_rejected'); assert.equal(row.status, 'failed');
    assert.equal(row.delivery_action, 'auth_rejected');
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].componentName, args[1]);
    assert.equal(f.checks(), 1); assert.equal(f.errors.length, 0);
  });
}
