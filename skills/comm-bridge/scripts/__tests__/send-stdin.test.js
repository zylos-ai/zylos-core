import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as schema from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { sendExternal } from '../c4-send-external.js';

const scripts = fileURLToPath(new URL('../', import.meta.url));
const spawnFault = new URL('./fixtures/send-spawn-fault.js', import.meta.url).href;
const packageRoot = path.resolve(scripts, '../../..');

// Real installed CLI + private SQLite + fixture-owned receiver. Required for
// external transport/declaration changes; unrelated receive/history/UI may skip.
// HOME, DB, PM2, TMPDIR and tmux socket directory are private. PATH exposes only
// Node, so no runtime, PM2 or tmux can start. Every CLI has a synchronous timeout;
// teardown closes SQLite and removes only this fixture's resources.
function setup(t, { stdin = true, source } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-stdin-'));
  let db;
  t.after(() => { db?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const skillsDir = path.join(zylos, '.claude', 'skills');
  const tmp = path.join(root, 'tmp'), bin = path.join(root, 'bin');
  for (const dir of [skillsDir, tmp, bin, path.join(zylos, '.zylos'), path.join(zylos, 'comm-bridge')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(zylos, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, PATH: bin, ZYLOS_PACKAGE_ROOT: packageRoot,
    SEND_TRANSPORT_SENTINEL: 'fixture-only' };
  for (const key of Object.keys(env)) {
    if (key === 'TMUX' || /(?:TOKEN|SECRET|PASSWORD|API_KEY)/.test(key) ||
        ['ZYLOS_RUN_ID', 'ZYLOS_SESSION_GROUP', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID'].includes(key)) delete env[key];
  }
  const filename = path.join(zylos, 'comm-bridge', 'c4.db');
  db = new Database(filename);
  guardDatabase(db, schema);
  const installed = path.join(skillsDir, 'comm-bridge');
  fs.mkdirSync(installed);
  fs.copyFileSync(path.join(scripts, '..', 'package.json'), path.join(installed, 'package.json'));
  fs.copyFileSync(path.join(scripts, '..', 'init-db.sql'), path.join(installed, 'init-db.sql'));
  fs.cpSync(scripts, path.join(installed, 'scripts'), { recursive: true,
    filter: file => !file.split(path.sep).includes('__tests__') });
  fs.symlinkSync(fs.realpathSync(path.join(scripts, '..', 'node_modules')), path.join(installed, 'node_modules'));
  const channel = path.join(skillsDir, 'example');
  fs.mkdirSync(path.join(channel, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(channel, 'package.json'), '{"type":"module"}');
  if (stdin) fs.writeFileSync(path.join(channel, 'SKILL.md'), '---\nname: example\nc4:\n  delivery: stdin\n---\n');
  const capture = path.join(root, 'received.json');
  fs.writeFileSync(path.join(channel, 'scripts', 'send.js'), source ?? `import fs from 'node:fs';
    ${stdin ? "let body=''; for await (const chunk of process.stdin) body+=chunk; const packet=JSON.parse(body);" : 'const packet=null;'}
    fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({packet,argv:process.argv.slice(2),sentinel:process.env.SEND_TRANSPORT_SENTINEL}));`);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) {
    assert.ok(env[key].startsWith(`${root}${path.sep}`), key);
  }
  assert.equal(path.dirname(filename), path.join(env.ZYLOS_DIR, 'comm-bridge'));
  assert.deepEqual(fs.readdirSync(bin), ['node']);
  console.log('Transport isolation:', JSON.stringify({ ...Object.fromEntries(
    ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'PATH'].map(key => [key, env[key]])), db: filename }));
  return { db, env, root, capture, bin, skillsDir, invoke: (content, endpoint = 'private-endpoint', { fault } = {}) => spawnSync(process.execPath,
    [...(fault ? ['--import', spawnFault] : []), path.join(installed, 'scripts', 'c4-send.js'), 'example', ...(endpoint === null ? [] : [endpoint]), '--stdin'],
    { cwd: root, env: { ...env, ...(fault ? { C4_TEST_SPAWN_TARGET: path.join(channel, 'scripts', 'send.js'),
      C4_TEST_SPAWN_FAULT: fault } : {}) }, input: content, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }) };
}

function retained(f, count = 1) {
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, count);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE status='delivered'").get().n, count);
}

test('stdin delivery preserves Unicode, quotes and a body too large for argv', { timeout: 10000 }, t => {
  const f = setup(t);
  const content = `中文 😀 'quotes' "double" $literal\n${'long '.repeat(40000)}end`;
  const result = f.invoke(content + '\n');
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const { packet, argv, sentinel } = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
  const row = f.db.prepare('SELECT * FROM conversations').get();
  assert.deepEqual(packet, { version: 1, c4_id: row.id, channel: row.channel,
    endpoint_id: row.endpoint_id, session_group: row.session_group, content });
  assert.deepEqual(argv, []); assert.equal(sentinel, 'fixture-only');
  assert.equal(row.content, content);
  retained(f);
});

for (const endpoint of ['private-endpoint', null]) {
  test(`undeclared delivery preserves argv ${endpoint === null ? 'without' : 'with'} an endpoint`, { timeout: 10000 }, t => {
    const f = setup(t, { stdin: false });
    const content = '旧 channel 😀 "quotes"\nnext';
    const result = f.invoke(content, endpoint);
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.capture, 'utf8')).argv, [...(endpoint === null ? [] : [endpoint]), content]);
    retained(f);
  });
}

test('stdin declaration with an argv-only receiver fails after retaining its audit', { timeout: 10000 }, t => {
  const f = setup(t, { source: 'if (process.argv.length !== 4) process.exit(9);' });
  const result = f.invoke('one-sided transport');
  assert.ifError(result.error); assert.equal(result.status, 9);
  assert.match(result.stderr, /SEND_FAILED.*delivery unconfirmed/);
  assert.doesNotMatch(result.stdout, /Message sent/);
  retained(f);
});

test('receiver failure after reading stdin remains an unconfirmed send', { timeout: 10000 }, t => {
  const f = setup(t, { source: 'for await (const chunk of process.stdin) {} process.exitCode=7;' });
  const result = f.invoke('body');
  assert.ifError(result.error); assert.equal(result.status, 7);
  assert.match(result.stderr, /SEND_FAILED.*delivery unconfirmed/);
  retained(f);
});

test('a receiver closing stdin cannot turn a broken pipe into success', { timeout: 10000 }, t => {
  const f = setup(t, { source: "import fs from 'node:fs'; fs.closeSync(0); setTimeout(()=>{},75);" });
  const result = f.invoke('x'.repeat(2 * 1024 * 1024));
  assert.ifError(result.error); assert.equal(result.status, 1);
  assert.match(result.stderr, /SEND_FAILED.*component stdin failed.*delivery unconfirmed/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error'/);
  assert.doesNotMatch(result.stdout, /Message sent/);
  retained(f);
});

// Real OS launch faults are selected only for the test-owned receiver. Run for
// send executable/transport changes; unrelated UI may skip. The preload keeps
// the real CLI, private DB and native spawn events, and every child has the
// fixture's timeout and isolated environment. No PATH-node assumption is used.
test('stdin receiver spawn failure keeps the stored row without claiming delivery', { timeout: 10000 }, t => {
  const f = setup(t);
  const faultBin = path.join(f.env.ZYLOS_DIR, 'bin');
  fs.mkdirSync(faultBin);
  fs.writeFileSync(path.join(faultBin, 'not-executable'), '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  for (const [index, fault] of ['ENOENT', 'EACCES'].entries()) {
    const result = f.invoke('body', 'private-endpoint', { fault });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert.match(result.stderr, /COMPONENT_SPAWN_FAILED/);
    assert.ok(result.stderr.includes(fault));
    assert.doesNotMatch(result.stderr, /private-endpoint/);
    assert.match(result.stderr, /audit retained; not sent/);
    assert.doesNotMatch(result.stdout, /Message sent/);
    assert.equal(fs.existsSync(f.capture), false, 'receiver body must not execute');
    retained(f, index + 1);
  }
});

test('identical sends deliver their own committed C4 identities', { timeout: 10000 }, t => {
  const f = setup(t), ids = [];
  for (let i = 0; i < 2; i++) {
    const result = f.invoke('same endpoint and body');
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const { packet } = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
    ids.push(packet.c4_id);
    const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(packet.c4_id);
    assert.equal(row.content, packet.content); assert.equal(row.endpoint_id, packet.endpoint_id);
    assert.equal(row.session_group, packet.session_group);
  }
  assert.notEqual(ids[0], ids[1]); retained(f, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM group_heads').get().n, 1);
});

// Direct API boundary retains all original whitespace; CLI separately retains its
// existing trimEnd contract. Run on packet construction changes; UI-only may skip.
test('stdin packet preserves leading and trailing whitespace exactly as stored', { timeout: 10000 }, async t => {
  const f = setup(t);
  const api = createStore(f.db, { validateComponent: () => true,
    readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const content = ' \t\n  Unicode 中 😀 \"quoted\"\n trailing \t\n ';
  const row = await sendExternal({ channel: 'example', endpoint: 'private-endpoint' }, content,
    { api, skillsDir: f.skillsDir, env: f.env, appendFallback: null });
  const { packet, argv } = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
  const stored = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id);
  assert.equal(packet.content, content);
  assert.equal(packet.content, stored.content);
  assert.equal(packet.c4_id, stored.id);
  assert.deepEqual(argv, []);
  const result = f.invoke(content);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const cliPacket = JSON.parse(fs.readFileSync(f.capture, 'utf8')).packet;
  assert.equal(cliPacket.content, content.trimEnd());
  assert.equal(f.db.prepare('SELECT content FROM conversations WHERE id=?').get(cliPacket.c4_id).content, cliPacket.content);
});

// Legacy argv signal exit must retain the existing diagnostic value (null).
// Run on component exit handling changes; UI-only may skip.
test('argv receiver signal exit retains the legacy null exit diagnostic', { timeout: 10000 }, t => {
  const f = setup(t, { stdin: false, source: "process.kill(process.pid, 'SIGTERM');" });
  const result = f.invoke('body');
  assert.ifError(result.error); assert.equal(result.status, 1);
  assert.match(result.stdout, /exit code: null/);
  assert.match(result.stderr, /component exit SIGTERM/);
  retained(f);
});
