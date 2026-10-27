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

test('malformed F1 leaves receive/send/checkpoint/fetch usable and messages persisted', () => fixture(({ root, file, run, evaluate }) => {
  fs.writeFileSync(file, '{ broken');
  fs.mkdirSync(path.join(root, '.claude/skills/void'), { recursive: true });
  const receive = run('c4-receive.js', ['--channel', 'void', '--endpoint', 'isolated', '--content', 'boundary-input', '--no-reply']);
  assert.equal(receive.status, 0, receive.stderr);
  const send = run('c4-send.js', ['void', 'isolated', '--stdin'], {
    input: 'boundary-output', env: { ZYLOS_RUN_ID: 'boundary-run', ZYLOS_SESSION_GROUP: undefined },
  });
  assert.equal(send.status, 0, send.stderr);
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  const rows = db.prepare('SELECT id, content FROM conversations ORDER BY id').all();
  db.close();
  assert.deepEqual(rows.map(row => row.content), ['boundary-input', 'boundary-output']);
  const pending = run('c4-checkpoint.js', ['create', String(rows.at(-1).id), '--summary', 'isolated-checkpoint']);
  assert.equal(pending.status, 1, pending.stderr);
  assert.match(pending.stderr, /CHECKPOINT_GAP/);
  // Checkpoints require settled input; model the isolated dispatcher's completion.
  const delivered = evaluate(`
    import assert from 'node:assert/strict';
    import * as db from ${JSON.stringify(new URL('../c4-db.js', import.meta.url).href)};
    assert.equal(db.claimConversation(${rows[0].id}), true);
    assert.equal(db.markDelivered(${rows[0].id}, { sessionId: 'boundary-session' }), true);
    db.close();
  `);
  assert.equal(delivered.status, 0, delivered.stderr);
  const checkpoint = run('c4-checkpoint.js', ['create', String(rows.at(-1).id), '--summary', 'isolated-checkpoint']);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const fetch = run('c4-fetch.js', ['--begin', String(rows[0].id), '--end', String(rows.at(-1).id)]);
  assert.equal(fetch.status, 0, fetch.stderr);
  assert.match(fetch.stdout, /boundary-input/);
  assert.match(fetch.stdout, /boundary-output/);
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

// Dispatcher mode/startup boundaries now exercise the production router entry in
// session-delivery.test.js and router-factory.integration.test.js. Unlike the
// retired loop, M1 reads mode once and remains inert on malformed startup F1.
