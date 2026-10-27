import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixture } from './c4-v2-test-helpers.js';

const scripts = new URL('../', import.meta.url);
async function cli(root, name, args) {
  const child = spawn(process.execPath, [new URL(name, scripts).pathname, ...args], {
    env: { ...process.env, ZYLOS_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const [status, signal] = await once(child, 'close');
    assert.equal(signal, null, stderr);
    return { status, stdout, stderr, json: JSON.parse(stdout) };
  } finally { clearTimeout(timer); }
}

test('IF-05/DM-51 actual receive CLI uses real P04 F14 append, queries it, and survives a read-only directory', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'comm-bridge');
  fs.mkdirSync(data);
  const f = fixture(t, {}, path.join(data, 'c4.db'));
  f.db.pragma('journal_mode=WAL');
  fs.mkdirSync(path.join(root, '.claude/skills/chat'), { recursive: true });
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
  const monitor = path.join(root, 'activity-monitor');
  fs.mkdirSync(monitor);
  let authResult = 'failed';
  const server = net.createServer(socket => {
    let input = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]);
      socket.end(JSON.stringify({ version: 2, type: 'route', requestId: request.requestId,
        decision: 'auth_rejected', recovered: false, runtime: 'codex', health: 'auth_failed',
        reason: 'auth_failed', transitionHold: false,
        auth: { result: authResult, detail: `historical ${authResult}\u0000 evidence` } }) + '\n');
    });
  });
  server.listen(path.join(monitor, 'am.sock'));
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const logfile = path.join(data, 'receive-events.jsonl');
  const receive = () => cli(root, 'c4-receive.js', ['--channel', 'chat', '--endpoint', 'room|msg:1',
    '--content', 'rejected message', '--no-reply', '--json']);
  const query = id => cli(root, 'c4-db.js', ['rejection', '--id', String(id), '--json']);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const databaseBytes = () => [f.filename, f.filename + '-wal'].map(hash);
  for (const result of ['failed', 'unconfirmed']) {
    authResult = result;
    const reply = await receive();
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(reply.json.reasonLogged, true);
    assert.equal(reply.json.action, 'auth_rejected');
    const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(reply.json.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.delivery_action, 'auth_rejected');
    const event = JSON.parse(fs.readFileSync(logfile, 'utf8').trim().split('\n').at(-1));
    assert.equal(event.conversation_id, row.id);
    assert.equal(event.reason_code, `auth_check_${result}`);
    assert.equal(event.runtime, 'codex');
    assert.equal(event.detail, `historical ${result} evidence`);
    assert.equal(event.v, 1);
    assert.ok(Number.isSafeInteger(event.ts));
    const before = hash(logfile);
    const dbBefore = databaseBytes();
    const found = await query(row.id);
    assert.equal(found.status, 0, found.stderr);
    assert.deepEqual(found.json.data, { status: 'failed', category: 'auth_rejected',
      reason_code: event.reason_code, detail: event.detail, runtime: event.runtime, ts: event.ts });
    assert.equal(hash(logfile), before);
    assert.deepEqual(databaseBytes(), dbBefore, 'query must not write the database');
  }
  const rotated = path.join(data, 'receive-events.123.jsonl');
  fs.renameSync(logfile, rotated);
  assert.equal((await query(1)).json.data.reason_code, 'auth_check_failed');
  assert.equal((await query(2)).json.data.reason_code, 'auth_check_unconfirmed');
  // Move the retained log outside the reader's set, then deny file creation.
  fs.renameSync(rotated, path.join(data, 'retained-evidence'));
  fs.chmodSync(data, 0o500);
  try {
    assert.throws(() => fs.writeFileSync(path.join(data, 'permission-probe'), ''), { code: 'EACCES' });
    const reply = await receive();
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(reply.json.ok, true);
    assert.equal(reply.json.action, 'auth_rejected');
    assert.equal(reply.json.reasonLogged, false);
    assert.match(reply.stderr, /entry event auth_rejected append failed: EACCES/);
    assert.equal(fs.existsSync(logfile), false);
    const row = f.db.prepare('SELECT status,delivery_action FROM conversations WHERE id=?').get(reply.json.id);
    assert.deepEqual(row, { status: 'failed', delivery_action: 'auth_rejected' });
    const found = await query(reply.json.id);
    assert.equal(found.status, 0, found.stderr);
    assert.deepEqual(found.json.data, { status: 'failed', category: 'auth_rejected', reason: 'expired_or_missing' });
  } finally { fs.chmodSync(data, 0o700); }
  const old = await query(1);
  assert.equal(old.json.data.reason, 'expired_or_missing', 'missing historical log must not invent a reason');
  const recovered = await receive();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.json.reasonLogged, true, 'restoring permission must restore real append');
});
