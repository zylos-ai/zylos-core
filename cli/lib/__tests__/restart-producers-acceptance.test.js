import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { requestRuntimeRestart } from '../request-runtime-restart.js';
import { submit } from '../am-sock-client.js';
import { upgradeRuntime } from '../../../skills/upgrade-claude/scripts/upgrade.js';
import { main as restartMain } from '../../../skills/restart-claude/scripts/restart.js';
async function fixture(t, response) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-producers-')); const socketPath = path.join(root, 'am.sock');
  const requests = [], peers = new Set(), trace = [];
  const server = net.createServer(socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
    let bytes = ''; socket.on('data', chunk => { bytes += chunk; if (!bytes.includes('\n')) return;
      const request = JSON.parse(bytes.slice(0, bytes.indexOf('\n'))); requests.push(request); trace.push('submit');
      if (response === 'timeout') return;
      if (response === 'uncertain') socket.end('{"ok":');
      else socket.end(JSON.stringify({ version: 1, type: request.type, requestId: request.requestId,
        ...(response === 'accepted' ? { ok: true, result: 'accepted', runCount: 2 } : { ok: false, code: 'manual_restart_pending' }) }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const restart = (options = {}) => requestRuntimeRestart({ ...options, readMode: () => ({ mode: 'multi' }), readTransition: () => null,
    send: (request, options) => submit(request, { ...options, socketPath, replyMaxMs: 20 }), lookup: async () => { trace.push('lookup'); return 'unknown'; },
    enqueueExit: () => { throw new Error('must not fallback to /exit'); } });
  return { root, requests, trace, restart };
}
async function invoke(t, producer, response) {
  const f = await fixture(t, response), output = [];
  const restart = async (options) => {
    return f.restart(options);
  };
  const priorExitCode = process.exitCode;
  const capture = (...args) => { output.push(args.join(' ')); return true; };
  const mocks = [t.mock.method(console, 'log', capture), t.mock.method(console, 'error', capture),
    t.mock.method(process.stdout, 'write', capture)];
  try {
    if (producer === 'restart') {
      await restartMain(['--json'], { requestRestart: restart });
    } else {
      const result = await upgradeRuntime({ readMode: () => ({ mode: 'multi' }), readTransition: () => null,
        install: () => f.trace.push('install'), requestRestart: restart,
        enqueue: () => { throw new Error('must not enqueue'); }, waitForExit: () => { throw new Error('must not poll'); } });
      output.push(JSON.stringify(result));
    }
  } finally {
    for (const mock of mocks) mock.mock.restore();
    process.exitCode = priorExitCode;
  }
  assert.equal(f.requests.length, 1, `${producer}/${response} submits exactly once`);
  assert.equal(f.requests[0].type, 'restart_all'); assert.equal(f.requests[0].reason, 'upgrade');
  assert.deepEqual(f.trace, [...(producer === 'upgrade' ? ['install'] : []), 'submit', ...(['uncertain', 'timeout'].includes(response) ? ['lookup'] : [])]);
  const all = output.join('\n');
  if (response === 'rejected') assert.match(all, /manual_restart_pending/);
  if (['uncertain', 'timeout'].includes(response)) assert.match(all, /restart_result_unknown/);
  if (response === 'accepted') assert.match(all, /accepted/);
}
test('restart and upgrade producers cover Unix socket success, refusal and uncertain result', async t => {
  for (const producer of ['restart', 'upgrade']) for (const response of ['accepted', 'rejected', 'uncertain', 'timeout']) await invoke(t, producer, response);
});
