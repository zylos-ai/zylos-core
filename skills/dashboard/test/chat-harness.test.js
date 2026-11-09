import test from 'node:test';
import strictAssert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeMessages, runtimeAnswer } from './helpers/chat-runtime-messages.js';
import { parseC4Content, validateAnswer } from '../../comm-bridge/scripts/c4-content-schema.js';
import { chatEnabled, createChatSandbox, chatResourceCounts } from './helpers/chat-integration-harness.js';

let assertionCalls = 0;
const assert = new Proxy(strictAssert, { get(target, key) {
  const value = Reflect.get(target, key);
  return typeof value === 'function' ? (...args) => { assertionCalls++; return value(...args); } : value;
} });
test.after(() => console.log(`Chat harness direct assertion calls: ${assertionCalls}`));

// Gate coverage is always safe: it never requests a case sandbox or resource.
// Isolation and lifecycle coverage run only during an explicitly requested
// integration run. Changes to harness gating, proof or cleanup require them;
// ordinary product-only changes may skip them together with integration cases.
const enabled = chatEnabled();
const loop = fileURLToPath(new URL('./helpers/chat-runtime-loop.js', import.meta.url));

test('chat gates reject absent switches before fixture allocation', () => {
  const before = chatResourceCounts();
  for (const env of [{}, { ZYLOS_CHAT_RUNTIME: '1' }, { ZYLOS_CHAT_INTEGRATION: '0', ZYLOS_CHAT_RUNTIME: '1' }]) {
    assert.equal(createChatSandbox(null, { gateEnv: env }), null);
    assert.equal(createChatSandbox(null, { gateEnv: env, runtime: true }), null);
  }
  assert.equal(createChatSandbox(null, { gateEnv: { ZYLOS_CHAT_INTEGRATION: '1' }, runtime: true }), null);
  for (const [kind, count] of Object.entries(chatResourceCounts())) assert.equal(count, before[kind]);
});

// Integration opt-in only: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR, socket
// and both DB paths are read back; malformed proof must stop before startup.
test('missing or realistic foreign isolation paths prevent HTTP and runtime startup', { skip: !enabled }, async t => {
  const sandbox = createChatSandbox(t);
  assert.equal(path.dirname(sandbox.root), fs.realpathSync(process.env.TMPDIR));
  assert.equal(sandbox.paths.parentTmp, fs.realpathSync(process.env.TMPDIR));
  const proofs = ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => {
    const env = { ...sandbox.env }; delete env[key]; return { env };
  });
  const outsideDbDirectory = path.join(sandbox.root, 'outside'); fs.mkdirSync(outsideDbDirectory);
  proofs.push({ socket: '/tmp/tmux-1000/default' }, { databases: [sandbox.paths.c4Db] },
    { databases: [sandbox.paths.c4Db, sandbox.paths.dashboardDb, path.join(outsideDbDirectory, 'c4.db')] },
    { env: { ...sandbox.env, HOME: process.env.HOME } },
    { env: { ...sandbox.env, TMUX_TMPDIR: process.env.TMPDIR } },
    { env: { ...sandbox.env, CODEX_HOME: path.join(process.env.HOME, '.codex') } },
    { env: { ...sandbox.env, CLAUDE_CONFIG_DIR: path.join(sandbox.paths.home, '.claude') } });
  for (const proof of proofs) {
    const server = http.createServer();
    await assert.rejects(sandbox.startHttp(server, proof), { code: 'ERR_ASSERTION' });
    const env = proof.env ? Object.fromEntries([...new Set([...Object.keys(sandbox.env), ...Object.keys(proof.env)])]
      .map(key => [key, proof.env[key]])) : undefined;
    assert.throws(() => sandbox.startChild(process.execPath, ['-e', 'process.exit(99)'], { proof, env }), { code: 'ERR_ASSERTION' });
    assert.equal(server.listening, false);
    assert.equal(sandbox.counts.http, 0);
    assert.equal(sandbox.counts.runtime, 0);
  }
  assert.throws(() => sandbox.startChild(process.execPath, ['-e', 'process.exit(99)'], {
    env: { HOME: process.env.HOME }, proof: { env: sandbox.env },
  }), { code: 'ERR_ASSERTION' }, 'A valid proof.env cannot hide the actual foreign child HOME');
  for (const cwd of [process.cwd(), null, undefined]) {
    assert.throws(() => sandbox.startChild(process.execPath, ['-e', 'process.exit(99)'], {
      cwd,
    }), { code: 'ERR_ASSERTION' }, 'Child cwd cannot bypass the private instance');
  }
  assert.equal(sandbox.counts.runtime, 0);
});

// Integration opt-in only: all expected env values stay unchanged while one
// private directory redirects through a symlink; proof must reject before use.
test('a redirected private directory prevents HTTP and child startup', { skip: !enabled }, async t => {
  const sandbox = createChatSandbox(t);
  const original = path.join(sandbox.root, 'original-tmp');
  const redirected = path.join(sandbox.root, 'redirected-tmp');
  fs.renameSync(sandbox.paths.tmp, original);
  fs.mkdirSync(redirected);
  fs.symlinkSync(redirected, sandbox.paths.tmp, 'dir');
  try {
    const server = http.createServer();
    await assert.rejects(sandbox.startHttp(server), { code: 'ERR_ASSERTION' });
    assert.throws(() => sandbox.startChild(process.execPath, ['-e', 'process.exit(99)']), { code: 'ERR_ASSERTION' });
    assert.equal(server.listening, false);
    assert.equal(sandbox.counts.http, 0);
    assert.equal(sandbox.counts.runtime, 0);
  } finally {
    fs.unlinkSync(sandbox.paths.tmp);
    fs.renameSync(original, sandbox.paths.tmp);
  }
});

// Integration opt-in only: reuse inherits the exact parent HOME/ZYLOS_DIR,
// PM2_HOME/TMPDIR/socket/DB boundary; invalid inheritance starts no resource.
test('child reuse validates the inherited root before allocating or starting resources', { skip: !enabled }, async t => {
  const sandbox = createChatSandbox(t);
  const before = chatResourceCounts();
  for (const [key, value] of [['HOME', process.env.HOME], ['ZYLOS_DIR', process.env.ZYLOS_DIR],
    ['PM2_HOME', process.env.PM2_HOME], ['TMPDIR', process.env.TMPDIR],
    ['CODEX_HOME', path.join(process.env.HOME, '.codex')],
    ['ZYLOS_CHAT_SANDBOX_PARENT', process.env.TMPDIR + '/another-parent']]) {
    assert.throws(() => createChatSandbox(null, { existingRoot: sandbox.root,
      gateEnv: { ...sandbox.env, [key]: value } }), { code: 'ERR_ASSERTION' });
  }
  assert.throws(() => createChatSandbox(null, { existingRoot: process.env.HOME, gateEnv: sandbox.env }), { code: 'ERR_ASSERTION' });
  for (const [kind, count] of Object.entries(chatResourceCounts())) assert.equal(count, before[kind]);
  const reused = createChatSandbox(null, { existingRoot: sandbox.root, gateEnv: sandbox.env });
  assert.equal(reused.root, sandbox.root);
  assert.equal(reused.paths.parentTmp, sandbox.paths.parentTmp);
  await reused.close();
  assert.equal(fs.existsSync(sandbox.root), true, 'Only the owning parent removes a reused root');
});

// Integration opt-in only: inspect a private fixture env, with no child/network;
// HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB paths still use the shared proof.
test('sandbox preserves explicit network proxies without inheriting account configuration', { skip: !enabled }, t => {
  const values = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].map(key => [key, key.toLowerCase() + '-fixture']));
  const sandbox = createChatSandbox(t, { gateEnv: { ...process.env, ...values, UNRELATED_ACCOUNT_SECRET: 'must-not-cross' } });
  for (const [key, value] of Object.entries(values)) assert.equal(sandbox.env[key], value);
  assert.equal(sandbox.env.UNRELATED_ACCOUNT_SECRET, undefined);
  assert.equal(sandbox.env.CLAUDE_CONFIG_DIR, undefined);
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

// Integration opt-in only: private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB
// proof precedes the real child+HTTP producer; the timeout must reclaim them.
test('case timeout reaps real child work and its private HTTP resources', { skip: !enabled, timeout: 5000 }, t => lifecycle(t, false));
// Same private path proof and opt-in; first failure must stop real recurring
// work, close HTTP and remove the owned case root, without touching live state.
test('first counterexample stops recurring work and recovers private resources', { skip: !enabled, timeout: 5000 }, t => lifecycle(t, true));

// Integration opt-in only: use private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB
// proof, a real private SQLite DB and synthetic auth file; all must be removed.
test('a failing cleanup still closes SQLite and removes copied authentication files', { skip: !enabled }, async () => {
  const sandbox = createChatSandbox(null);
  const { default: Database } = await import('../../comm-bridge/scripts/sqlite-driver.js');
  const database = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  const credential = path.join(sandbox.paths.home, '.claude/.credentials.json');
  fs.writeFileSync(credential, '{"fixture":true}');
  const calls = [], first = Error('first cleanup failed');
  sandbox.addCleanup(() => { calls.push('earlier'); throw Error('later cleanup failed'); });
  sandbox.addCleanup(() => { calls.push('last'); throw first; });
  await assert.rejects(sandbox.close(), error => error === first);
  assert.equal(calls.join(','), 'last,earlier');
  assert.equal(database.open, false);
  assert.equal(fs.existsSync(credential), false);
  assert.equal(fs.existsSync(sandbox.root), false);
});

// Integration opt-in only: a real child has exited but its completion receipt
// never settles. The private DB/root must still be cleaned after a bounded wait.
test('stalled child completion cannot prevent later cleanup or private root removal', { skip: !enabled, timeout: 15_000 }, async () => {
  const sandbox = createChatSandbox(null);
  const { default: Database } = await import('../../comm-bridge/scripts/sqlite-driver.js');
  const database = sandbox.openDatabase(sandbox.paths.c4Db, filename => new Database(filename));
  const child = sandbox.startChild(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal((await child.completion).code, 0);
  child.completion = new Promise(() => {});
  let laterCleanup = false;
  sandbox.addCleanup(() => { laterCleanup = true; });
  await assert.rejects(sandbox.close(), /Chat child cleanup timed out/);
  assert.equal(laterCleanup, true);
  assert.equal(database.open, false);
  assert.equal(fs.existsSync(sandbox.root), false);
});

// Integration opt-in only: private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB proof
// precedes the output producer; no model/network/PM2 or default socket is used.
test('output overflow terminates a real producer and recovers its child and private root', { skip: !enabled, timeout: 5000 }, async t => {
  const sandbox = createChatSandbox(t);
  let child;
  const limit = 2048;
  await sandbox.runCase(async () => {
    child = sandbox.startChild(process.execPath, [fileURLToPath(new URL('./helpers/chat-output-loop.js', import.meta.url))],
      { maxOutputBytes: limit, timeoutMs: 10_000 });
    const result = await child.completion;
    assert.equal(result.outputExceeded, true);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= limit);
    assert.ok(result.signal || result.code !== 0, 'The producer was terminated before its recurring work finished');
    const descendant = JSON.parse(result.stdout.split('\n')[0]).child;
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) {
      if (error.code === 'ESRCH') return false; throw error;
    } };
    for (let n = 0; n < 50 && alive(descendant); n++) await delay(10);
    assert.equal(alive(descendant), false, 'Overflow also reaps the real descendant');
  }, { timeoutMs: 2000 });
  assert.equal(sandbox.children.size, 0);
  assert.equal(fs.existsSync(sandbox.root), false);
});

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
