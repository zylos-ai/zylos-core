import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestRelease } from '../supervisor-request.js';

test('release request binds only inherited group and run, with no target override', async () => {
  for (const env of [{}, { ZYLOS_SESSION_GROUP: 'origin' }, { ZYLOS_RUN_ID: 'r' },
    { ZYLOS_SESSION_GROUP: '../bad', ZYLOS_RUN_ID: 'r' },
    { ZYLOS_SESSION_GROUP: 'origin', ZYLOS_RUN_ID: '   ' }]) {
    const result = await requestRelease({ env, send: () => assert.fail('must not send') });
    assert.equal(result.error.code, 'NO_SESSION_ENV'); assert.deepEqual(result.error.persisted, []);
  }
  const env = { ZYLOS_SESSION_GROUP: 'telegram:a', ZYLOS_RUN_ID: 'run' };
  for (const result of ['accepted', 'already_accepted']) {
    let sent;
    const response = await requestRelease({ env, sessionGroup: 'telegram:other', expectedRunId: 'other',
      send: async request => { sent = request; return { kind: 'accepted', sent: true, reply: { result } }; } });
    assert.deepEqual(sent, { version: 1, type: 'request_release', requestId: sent.requestId,
      sessionGroup: 'telegram:a', expectedRunId: 'run' });
    assert.match(sent.requestId, /^release-/);
    assert.deepEqual(response, { ok: true, data: { result, sessionGroup: 'telegram:a', expectedRunId: 'run' } });
  }
});

test('release CLI sends inherited identity to the real socket and reports acceptance', {timeout:15000}, async t => {
  const net = await import('node:net');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../supervisor-request.js', import.meta.url));
  const directory = fs.mkdtempSync(path.join(process.env.ZYLOS_DIR, 'release-cli-'));
  fs.mkdirSync(path.join(directory, 'activity-monitor'));
  const socketPath = path.join(directory, 'activity-monitor', 'am.sock');
  let sent, child;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      sent = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      socket.end(JSON.stringify({ version: 1, type: sent.type, requestId: sent.requestId,
        ok: true, result: 'accepted' }) + '\n');
    });
  });
  t.after(async () => {
    if(child && child.exitCode===null && child.signalCode===null){
      const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;
    }
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  child = spawn(process.execPath, [script, 'request-release', '--json'], {
    env: { ...process.env, ZYLOS_DIR: directory, ZYLOS_SESSION_GROUP: 'telegram:a', ZYLOS_RUN_ID: 'run' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16384); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(status, 0, stderr);
  assert.deepEqual(sent, { version: 1, type: 'request_release', requestId: sent.requestId,
    sessionGroup: 'telegram:a', expectedRunId: 'run' });
  assert.deepEqual(JSON.parse(stdout), { ok: true,
    data: { result: 'accepted', sessionGroup: 'telegram:a', expectedRunId: 'run' } });
});
