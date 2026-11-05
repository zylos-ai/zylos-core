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
    const result = run(args[0] === 'overrides' ? [args[0], '--json', ...args.slice(1)] : [...args, '--json'], extraEnv);
    assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
    return { ...result, value: JSON.parse(result.stdout) };
  };
  return { root, config, database, store, db, run, json };
}

test('real group overrides CLI selects stored pairs, agrees with get and reads without writes', t => {
  const f = overridesFixture(t);
  for (const groupName of ['a', 'B', 'empty', 'other']) f.store.insertConversation('in', 'chat', 'e', 'hello', { groupName });
  for (const [sessionGroup, runtime] of [['chat:a', 'claude'], ['chat:B', 'codex']]) f.store.setSessionRuntimeConfig({ sessionGroup, runtime });
  for (const [sessionGroup, runtime, model, effort] of [
    ['chat:a', 'codex', 'codex-a', 'high'], ['chat:a', 'claude', 'claude-a', 'low'], ['chat:B', 'codex', 'codex-B', 'medium'],
  ]) f.store.setSessionModelConfig({ sessionGroup, runtime, model, effort });
  f.store.setSessionRuntimeConfig({ sessionGroup: 'chat:other', runtime: 'claude' });
  f.store.setSessionModelConfig({ sessionGroup: 'chat:other', runtime: 'codex', model: 'excluded', effort: 'high' });
  f.db.pragma('wal_checkpoint(TRUNCATE)');
  const dbBytes = () => Buffer.concat([fs.readFileSync(f.database), fs.readFileSync(`${f.database}-wal`)]);
  const before = dbBytes();
  const observer = new f.db.constructor(f.database);
  t.after(() => observer.close());
  const version = observer.pragma('data_version', { simple: true });
  const selection = ['overrides', '--group', 'chat:a', '--group', 'chat:empty', '--group', 'chat:B'];
  const result = f.json(selection);
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
  const text = f.run(selection);
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
  const page = f.json(['overrides']);
  assert.equal(page.status, 0, page.stderr); assert.equal(page.value.data.runtimeTotal, 3);
  assert.equal(page.value.data.runtime.length, 3); assert.equal(page.value.data.nextAfter, null);
  assert.equal('model' in page.value.data, false);
  assert.equal(observer.pragma('data_version', { simple: true }), version);
  assert.ok(dbBytes().equals(before), 'database or WAL bytes changed');
});

test('real override CLI handles empty stores, invalid arguments and unreadable config/database', t => {
  const f = overridesFixture(t);
  const empty = f.json(['overrides']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(empty.value, { ok: true, data: { runtimeTotal: 0, runtime: [], nextAfter: null } });
  const selectedEmpty = f.json(['overrides', '--group', 'chat:missing']);
  assert.equal(selectedEmpty.status, 0, selectedEmpty.stderr);
  assert.deepEqual(selectedEmpty.value.data, { baseline: { runtime: 'codex', sessionMode: 'single' }, runtime: [], model: [] });
  for (const flags of [
    ['--group', 'bad key'], ['extra'], ['--bogus'], ['--json', '--json'],
    ['--group'], ['--match'], ['--after'], ['--limit', '5'],
    ['--group', 'chat:a', '--match', 'a'], ['--group', 'chat:a', '--after', 'a'],
    ['--match', '  '], ['--match', 'x'.repeat(65)], ['--after', ''], ['--after', '  '],
    ['--match', 'a', '--match', 'b'], ['--after', 'a', '--after', 'b'],
    Array.from({ length: 501 }, (_, i) => ['--group', `chat:g${i}`]).flat(),
  ]) {
    const result = f.json(['overrides', ...flags]);
    assert.equal(result.status, 1); assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, 'INVALID_ARGUMENT'); assert.equal('data' in result.value, false);
    assert.deepEqual(result.value.error.persisted, []);
  }
  for (const flags of [['--bogus'], ['extra'], ['--group', 'bad key'], ['--limit', '5']]) {
    const result = f.run(['overrides', ...flags]);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error \[INVALID_ARGUMENT\]:/);
  }
  const old = f.json(['foo']);
  assert.equal(old.status, 1);
  assert.equal(old.value.ok, false); assert.equal(old.value.error.code, 'INVALID_ARGUMENT');
  assert.deepEqual(old.value.error.persisted, []);
  assert.equal(old.value.error.message, 'Usage: zylos group <runtime|model> <get|set|reset> [options] | zylos group overrides [--group <group>]... | zylos group overrides [--match <text>] [--after <group>]');
  const maxGroups = f.json(['overrides', ...Array.from({ length: 500 }, (_, i) => ['--group', `chat:g${i}`]).flat()]);
  assert.equal(maxGroups.status, 0, maxGroups.stderr);
  assert.deepEqual(maxGroups.value.data.runtime, []); assert.deepEqual(maxGroups.value.data.model, []);
  const origin = f.json(['overrides', '--group', 'origin']);
  assert.equal(origin.status, 0, origin.stderr);
  assert.deepEqual(origin.value.data.runtime, []); assert.deepEqual(origin.value.data.model, []);
  const internal = f.json(['overrides'], { ZYLOS_PACKAGE_ROOT: path.join(f.root, 'missing-package') });
  assert.equal(internal.status, 1); assert.equal(internal.value.ok, false);
  assert.equal(internal.value.error.code, 'INTERNAL_ERROR');
  assert.deepEqual(Object.keys(internal.value.error).sort(), ['code', 'message']);
  fs.writeFileSync(f.config, '{bad JSON');
  f.db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)').run('chat:kept', 'codex');
  const withoutBaseline = f.json(['overrides']);
  assert.equal(withoutBaseline.status, 0, withoutBaseline.stderr);
  assert.deepEqual(withoutBaseline.value, { ok: true, data: {
    runtimeTotal: 1, runtime: [{ sessionGroup: 'chat:kept', runtime: 'codex' }], nextAfter: null,
  } });
  assert.equal('baseline' in withoutBaseline.value.data, false);
  const badConfig = f.json(['overrides', '--group', 'chat:kept']);
  assert.equal(badConfig.status, 1); assert.equal(badConfig.value.ok, false);
  assert.equal(badConfig.value.error.code, 'CONFIG_UNREADABLE'); assert.equal('data' in badConfig.value, false);
  assert.deepEqual(Object.keys(badConfig.value.error).sort(), ['code', 'message']);
  const text = f.run(['overrides', '--group', 'chat:kept']);
  assert.equal(text.status, 1); assert.equal(text.stdout, ''); assert.match(text.stderr, /^Error \[CONFIG_UNREADABLE\]:/);
  fs.writeFileSync(f.config, JSON.stringify({ runtime: 'codex', session_mode: 'single' }));
  f.db.close();
  fs.writeFileSync(f.database, 'not a SQLite database');
  const badDb = f.json(['overrides']);
  assert.equal(badDb.status, 1); assert.equal(badDb.value.ok, false);
  assert.equal(typeof badDb.value.error.code, 'string'); assert.equal('data' in badDb.value, false);
  assert.deepEqual(Object.keys(badDb.value.error).sort(), ['code', 'message']);
  const badDbText = f.run(['overrides']);
  assert.equal(badDbText.status, 1); assert.equal(badDbText.stdout, ''); assert.match(badDbText.stderr, /^Error \[/);
});

test('real override CLI paginates runtime rows and searches without changing the total', t => {
  const f = overridesFixture(t);
  const insert = f.db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)');
  f.db.transaction(() => {
    for (let i = 0; i < 250; i++) insert.run(`chat:${i % 2 ? 'oc_' : 'other_'}${String(i).padStart(3, '0')}`, 'codex');
  })();
  f.db.prepare('INSERT INTO group_model_overrides(session_group,runtime,model,effort) VALUES (?,?,?,?)').run('chat:model-only', 'codex', 'm', 'high');
  const expected = f.db.prepare('SELECT session_group FROM group_runtime_overrides ORDER BY session_group COLLATE BINARY').all();
  const keys = [];
  let after;
  for (const size of [100, 100, 50]) {
    const page = f.json(['overrides', ...(after ? ['--after', after] : [])]);
    assert.equal(page.status, 0, page.stderr); assert.equal(page.value.data.runtimeTotal, 250);
    assert.equal(page.value.data.runtime.length, size); assert.equal('model' in page.value.data, false);
    for (const row of page.value.data.runtime) keys.push(row.sessionGroup);
    after = page.value.data.nextAfter;
    assert.equal(after, size === 50 ? null : page.value.data.runtime.at(-1).sessionGroup);
  }
  assert.equal(keys.length, 250); assert.equal(new Set(keys).size, 250);
  for (let i = 0; i < keys.length; i++) assert.equal(keys[i], expected[i].session_group);
  const first = f.json(['overrides', '--match', '  OC_  ']);
  const second = f.json(['overrides', '--match', 'OC_', '--after', first.value.data.nextAfter]);
  for (const page of [first, second]) {
    assert.equal(page.status, 0, page.stderr); assert.equal(page.value.data.runtimeTotal, 250);
    for (const row of page.value.data.runtime) assert.ok(row.sessionGroup.toLowerCase().includes('oc_'));
  }
  assert.equal(first.value.data.runtime.length, 100); assert.equal(second.value.data.runtime.length, 25);
  assert.equal(second.value.data.nextAfter, null);
  assert.equal(new Set([...first.value.data.runtime, ...second.value.data.runtime].map(row => row.sessionGroup)).size, 125);
  f.db.prepare('DELETE FROM group_runtime_overrides WHERE session_group>=?').run(expected[100].session_group);
  const exact = f.json(['overrides']);
  assert.equal(exact.status, 0, exact.stderr); assert.equal(exact.value.data.runtime.length, 100);
  assert.equal(exact.value.data.nextAfter, null);
});

test('real override CLI output stays bounded when runtime override history grows', t => {
  const f = overridesFixture(t);
  const insert = f.db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)');
  const seed = (start, end) => f.db.transaction(() => {
    for (let i = start; i < end; i++) insert.run(`chat:g${String(i).padStart(6, '0')}`, 'codex');
  })();
  seed(0, 100);
  const small = f.json(['overrides']);
  assert.equal(small.status, 0, small.stderr); assert.equal(small.value.data.runtime.length, 100);
  assert.equal(small.value.data.nextAfter, null);
  seed(100, 100000);
  const large = f.json(['overrides']);
  assert.equal(large.status, 0, large.stderr); assert.equal(large.value.data.runtimeTotal, 100000);
  assert.equal(large.value.data.runtime.length, 100); assert.equal(large.value.data.nextAfter, 'chat:g000099');
  assert.ok(Buffer.byteLength(large.stdout) < Buffer.byteLength(small.stdout) * 2);
  for (let i = 0; i < 100; i++) assert.equal(large.value.data.runtime[i].sessionGroup, small.value.data.runtime[i].sessionGroup);
});

test('real override CLI accepts trailing JSON flags and valid search and cursor boundaries', t => {
  const f = overridesFixture(t);
  const insert = f.db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)');
  for (const group of ['chat:other', 'chat:--json', `chat:${'x'.repeat(64)}`]) insert.run(group, 'codex');
  for (const [args, expected] of [
    [['overrides', '--match', 'other', '--json'], 'chat:other'],
    [['overrides', '--group', 'chat:other', '--json'], 'chat:other'],
    [['overrides', '--match', '--json', '--json'], 'chat:--json'],
    [['overrides', '--match', 'x'.repeat(64), '--json'], `chat:${'x'.repeat(64)}`],
    [['overrides', '--after', 'chat:other', '--json'], `chat:${'x'.repeat(64)}`],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const value = JSON.parse(result.stdout);
    assert.equal(value.ok, true);
    assert.deepEqual(value.data.runtime, [{ sessionGroup: expected, runtime: 'codex' }]);
  }
});

test('real override CLI searches literal underscores and pages case-sensitive group keys', t => {
  const f = overridesFixture(t);
  const insert = f.db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)');
  f.db.transaction(() => {
    for (let i = 0; i < 101; i++) insert.run(`lark:${i % 2 ? 'OC_' : 'oc_'}${String(i).padStart(3, '0')}`, 'codex');
    for (const group of ['lark:ocX1', 'chat:other', 'chat:--b']) insert.run(group, 'claude');
  })();
  const first = f.json(['overrides', '--match', ' OC_ ']);
  assert.equal(first.status, 0, first.stderr);
  const second = f.json(['overrides', '--match', 'OC_', '--after', first.value.data.nextAfter]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.value.data.runtime.length, 100); assert.equal(second.value.data.runtime.length, 1);
  assert.equal(second.value.data.nextAfter, null);
  const keys = [...first.value.data.runtime, ...second.value.data.runtime].map(row => row.sessionGroup);
  assert.equal(new Set(keys).size, 101);
  for (const row of [first, second]) {
    assert.equal(row.value.data.runtimeTotal, 104);
    for (const item of row.value.data.runtime) assert.ok(item.sessionGroup.toLowerCase().includes('oc_'));
  }
  assert.equal(keys.includes('lark:ocX1'), false);
  f.db.prepare('DELETE FROM group_runtime_overrides WHERE session_group=?').run(second.value.data.runtime[0].sessionGroup);
  const exact = f.json(['overrides', '--match', 'OC_']);
  assert.equal(exact.status, 0, exact.stderr); assert.equal(exact.value.data.runtime.length, 100);
  assert.equal(exact.value.data.nextAfter, null);
  const dashed = f.json(['overrides', '--match', '--b']);
  assert.equal(dashed.status, 0, dashed.stderr);
  assert.deepEqual(dashed.value.data.runtime, [{ sessionGroup: 'chat:--b', runtime: 'claude' }]);
  const jsonText = f.run(['overrides', '--match', '--json']);
  assert.equal(jsonText.status, 0, jsonText.stderr); assert.match(jsonText.stdout, /^OK: /);
  const dashedCursor = f.json(['overrides', '--after', '--b']);
  assert.equal(dashedCursor.status, 0, dashedCursor.stderr);
  f.db.prepare('DELETE FROM group_runtime_overrides').run();
  for (let i = 0; i < 99; i++) insert.run(`chat:A${String(i).padStart(2, '0')}`, 'codex');
  for (const group of ['chat:B', 'chat:a']) insert.run(group, 'codex');
  const sorted = f.json(['overrides']);
  assert.equal(sorted.status, 0, sorted.stderr);
  assert.equal(sorted.value.data.runtime.length, 100);
  for (let i = 0; i < 99; i++) assert.equal(sorted.value.data.runtime[i].sessionGroup, `chat:A${String(i).padStart(2, '0')}`);
  assert.equal(sorted.value.data.runtime[99].sessionGroup, 'chat:B');
  assert.equal(sorted.value.data.nextAfter, 'chat:B');
  const last = f.json(['overrides', '--after', sorted.value.data.nextAfter]);
  assert.equal(last.status, 0, last.stderr);
  assert.deepEqual(last.value.data.runtime, [{ sessionGroup: 'chat:a', runtime: 'codex' }]);
  assert.equal(last.value.data.nextAfter, null);
});
