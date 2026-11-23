import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fixture } from './c4-v2-test-helpers.js';
import { ipcRoute, queryRoute } from '../c4-entry-route.js';

const scripts = new URL('../', import.meta.url);
const moduleURL = name => new URL(name, scripts).href;
const databaseModule = createRequire(import.meta.url).resolve('better-sqlite3');
const pending = { decision: 'pending', recovered: true, runtime: 'codex', health: 'rate_limited', reason: 'quota', transitionHold: false };

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

test('simultaneous first receives commit one namespace and consistent final group without rerouting', { timeout: 15000 }, async t => {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-routing-socket-'));
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

test('real socket accepts fragmented v2 replies and rejects malformed/correlation/timeout with one fallback', { timeout: 10000 }, async t => {
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
