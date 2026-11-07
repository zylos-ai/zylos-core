import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeMessages, runtimeAnswer } from './helpers/chat-runtime-messages.js';
import { parseC4Content, validateAnswer } from '../../comm-bridge/scripts/c4-content-schema.js';
import { chatEnabled, createChatSandbox, chatResourceCounts } from './helpers/chat-integration-harness.js';

// Gate coverage is always safe: it never requests a case sandbox or resource.
// Isolation and lifecycle coverage run only during an explicitly requested
// integration run. Changes to harness gating, proof or cleanup require them;
// ordinary product-only changes may skip them together with integration cases.
const enabled = chatEnabled();
const loop = fileURLToPath(new URL('./helpers/chat-runtime-loop.js', import.meta.url));

test('chat gates reject absent switches before fixture allocation', () => {
  const before = fs.readdirSync('/tmp').filter(name => name.startsWith('chat-case-')).length;
  for (const env of [{}, { ZYLOS_CHAT_RUNTIME: '1' }, { ZYLOS_CHAT_INTEGRATION: '0', ZYLOS_CHAT_RUNTIME: '1' }]) {
    assert.equal(createChatSandbox(null, { gateEnv: env }), null);
    assert.equal(createChatSandbox(null, { gateEnv: env, runtime: true }), null);
  }
  assert.equal(createChatSandbox(null, { gateEnv: { ZYLOS_CHAT_INTEGRATION: '1' }, runtime: true }), null);
  assert.equal(fs.readdirSync('/tmp').filter(name => name.startsWith('chat-case-')).length, before);
  for (const count of Object.values(chatResourceCounts())) assert.equal(count, 0);
});

test('every missing isolation proof prevents HTTP and runtime startup', { skip: !enabled }, async t => {
  const sandbox = createChatSandbox(t);
  const proofs = ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => {
    const env = { ...sandbox.env }; delete env[key]; return { env };
  });
  proofs.push({ socket: null }, { databases: [sandbox.paths.c4Db] });
  for (const proof of proofs) {
    const server = http.createServer();
    await assert.rejects(sandbox.startHttp(server, proof));
    assert.throws(() => sandbox.startChild(process.execPath, ['-e', 'process.exit(99)'], { proof }));
    assert.equal(server.listening, false);
    assert.equal(sandbox.counts.http, 0);
    assert.equal(sandbox.counts.runtime, 0);
  }
});

async function lifecycle(t, failEarly) {
  const sandbox = createChatSandbox(t);
  const server = http.createServer((req, res) => res.end('private'));
  let child, chunks = 0;
  const livePids = [];
  const error = failEarly ? /first counterexample/ : /timed out/;
  await assert.rejects(sandbox.runCase(async ({ signal }) => {
    await sandbox.startHttp(server);
    child = sandbox.startChild(process.execPath, [loop]);
    livePids.push(child.pid);
    child.stdout.on('data', bytes => {
      chunks++;
      const match = bytes.toString().match(/"child":(\d+)/);
      if (match) livePids.push(Number(match[1]));
    });
    // This bounded readiness wait proves the producer ran before cleanup.
    for (let n = 0; n < 100 && chunks < 3 && !signal.aborted; n++) await delay(10);
    assert.ok(chunks >= 3, 'Recurring work actually started');
    if (failEarly) throw Error('first counterexample');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  }, { timeoutMs: failEarly ? 2000 : 500 }), error);
  assert.equal(server.listening, false);
  assert.equal(fs.existsSync(sandbox.root), false);
  assert.equal(sandbox.children.size, 0);
  const stoppedChunks = chunks;
  await delay(60);
  assert.equal(chunks, stoppedChunks, 'Output loop stopped after cleanup');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.ok(livePids.length >= 2, 'A real grandchild participated');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false; throw error;
  } };
  for (let attempt = 0; attempt < 50 && livePids.some(alive); attempt++) await delay(10);
  for (const pid of livePids) assert.equal(alive(pid), false, `Child ${pid} exited`);
  assert.equal(sandbox.counts.http, 1);
  assert.equal(sandbox.counts.runtime, 1);
}

test('case timeout reaps real child work and its private HTTP resources', { skip: !enabled, timeout: 5000 }, t => lifecycle(t, false));
test('first counterexample stops recurring work and recovers private resources', { skip: !enabled, timeout: 5000 }, t => lifecycle(t, true));

// A credential-free protocol check prevents a stale native-runtime fixture from
// spending a model call only to fail at the channel schema boundary.
test('native runtime messages and every answer action satisfy the shared protocol', () => {
  const fixture = runtimeMessages();
  assert.equal(fixture.questions.length, 4);
  for (const message of fixture.messages.slice(1)) assert.equal(parseC4Content(message).kind, 'envelope');
  for (const question of fixture.questions) {
    assert.equal(validateAnswer(runtimeAnswer(question), question), true);
    assert.ok(question.questionSummary.includes(fixture.nonce));
  }
});
