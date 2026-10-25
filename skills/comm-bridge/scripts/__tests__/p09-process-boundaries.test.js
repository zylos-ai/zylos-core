import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fixture } from './c4-v2-test-helpers.js';
import { ipcRoute, queryRoute } from '../c4-entry-route.js';
import { queryRejection } from '../c4-entry-events.js';

const scripts = new URL('../', import.meta.url);
const moduleURL = name => new URL(name, scripts).href;
const databaseModule = createRequire(import.meta.url).resolve('better-sqlite3');
const pending = { decision: 'pending', recovered: true, runtime: 'codex', health: 'rate_limited', reason: 'quota', transitionHold: false };
const auth = { decision: 'auth_rejected', recovered: false, runtime: 'codex', health: 'auth_failed', reason: 'auth_failed', transitionHold: false, auth: { result: 'failed', detail: 'original rejection' } };

function startChild(t, source, args = []) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  exited.finally(() => clearTimeout(timer));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  return { child, exited, stderr: () => stderr,
    message: () => Promise.race([once(child, 'message').then(([value]) => value), exited.then(() => { throw new Error('child exited before barrier: ' + stderr); })]) };
}

function receiveChild(filename, mode, eventFile) {
  return `import Database from ${JSON.stringify(databaseModule)};
    import { createStore } from ${JSON.stringify(moduleURL('c4-v2-store.js'))};
    import { receive } from ${JSON.stringify(moduleURL('c4-receive.js'))};
    import fs from 'node:fs';
    const db = new Database(${JSON.stringify(filename)}); db.pragma('busy_timeout=3000');
    const store = createStore(db, { validateComponent: () => true,
      readConfig: () => ({ state: 'ok', config: {runtime:'codex',session_mode:'multi'} }), validateModel: () => true });
    const pause = label => { process.send({ label, inTransaction: db.inTransaction }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); };
    if (${JSON.stringify(mode)} === 'before') {
      db.function('hold_commit', () => { pause('before'); return 0; });
      db.exec('CREATE TEMP TRIGGER hold_insert AFTER INSERT ON conversations BEGIN SELECT hold_commit(); END');
    }
    const insert = store.insertConversation;
    const wrapped = {...store, insertConversation: (...args) => { const row = insert(...args);
      if (${JSON.stringify(mode)} === 'after') pause('after'); return row; }};
    await receive(['--channel','chat','--content','original','--session-group','Team','--no-reply'], {
      db: wrapped, queryRoute: async () => (${JSON.stringify(auth)}),
      appendEntryEvent: async event => { fs.appendFileSync(${JSON.stringify(eventFile)}, JSON.stringify(event)+'\\n'); return true; }
    });
    db.close(); process.exit(0);`;
}

test('IF-05 SIGKILL before commit rolls back D1/D5/D6; after commit retains terminal rejection before F14', { timeout: 15000 }, async t => {
  fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'chat'), { recursive: true });
  for (const mode of ['before', 'after']) {
    const f = fixture(t, {}, true), eventFile = path.join(path.dirname(f.filename), 'events.jsonl');
    const child = startChild(t, receiveChild(f.filename, mode, eventFile));
    const barrier = await child.message();
    assert.equal(barrier.label, mode);
    assert.equal(barrier.inTransaction, mode === 'before');
    child.child.kill('SIGKILL');
    assert.deepEqual(await child.exited, [null, 'SIGKILL']);
    assert.equal(child.stderr(), '');
    const expected = mode === 'before' ? 0 : 1;
    for (const table of ['conversations', 'channel_namespaces', 'group_heads']) {
      assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, expected, `${mode} ${table}`);
    }
    if (expected) {
      const row = f.db.prepare('SELECT status,delivery_action,session_group FROM conversations').get();
      assert.deepEqual(row, { status: 'failed', delivery_action: 'auth_rejected', session_group: 'chat:Team' });
    }
    assert.equal(fs.existsSync(eventFile), false, 'F14 cannot precede successful commit');
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
  }
});

test('IF-02 simultaneous first receives commit one namespace and consistent final group without rerouting', { timeout: 15000 }, async t => {
  fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'chat'), { recursive: true });
  const f = fixture(t, {}, true);
  const source = `import Database from ${JSON.stringify(databaseModule)};
    import { createStore } from ${JSON.stringify(moduleURL('c4-v2-store.js'))};
    import { receive } from ${JSON.stringify(moduleURL('c4-receive.js'))};
    const db = new Database(process.argv[1]); db.pragma('busy_timeout=3000');
    const store = createStore(db, { validateComponent: () => true,
      readConfig: () => ({state:'ok',config:{runtime:'codex',session_mode:'multi'}}),validateModel:()=>true });
    let routes=0;
    const result=await receive(['--channel','chat','--endpoint','room','--content',String(process.pid),'--session-group','Team'],{
      db:store,queryRoute:async request=>{ routes++; process.send({preGroup:request.sessionGroup});
        await new Promise(resolve=>process.once('message',resolve)); return ${JSON.stringify(pending)}; }});
    process.send({result,routes}); db.close(); process.exit(0);`;
  const children = [startChild(t, source, [f.filename]), startChild(t, source, [f.filename])];
  assert.deepEqual(await Promise.all(children.map(child => child.message())), [{ preGroup: null }, { preGroup: null }]);
  const results = children.map(child => child.message());
  children.forEach(child => child.child.send('commit'));
  const replies = await Promise.all(results);
  for (const reply of replies) { assert.equal(reply.routes, 1); assert.equal(reply.result.sessionGroup, 'chat:Team'); }
  assert.notEqual(replies[0].result.id, replies[1].result.id);
  for (const child of children) { assert.deepEqual(await child.exited, [0, null]); assert.equal(child.stderr(), ''); }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM group_heads').get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE session_group='chat:Team' AND status='pending'").get().n, 2);
});

async function socketServer(t, response) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p09-socket-'));
  const socketPath = path.join(dir, 'am.sock'), requests = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => { buffer += chunk; if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]); requests.push(request); response(socket, request); });
    socket.on('error', () => {});
  });
  server.listen(socketPath); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socketPath, requests };
}

test('IB-02 real socket accepts fragmented v2 replies and rejects malformed/correlation/timeout with one fallback', { timeout: 10000 }, async t => {
  const request = { version: 2, type: 'route', requestId: 'socket-case', noReply: true };
  const cases = [
    (socket, req) => { const bytes = JSON.stringify({ version: 2, type: 'route', requestId: req.requestId, ...pending }) + '\n'; socket.write(bytes.slice(0, 10)); socket.end(bytes.slice(10)); },
    socket => socket.end('{malformed}\n'),
    socket => socket.end(JSON.stringify({ version: 2, type: 'route', requestId: 'wrong', ...pending }) + '\n'),
    socket => socket.end('{"version":2'),
    () => {},
  ];
  for (const [index, response] of cases.entries()) {
    const server = await socketServer(t, response); let fallback = 0;
    const result = await queryRoute(request, { ipcRoute: req => ipcRoute(req, { socketPath: server.socketPath, timeoutMs: 100 }),
      fallbackFileRoute: () => { fallback++; return { fallback: true }; } });
    assert.equal(fallback, index === 0 ? 0 : 1);
    assert.equal(result.fallback, index === 0 ? undefined : true);
    assert.deepEqual(server.requests, [request]);
  }
});

test('IF-06 rejection lookup rescans real rename race and never invents a missing historical reason', t => {
  const f = fixture(t, {}, true), filename = path.join(path.dirname(f.filename), 'receive-events.jsonl');
  const row = f.store.insertConversation('in', 'chat', null, 'rejected', { status: 'failed', deliveryAction: 'auth_rejected' });
  fs.writeFileSync(filename, JSON.stringify({ v: 1, event: 'auth_rejected', conversation_id: row.id, reason_code: 'auth_check_failed', detail: 'then', runtime: 'codex', ts: 10 }) + '\n');
  let rotated = false;
  const io = { ...fs, readFileSync(file, encoding) {
    if (!rotated && file === filename) { rotated = true; fs.renameSync(filename, filename.replace('.jsonl', '.100.jsonl')); }
    return fs.readFileSync(file, encoding);
  } };
  const deps = { filename, io, getConversationsByRange: (a, b) => f.db.prepare('SELECT status,delivery_action FROM conversations WHERE id BETWEEN ? AND ?').all(a, b) };
  assert.equal(queryRejection(String(row.id), deps).detail, 'then');
  assert.equal(rotated, true);
  assert.deepEqual(queryRejection(String(row.id), { ...deps, filename: path.join(path.dirname(filename), 'expired.jsonl') }),
    { status: 'failed', category: 'auth_rejected', reason: 'expired_or_missing' });
});

test('IF-06 actual rejection CLI preserves database/log bytes across success and rejection errors', { timeout: 10000 }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p09-rejection-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, 'comm-bridge'); fs.mkdirSync(dataDir);
  const f = fixture(t, {}, path.join(dataDir, 'c4.db'));
  f.db.pragma('journal_mode=WAL');
  const rejected = f.store.insertConversation('in', 'chat', null, 'old', { status: 'failed', deliveryAction: 'auth_rejected' });
  const queued = f.store.insertConversation('in', 'chat', null, 'new');
  const logfile = path.join(dataDir, 'receive-events.jsonl');
  fs.writeFileSync(logfile, JSON.stringify({ v: 1, event: 'auth_rejected', conversation_id: rejected.id, reason_code: 'auth_check_unconfirmed', detail: 'historical', runtime: 'codex', ts: 20 }) + '\n');
  f.db.pragma('wal_checkpoint(TRUNCATE)');
  f.db.close();
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = [hash(f.filename), hash(logfile)];
  for (const [id, status, code] of [[String(rejected.id), 0], [String(queued.id), 1, 'NOT_REJECTED'], ['999', 1, 'NOT_FOUND'], ['0', 1, 'INVALID_ARGS']]) {
    const result = spawnSync(process.execPath, [new URL('c4-db.js', scripts).pathname, 'rejection', '--id', id, '--json'], { env: { ...process.env, ZYLOS_DIR: dir }, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, status, result.stderr + result.stdout);
    const json = JSON.parse(result.stdout);
    if (status === 0) { assert.equal(json.data.detail, 'historical'); assert.equal(json.data.reason_code, 'auth_check_unconfirmed'); }
    else assert.equal(json.error.code, code);
    assert.deepEqual([hash(f.filename), hash(logfile)], before);
  }
});
