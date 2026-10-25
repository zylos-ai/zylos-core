import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const scripts = path.resolve(import.meta.dirname, '..');
const packageRoot = path.resolve(scripts, '../../..');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-config-boundary-'));
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  const file = path.join(root, '.zylos/config.json');
  const run = (script, args = [], options = {}) => spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    env: { ...process.env, HOME: root, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: packageRoot, C4_DISPATCHER_DISABLE_MAIN: '1', ...options.env },
    encoding: 'utf8', timeout: 10000, input: options.input,
  });
  const evaluate = (source, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, HOME: root, ZYLOS_DIR: root, ZYLOS_PACKAGE_ROOT: packageRoot, C4_DISPATCHER_DISABLE_MAIN: '1', ...env },
    encoding: 'utf8', timeout: 10000,
  });
  try { fn({ root, file, run, evaluate }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('malformed F1 leaves receive/send/checkpoint/fetch usable and messages persisted', () => fixture(({ root, file, run }) => {
  fs.writeFileSync(file, '{ broken');
  const receive = run('c4-receive.js', ['--channel', 'void', '--endpoint', 'isolated', '--content', 'boundary-input', '--no-reply']);
  assert.equal(receive.status, 0, receive.stderr);
  const send = run('c4-send.js', ['void', 'isolated', '--stdin'], { input: 'boundary-output' });
  assert.equal(send.status, 0, send.stderr);
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  const rows = db.prepare('SELECT id, content FROM conversations ORDER BY id').all();
  db.close();
  assert.deepEqual(rows.map(row => row.content), ['boundary-input', 'boundary-output']);
  const checkpoint = run('c4-checkpoint.js', ['create', String(rows.at(-1).id), '--summary', 'isolated-checkpoint']);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const fetch = run('c4-fetch.js', ['--begin', String(rows[0].id), '--end', String(rows.at(-1).id)]);
  assert.equal(fetch.status, 0, fetch.stderr);
  assert.match(fetch.stdout, /boundary-input/);
}));

test('c4-config constants import without loading Core or reading F1', () => fixture(({ root, file, evaluate }) => {
  fs.writeFileSync(file, '{ broken');
  const fake = path.join(root, 'bad-core/cli/lib');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(root, 'bad-core/package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(fake, 'config.js'), 'throw new Error("Core must not load for constants");');
  const result = evaluate(`process.env.ZYLOS_PACKAGE_ROOT=${JSON.stringify(path.join(root, 'bad-core'))}; await import(${JSON.stringify(new URL('../c4-config.js', import.meta.url).href)});`);
  assert.equal(result.status, 0, result.stderr);
}));

test('dispatcher initialization rejects malformed F1 before delivery and permits missing keys', () => fixture(({ root, file, run }) => {
  fs.writeFileSync(file, '{ broken');
  const rejected = run('c4-dispatcher.js');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /CONFIG_UNREADABLE/);
  fs.writeFileSync(file, '{}');
  const valid = run('c4-dispatcher.js');
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(fs.existsSync(path.join(root, 'comm-bridge/c4.db')), false);
}));

test('dispatcher refuses queued delivery if F1 becomes malformed after initialization', () => fixture(({ root, file, run, evaluate }) => {
  fs.writeFileSync(file, '{}');
  assert.equal(run('c4-receive.js', ['--channel', 'void', '--endpoint', 'isolated', '--content', 'pending', '--no-reply']).status, 0);
  const dispatcher = new URL('../c4-dispatcher.js', import.meta.url).href;
  const result = evaluate(`import fs from 'node:fs'; const m=await import(${JSON.stringify(dispatcher)}); fs.writeFileSync(${JSON.stringify(file)}, '{ broken'); await m.processNextMessage();`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CONFIG_UNREADABLE/);
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  assert.equal(db.prepare('SELECT status FROM conversations WHERE content = ?').get('pending').status, 'pending');
  db.close();
}));

test('dispatcher never resolves Core without ZYLOS_PACKAGE_ROOT and keeps F1 reads fresh', () => fixture(({ root, file, evaluate }) => {
  fs.writeFileSync(file, '{}');
  const bin = path.join(root, 'bin');
  const count = path.join(root, 'npm-calls');
  fs.writeFileSync(count, '');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "call\\n" >> "$NPM_COUNT_FILE"\nprintf "%s\\n" "$NPM_TEST_ROOT"\n', { mode: 0o755 });
  const dispatcher = new URL('../c4-dispatcher.js', import.meta.url).href;
  const result = evaluate(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    delete process.env.ZYLOS_PACKAGE_ROOT;
    const m = await import(${JSON.stringify(dispatcher)});
    for (let i = 0; i < 5; i++) await m.processNextMessage();
    assert.equal(fs.readFileSync(${JSON.stringify(count)}, 'utf8'), '');
    fs.writeFileSync(${JSON.stringify(file)}, '{ broken');
    await assert.rejects(m.processNextMessage(), { code: 'CONFIG_UNREADABLE' });
  `, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, NPM_COUNT_FILE: count, NPM_TEST_ROOT: root });
  assert.equal(result.status, 0, result.stderr);
}));
