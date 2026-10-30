import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { validateReply } from '../../../../cli/lib/am-sock-client.js';
import { validStartAttemptReply } from '../../../comm-bridge/scripts/router/activation.js';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { createSupervisorConnectionHandler } from '../router-socket.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

// is a contract-fixture test: real socket parser/admission and real dispatcher
// scheduler, injected runtime scene/transport boundaries; no runtime is launched.
async function socketFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'start-attempt-protocol-')));
  const health = new RuntimeHealthCoordinator({ zylosDir: root, readMode: () => 'multi',
    resolveTargetRuntime: () => 'claude', listScenes: () => [] });
  const store = health.store('claude'); const state = store.read();
  state.health = 'unavailable'; store.write(state);
  const before = fs.readFileSync(store.file, 'utf8');
  const admission = new SupervisorAdmission({ startAttempt: request => health.registerStartAttempt(request) });
  admission.openEntry();
  const handler = createSupervisorConnectionHandler({ admission });
  const peers = new Set();
  const server = net.createServer(socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)); handler(socket); });
  const sock = path.join(root, 'am.sock'); server.listen(sock); await once(server, 'listening');
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
    await handler.drain(); fs.rmSync(root, { recursive: true, force: true });
  });
  const send = async request => {
    const socket = net.createConnection(sock); socket.setTimeout(3000, () => socket.destroy(new Error('socket timeout')));
    await once(socket, 'connect'); let text = ''; socket.on('data', chunk => { text += chunk; });
    socket.write(typeof request === 'string' ? request : `${JSON.stringify(request)}\n`);
    await once(socket, 'end'); socket.destroy(); return JSON.parse(text);
  };
  return { send, unchanged: () => assert.equal(fs.readFileSync(store.file, 'utf8'), before) };
}

test('A absent group/run keys are rejected over am.sock without a health write', async t => {
  const f = await socketFixture(t);
  for (const missing of ['sessionGroup', 'runId']) {
    const request = { version: 1, type: 'start_attempt', requestId: 'sa-1800000000000-0123456789ab', runtime: 'claude', sessionGroup: 'telegram:a', runId: randomUUID() };
    delete request[missing];
    assert.deepEqual(await f.send(request), { version: 1, type: 'start_attempt', requestId: request.requestId, ok: false, code: 'invalid_request' });
    f.unchanged();
  }
  const valid = await f.send({ version: 1, type: 'start_attempt', requestId: 'sa-1800000000000-0123456789ab', runtime: 'claude', sessionGroup: 'telegram:a', runId: randomUUID() });
  assert.equal(valid.result, 'registered', 'same fixture accepts all required valid keys');
});

test('A unparseable input returns a public rejection trusted by both clients', async t => {
  const f = await socketFixture(t);
  const request = { version: 1, type: 'start_attempt', requestId: 'sa-1800000000000-0123456789ab' };
  for (const line of ['{"type":"start_attempt","requestId":\n', '[]\n', 'null\n']) {
    const reply = await f.send(line);
    assert.deepEqual(reply, { ok: false, code: 'invalid_request' });
    assert.equal(validateReply(request, reply), true, 'CLI trusts the public rejection');
    assert.equal(validStartAttemptReply(reply, request), true, 'dispatcher trusts the public rejection');
    f.unchanged();
  }
});

test('A parsed start_attempt with missing or nonstring requestId returns a null-ID envelope', async t => {
  const f = await socketFixture(t);
  for (const id of [{}, { requestId: null }, { requestId: 123 }]) {
    const request = { version: 1, type: 'start_attempt', runtime: 'claude', sessionGroup: 'telegram:a', runId: randomUUID(), ...id };
    assert.deepEqual(await f.send(request), { version: 1, type: 'start_attempt', requestId: null, ok: false, code: 'invalid_request' });
    f.unchanged();
  }
});

const invalidReplies = [
  ['registered missing reason', () => ({ ok: true, result: 'registered' })],
  ['not_restricted with reason', () => ({ ok: true, result: 'not_restricted', reason: 'recovery_due' })],
  ['backoff missing notBefore', () => ({ ok: false, code: 'attempt_backoff' })],
  ['notBefore in seconds', () => ({ ok: false, code: 'attempt_backoff', notBefore: 1800000060 })],
  ['unknown code', () => ({ ok: false, code: 'unknown' })],
  ['probe_inflight with notBefore', () => ({ ok: false, code: 'probe_inflight', notBefore: 1800000060000 })],
  ['registered with forbidden notBefore', () => ({ ok: true, result: 'registered', reason: 'recovery_due', notBefore: 1800000060000 })],
];
for (const [name, value] of invalidReplies) test(`B ${name}: no launch, diagnostic, fresh next-round IDs`, async t => {
  const f = routerFixture(t); f.put('origin', { runtime: 'codex' }); const row = f.add('a');
  f.health.set('claude', { health: 'unavailable' }); const submitted = [];
  f.deps.submit = async request => {
    submitted.push(request); const reply = { version: 1, type: request.type, requestId: request.requestId, ...value() };
    return { kind: reply.ok ? 'accepted' : 'rejected', sent: true, reply };
  };
  const router = f.create(); await router.initialize();
  for (let warm = 0; submitted.length === 0 && warm < 4; warm++) await f.rounds(1);
  for (let n = 1; n <= 2; n++) {
    if (n > 1) await f.rounds(1);
    assert.equal(submitted.length, n, 'exactly one attempt per normal scheduling round');
    assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
    assert.equal(f.row(row.id).status, 'pending'); assert.equal(f.row(row.id).retry_count, 0);
    assert.equal(f.events.filter(event => event.code === 'start_attempt_protocol_error').length, n);
  }
  assert.notEqual(submitted[0].requestId, submitted[1].requestId);
  assert.notEqual(submitted[0].runId, submitted[1].runId);
});

test('B valid backoff does not delay next round and an extra-field grant launches its requested run', async t => {
  const f = routerFixture(t); f.put('origin', { runtime: 'codex' }); f.add('a');
  f.health.set('claude', { health: 'unavailable' }); const submitted = [];
  f.deps.submit = async request => {
    submitted.push(request);
    return submitted.length === 1
      ? { kind: 'rejected', sent: true, reply: { version: 1, type: request.type, requestId: request.requestId, ok: false, code: 'attempt_backoff', notBefore: f.now() + 3600000 } }
      : { kind: 'accepted', sent: true, reply: { version: 1, type: request.type, requestId: request.requestId, ok: true, result: 'registered', reason: 'recovery_due', future: { allowed: true } } };
  };
  const router = f.create(); await router.initialize(); const now = f.now();
  for (let warm = 0; submitted.length === 0 && warm < 4; warm++) await f.rounds(1);
  assert.equal(submitted.length, 1); assert.equal(f.calls.filter(row => row[0] === 'launch').length, 0);
  await f.rounds(1); assert.equal(f.now(), now, 'no wait for advisory notBefore');
  assert.equal(submitted.length, 2); const launched = f.calls.filter(row => row[0] === 'launch');
  assert.equal(launched.length, 1); assert.equal(launched[0][1].runId, submitted[1].runId);
  assert.notEqual(submitted[0].requestId, submitted[1].requestId); assert.notEqual(submitted[0].runId, submitted[1].runId);
  assert.equal(f.events.filter(event => event.code === 'start_attempt_protocol_error').length, 0);
});
