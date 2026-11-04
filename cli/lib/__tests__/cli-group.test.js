import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { groupCommand } from '../../commands/group.js';
import { resolveCliSession } from '../cli-session.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../../../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';

test('group delegates selector/actions verbatim to the formal wrapper', async () => {
  const previous = process.exitCode;
  try {
    for (const kind of ['runtime', 'model']) {
      const flags = ['get', '--group', 'telegram:example', '--runtime', 'codex', '--json'];
      const io = { stdout: {}, stderr: {} }; const calls = [];
      const result = await groupCommand([kind, ...flags], { io, run: async (...args) => { calls.push(args); return 1; } });
      assert.deepEqual(calls, [[kind, flags, io]]); assert.equal(result, 1); assert.equal(process.exitCode, 1);
    }
  } finally { process.exitCode = previous; }
});

test('CLI entry loads and invalid status arguments produce one structured result', () => {
  const cli = new URL('../../zylos.js', import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname, 'status', '--json', '--unknown'], { encoding: 'utf8', env: process.env });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]); assert.equal(parsed.error.code, 'INVALID_ARGUMENT'); assert.deepEqual(parsed.error.persisted, []);
});

test('group text explains null running using mode before runtime comparison', async () => {
  const previous = process.exitCode;
  try {
    for (const [sessionMode, expected] of [['single', /only in multi/], ['multi', /current group runtime is claude/]]) {
      let text = '';
      await groupCommand(['model', 'get'], { io: { stdout: { write: value => { text += value; } }, stderr: {} },
        run: async (_kind, args, io) => { assert.equal(args.at(-1), '--json'); io.stdout.write(`${JSON.stringify({ ok: true, data: { running: null, sessionMode, runtime: 'codex', resolved: { runtime: 'claude' } } })}\n`); return 0; } });
      assert.match(text, expected);
    }
    let stdout = '', stderr = '';
    const code = await groupCommand(['runtime', 'get'], { io: { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } },
      run: async (_kind, _args, io) => { io.stdout.write(JSON.stringify({ ok: false, error: { code: 'DB_BUSY', message: 'busy', persisted: [] } })); return 1; } });
    assert.equal(code, 1); assert.equal(stdout, ''); assert.match(stderr, /^Error \[DB_BUSY\]: busy\n$/);
  } finally { process.exitCode = previous; }
});

test('CLI session targets actual runtime and rejects unreadable mode without default fallback', async () => {
  for (const [mode, expected] of [['multi', 'telegram:example'], ['single', null], [null, null]]) {
    const seen = [];
    const result = await resolveCliSession({ env: { ZYLOS_SESSION_GROUP: 'telegram:example' }, mode: () => ({ mode }),
      identity: async group => { seen.push(group); return { present: true, runtime: 'codex' }; },
      resolveRuntime: () => assert.fail('present runtime must win'), adapter: runtime => runtime });
    assert.deepEqual(seen, [expected]); assert.equal(result.runtime, 'codex'); assert.equal(result.adapter, 'codex');
  }
  await assert.rejects(() => resolveCliSession({ mode: () => { throw new Error('bad config'); },
    identity: () => assert.fail('bad mode must stop target selection') }), /bad config/);
});

function overridesFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-overrides-'));
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const pm2 = path.join(home, '.pm2'), tmp = path.join(root, 'tmp');
  for (const dir of [path.join(zylos, '.zylos'), path.join(zylos, 'comm-bridge'), tmp]) fs.mkdirSync(dir, { recursive: true });
  const config = path.join(zylos, '.zylos/config.json');
  fs.writeFileSync(config, JSON.stringify({ runtime: 'codex', session_mode: 'single' }));
  const database = path.join(zylos, 'comm-bridge/c4.db');
  const bin = path.join(root, 'bin'), calls = path.join(root, 'runtime-calls');
  fs.mkdirSync(bin);
  for (const command of ['tmux', 'pm2']) fs.writeFileSync(path.join(bin, command),
    '#!/bin/sh\nprintf "%s\\n" "$0" >> "$OVERRIDES_RUNTIME_CALLS"\nexit 1\n', { mode: 0o755 });
  t.after(() => {
    try { assert.equal(fs.existsSync(calls), false, 'must not invoke tmux or PM2'); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const { store, db } = storeFixture(t, {}, database);
  db.pragma('journal_mode=WAL');
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: pm2, TMPDIR: tmp, TMUX_TMPDIR: tmp,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, OVERRIDES_RUNTIME_CALLS: calls };
  for (const name of ['TMUX', 'ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[name];
  // Covers real CLI/import/DB output; run for override/store/CLI changes, skip for unrelated UI changes.
  // Isolated environments only; never touch live resources: private HOME/ZYLOS_DIR/PM2_HOME,
  // short TMPDIR/TMUX_TMPDIR and database; recording tmux/PM2 stubs reject runtime calls.
  for (const target of [env.HOME, env.ZYLOS_DIR, env.PM2_HOME, env.TMPDIR, database]) assert.ok(target.startsWith(root + path.sep));
  console.log(JSON.stringify({ overridesFixture: root, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: pm2, TMPDIR: tmp, database }));
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [new URL('../../zylos.js', import.meta.url).pathname, 'group', ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
  const json = (args, extraEnv) => {
    const result = run([...args, '--json'], extraEnv);
    assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
    return { ...result, value: JSON.parse(result.stdout) };
  };
  return { root, config, database, store, db, run, json };
}

test('real group overrides CLI lists stored pairs, agrees with get and reads without writes', t => {
  const f = overridesFixture(t);
  for (const groupName of ['a', 'B', 'empty']) f.store.insertConversation('in', 'chat', 'e', 'hello', { groupName });
  for (const [sessionGroup, runtime] of [['chat:a', 'claude'], ['chat:B', 'codex']]) f.store.setSessionRuntimeConfig({ sessionGroup, runtime });
  for (const [sessionGroup, runtime, model, effort] of [
    ['chat:a', 'codex', 'codex-a', 'high'], ['chat:a', 'claude', 'claude-a', 'low'], ['chat:B', 'codex', 'codex-B', 'medium'],
  ]) f.store.setSessionModelConfig({ sessionGroup, runtime, model, effort });
  f.db.pragma('wal_checkpoint(TRUNCATE)');
  const dbBytes = () => Buffer.concat([fs.readFileSync(f.database), fs.readFileSync(`${f.database}-wal`)]);
  const before = dbBytes();
  const observer = new f.db.constructor(f.database);
  t.after(() => observer.close());
  const version = observer.pragma('data_version', { simple: true });
  const result = f.json(['overrides']);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.deepEqual(result.value, { ok: true, data: {
    baseline: { runtime: 'codex', sessionMode: 'single' },
    runtime: [{ sessionGroup: 'chat:B', runtime: 'codex' }, { sessionGroup: 'chat:a', runtime: 'claude' }],
    model: [
      { sessionGroup: 'chat:B', runtime: 'codex', model: 'codex-B', effort: 'medium' },
      { sessionGroup: 'chat:a', runtime: 'claude', model: 'claude-a', effort: 'low' },
      { sessionGroup: 'chat:a', runtime: 'codex', model: 'codex-a', effort: 'high' },
    ],
  } });
  assert.equal('running' in result.value.data, false);
  const text = f.run(['overrides']);
  assert.equal(text.status, 0, text.stderr); assert.equal(text.stderr, '');
  assert.equal(text.stdout, `OK: ${JSON.stringify(result.value.data)}\n`);
  for (const sessionGroup of ['chat:B', 'chat:a', 'chat:empty']) {
    const runtime = f.json(['runtime', 'get', '--group', sessionGroup]);
    assert.equal(runtime.status, 0, runtime.stderr);
    const row = result.value.data.runtime.find(row => row.sessionGroup === sessionGroup);
    assert.deepEqual(runtime.value.data.desired, row ? { mode: 'override', runtime: row.runtime } : { mode: 'inherit' });
    for (const rt of ['claude', 'codex']) {
      const model = f.json(['model', 'get', '--group', sessionGroup, '--runtime', rt]);
      assert.equal(model.status, 0, model.stderr);
      const pair = result.value.data.model.find(row => row.sessionGroup === sessionGroup && row.runtime === rt);
      assert.deepEqual(model.value.data.desired, pair ? { runtime: rt, mode: 'override', model: pair.model, effort: pair.effort } : { runtime: rt, mode: 'default' });
      assert.equal(model.value.data.running, null);
    }
  }
  assert.equal(observer.pragma('data_version', { simple: true }), version);
  assert.ok(dbBytes().equals(before), 'database or WAL bytes changed');
});

test('real override CLI handles empty stores, invalid arguments and unreadable config/database', t => {
  const f = overridesFixture(t);
  const empty = f.json(['overrides']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(empty.value, { ok: true, data: { baseline: { runtime: 'codex', sessionMode: 'single' }, runtime: [], model: [] } });
  for (const flags of [['--group', 'x'], ['extra'], ['--bogus'], ['--json', '--json']]) {
    const result = f.json(['overrides', ...flags]);
    assert.equal(result.status, 1); assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, 'INVALID_ARGUMENT'); assert.equal('data' in result.value, false);
    assert.deepEqual(result.value.error.persisted, []);
  }
  for (const flags of [['--bogus'], ['extra'], ['--group', 'x']]) {
    const result = f.run(['overrides', ...flags]);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error \[INVALID_ARGUMENT\]:/);
  }
  const old = f.json(['foo']);
  assert.equal(old.status, 1);
  assert.deepEqual(old.value, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Usage: zylos group <runtime|model> <get|set|reset> [options] | zylos group overrides [--json]', persisted: [] } });
  const internal = f.json(['overrides'], { ZYLOS_PACKAGE_ROOT: path.join(f.root, 'missing-package') });
  assert.equal(internal.status, 1); assert.equal(internal.value.ok, false);
  assert.equal(internal.value.error.code, 'INTERNAL_ERROR');
  assert.deepEqual(Object.keys(internal.value.error).sort(), ['code', 'message']);
  fs.writeFileSync(f.config, '{bad JSON');
  const badConfig = f.json(['overrides']);
  assert.equal(badConfig.status, 1); assert.equal(badConfig.value.ok, false);
  assert.equal(badConfig.value.error.code, 'CONFIG_UNREADABLE'); assert.equal('data' in badConfig.value, false);
  assert.deepEqual(Object.keys(badConfig.value.error).sort(), ['code', 'message']);
  const text = f.run(['overrides']);
  assert.equal(text.status, 1); assert.equal(text.stdout, ''); assert.match(text.stderr, /^Error \[CONFIG_UNREADABLE\]:/);
  fs.writeFileSync(f.config, JSON.stringify({ runtime: 'codex', session_mode: 'single' }));
  f.db.close();
  fs.writeFileSync(f.database, 'not a SQLite database');
  const badDb = f.json(['overrides']);
  assert.equal(badDb.status, 1); assert.equal(badDb.value.ok, false);
  assert.equal(typeof badDb.value.error.code, 'string'); assert.equal('data' in badDb.value, false);
  const badDbText = f.run(['overrides']);
  assert.equal(badDbText.status, 1); assert.equal(badDbText.stdout, ''); assert.match(badDbText.stderr, /^Error \[/);
});
