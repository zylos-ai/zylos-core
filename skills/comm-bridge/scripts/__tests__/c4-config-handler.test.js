import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture as storeFixture, startHeldWriter } from './c4-v2-test-helpers.js';
import { createConfigHandler, classifyConfigRunning, parseConfigArgs, listOverrides } from '../c4-config-handler.js';

function fixture(t, overrides = {}) {
  const { db, store } = storeFixture(t);
  store.insertConversation('in', 'chat', 'e', 'hello', { groupName: 'A' });
  const handler = createConfigHandler({ store, validateComponent: () => true, readSessionMode: () => 'multi', observeRunning: () => ({ hasProcess: false }), ...overrides });
  return { store, db, handler };
}
test('pure CLI parser rejects conflicts, duplicates, excess flags and missing model runtime', () => {
  for (const args of [[], ['get', '--group', 'origin', '--channel', 'chat'], ['get', '--group', 'origin', '--runtime', 'codex'], ['reset', '--group', 'origin', '--model', 'm'], ['get', '--group', 'origin', '--group', 'origin'], ['get', '--group'], ['get', '--session-group', 'A'], ['get', '--group', 'origin', '--json', '--json']]) {
    assert.throws(() => parseConfigArgs('runtime', args), { code: 'INVALID_ARGS' });
  }
  assert.throws(() => parseConfigArgs('model', ['get', '--group', 'origin']), { code: 'INVALID_ARGS' });
  assert.deepEqual(parseConfigArgs('model', ['set', '--channel', 'chat', '--session-group', 'A', '--runtime', 'codex', '--model', 'm', '--effort', 'high', '--json']), { json: true, request: { action: 'set', componentName: 'chat', groupName: 'A', runtime: 'codex', model: 'm', effort: 'high' } });
});
test('selectors only read existing namespaces and groups; exact values and unknown args rejected', async t => {
  const { handler, db } = fixture(t);
  const before = db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n;
  for (const request of [{ action: 'get', componentName: 'absent' }, { action: 'get', componentName: 'chat', groupName: 'B' }]) await assert.rejects(() => handler('runtime', request), { code: 'SESSION_GROUP_NOT_FOUND' });
  for (const groupName of ['', undefined, null]) await assert.rejects(() => handler('runtime', { action: 'get', componentName: 'chat', groupName }), { code: 'SESSION_GROUP_INVALID' });
  await assert.rejects(() => handler('runtime', { action: 'get', sessionGroup: 'chat:A', surprise: true }), { code: 'INVALID_ARGS' });
  await assert.rejects(() => handler('runtime', { action: 'get', sessionGroup: 'chat:' + 'a'.repeat(96) }), { code: 'SESSION_GROUP_TOO_LONG' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, before);
  const result = await handler('runtime', { action: 'set', componentName: 'chat', groupName: 'A', runtime: 'codex' });
  assert.equal(result.data.sessionGroup, 'chat:A'); assert.equal(result.data.running.status, 'not_running');
});
test('explicit group validation preserves invalid-versus-too-long errors before store access', async t => {
  const { handler, db } = fixture(t), before = db.prepare('SELECT total_changes() AS n').get().n;
  for (const [sessionGroup, code, message] of [
    ['BAD:' + 'a'.repeat(96), 'SESSION_GROUP_INVALID', 'Invalid namespace'],
    ['chat:' + 'a'.repeat(96), 'SESSION_GROUP_TOO_LONG', /over the 95-char limit/],
    ['chat:', 'SESSION_GROUP_INVALID', /at position 0/],
    ['chat:-bad', 'SESSION_GROUP_INVALID', /at position 0/],
    ['chat:a bad', 'SESSION_GROUP_INVALID', /at position 1/],
    [null, 'SESSION_GROUP_INVALID', 'Invalid session group'],
  ]) await assert.rejects(() => handler('runtime', { action: 'get', sessionGroup }), { code, message, persisted: [] });
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
});
test('saved changed and desired survive failed F1 or running observation; no fence or model loss', async t => {
  for (const overrides of [{ readSessionMode: () => { throw new Error('F1 failed'); } }, { observeRunning: async () => { await new Promise(resolve => setImmediate(resolve)); throw Object.assign(new Error(' unavailable'), { code: 'TMUX_UNAVAILABLE' }); } }]) {
    const { store, handler } = fixture(t, overrides);
    store.setSessionModelConfig({ sessionGroup: 'chat:A', runtime: 'codex', model: 'm', effort: 'high' });
    const request = { action: 'set', sessionGroup: 'chat:A', runtime: 'codex' };
    const first = await handler('runtime', request);
    assert.equal(first.ok, true); assert.equal(first.data.changed, true);
    assert.deepEqual(first.data.desired, { mode: 'override', runtime: 'codex' });
    assert.equal(first.data.running.status, 'unknown'); assert.ok(first.data.running.reason);
    if (overrides.observeRunning) assert.equal(first.data.running.code, 'TMUX_UNAVAILABLE');
    assert.deepEqual(store.getSessionRuntimeConfig({ sessionGroup: 'chat:A' }), { mode: 'override', runtime: 'codex' });
    assert.equal((await handler('runtime', request)).data.changed, false);
    assert.equal((await handler('runtime', { action: 'reset', sessionGroup: 'chat:A' })).data.changed, true);
    assert.equal(store.getSessionModelConfig({ sessionGroup: 'chat:A', runtime: 'codex' }).mode, 'override');
    assert.equal(store.getDrainFence('chat:A'), null);
  }
});
test('write error remains an error and preserves existing config', async t => {
  const { handler, store, db } = fixture(t);
  db.exec("CREATE TRIGGER reject_override BEFORE INSERT ON group_runtime_overrides BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await assert.rejects(() => handler('runtime', { action: 'set', sessionGroup: 'chat:A', runtime: 'codex' }), { code: 'CONFIG_STORE_FAILED' });
  assert.deepEqual(store.getSessionRuntimeConfig({ sessionGroup: 'chat:A' }), { mode: 'inherit' });
});
test('four-state priority returns null before sampling single or non-current runtime', () => {
  const resolved = { runtime: 'claude', mode: 'default' };
  const base = { kind: 'model', runtime: 'claude', sessionMode: 'multi', resolved, observation: { hasProcess: true, identityVerified: true, ready: true, runId: 'run1', launchConfig: resolved } };
  const check = (patch, status) => assert.equal(classifyConfigRunning({ ...base, ...patch }).status, status);
  assert.equal(classifyConfigRunning({ ...base, sessionMode: 'single', fence: { reason: 'model_config' } }), null);
  assert.equal(classifyConfigRunning({ ...base, runtime: 'codex', fence: { reason: 'model_config' } }), null);
  check({ fence: { reason: 'model_config' }, observation: { hasProcess: false } }, 'pending');
  check({ observation: { hasProcess: false } }, 'not_running');
  check({ observation: { ...base.observation, identityVerified: false } }, 'unknown');
  check({ observation: { ...base.observation, launchConfig: null } }, 'unknown');
  check({ observation: { ...base.observation, ready: undefined } }, 'unknown');
  check({ observation: { ...base.observation, ready: false } }, 'pending');
  check({ observation: { ...base.observation, launchConfig: { runtime: 'codex', mode: 'default' } } }, 'pending');
  check({}, 'applied');
  check({ kind: 'runtime', runtime: 'codex' }, 'applied');
});
test('postcommit resolution can see later writer without replacing saved desired', async t => {
  const { store } = fixture(t);
  const handler = createConfigHandler({ store, validateComponent: () => true,
    readSessionMode: () => { store.setSessionRuntimeConfig({ sessionGroup: 'chat:A', runtime: 'claude' }); return 'multi'; },
    observeRunning: () => ({ hasProcess: false }),
  });
  const result = await handler('runtime', { action: 'set', sessionGroup: 'chat:A', runtime: 'codex' });
  assert.equal(result.data.changed, true);
  assert.equal(result.data.desired.runtime, 'codex');
  assert.equal(result.data.resolved.runtime, 'claude');
});
test('model wrapper reads and writes exact pairs, rejects partial replacement', async t => {
  const { handler, store } = fixture(t);
  const request = { action: 'set', sessionGroup: 'chat:A', runtime: 'codex', model: 'm', effort: 'high' };
  assert.equal((await handler('model', request)).data.changed, true);
  assert.equal((await handler('model', request)).data.changed, false);
  assert.equal((await handler('model', request)).data.running, null);
  await assert.rejects(() => handler('model', { ...request, effort: null }), { code: 'MODEL_PAIR_REQUIRED' });
  assert.equal(store.getSessionModelConfig({ sessionGroup: 'chat:A', runtime: 'codex' }).effort, 'high');
});

test('single and non-current model return mode/resolved and skip fence/process sampling', async t => {
  for (const sessionMode of ['single', 'multi']) {
    const { store } = fixture(t);
    const originalFence = store.getDrainFence;
    store.getDrainFence = () => { throw new Error('must not read fence'); };
    const handler = createConfigHandler({ store, validateComponent: () => true,
      readSessionMode: () => sessionMode,
      observeRunning: () => { throw new Error('must not sample process'); },
    });
    for (const action of ['get', 'set', 'reset']) {
      const request = { action, sessionGroup: 'chat:A', runtime: 'codex',
        ...(action === 'set' ? { model: 'm', effort: 'high' } : {}) };
      const { data } = await handler('model', request);
      assert.equal(data.sessionMode, sessionMode);
      assert.deepEqual(data.resolved, { runtime: 'claude', mode: 'default' });
      assert.equal(data.running, null);
      assert.equal(data.runtime, 'codex');
      assert.ok(data.desired);
    }
    if (sessionMode === 'single') {
      const { data } = await handler('runtime', { action: 'get', sessionGroup: 'chat:A' });
      assert.equal(data.sessionMode, 'single');
      assert.deepEqual(data.resolved, { runtime: 'claude', mode: 'default' });
      assert.equal(data.running, null);
    }
    store.getDrainFence = originalFence;
  }
});
test('current model exposes resolved input and all four running statuses at handler boundary', async t => {
  const resolved = { runtime: 'claude', mode: 'default' };
  for (const [observation, expected] of [
    [{ hasProcess: false }, 'not_running'],
    [{ hasProcess: true, identityVerified: false }, 'unknown'],
    [{ hasProcess: true, identityVerified: true, ready: false, runId: 'run', launchConfig: resolved }, 'pending'],
    [{ hasProcess: true, identityVerified: true, ready: true, runId: 'run', launchConfig: resolved }, 'applied'],
  ]) {
    const { handler } = fixture(t, { observeRunning: () => observation });
    const { data } = await handler('model', { action: 'get', sessionGroup: 'chat:A', runtime: 'claude' });
    assert.equal(data.sessionMode, 'multi');
    assert.deepEqual(data.resolved, resolved);
    assert.equal(data.running.status, expected);
  }
});

test('requested override groups preserve runtime/model pairs in binary order and match per-group reads', async t => {
  const { store, db, filename } = storeFixture(t, {
    readConfig: () => ({ state: 'ok', config: { runtime: 'codex', session_mode: 'multi' } }),
  }, true);
  for (const groupName of ['a', 'B', 'empty', 'other']) store.insertConversation('in', 'chat', 'e', 'hello', { groupName });
  store.setSessionRuntimeConfig({ sessionGroup: 'chat:a', runtime: 'claude' });
  store.setSessionRuntimeConfig({ sessionGroup: 'chat:B', runtime: 'codex' });
  for (const [sessionGroup, runtime, model, effort] of [
    ['chat:a', 'codex', 'codex-a', 'high'], ['chat:a', 'claude', 'claude-a', 'low'], ['chat:B', 'codex', 'codex-B', 'medium'],
  ]) store.setSessionModelConfig({ sessionGroup, runtime, model, effort });
  store.setSessionRuntimeConfig({ sessionGroup: 'chat:other', runtime: 'claude' });
  store.setSessionModelConfig({ sessionGroup: 'chat:other', runtime: 'codex', model: 'excluded', effort: 'high' });
  db.pragma('wal_checkpoint(TRUNCATE)');
  const dbBytes = () => Buffer.concat([fs.readFileSync(filename), fs.readFileSync(`${filename}-wal`)]);
  const before = dbBytes();
  const observer = new db.constructor(filename);
  t.after(() => observer.close());
  const version = observer.pragma('data_version', { simple: true });
  const data = listOverrides({ store, groups: ['chat:a', 'chat:empty', 'chat:B'] });
  assert.deepEqual(data, {
    baseline: { runtime: 'codex', sessionMode: 'multi' },
    runtime: [{ sessionGroup: 'chat:B', runtime: 'codex' }, { sessionGroup: 'chat:a', runtime: 'claude' }],
    model: [
      { sessionGroup: 'chat:B', runtime: 'codex', model: 'codex-B', effort: 'medium' },
      { sessionGroup: 'chat:a', runtime: 'claude', model: 'claude-a', effort: 'low' },
      { sessionGroup: 'chat:a', runtime: 'codex', model: 'codex-a', effort: 'high' },
    ],
  });
  assert.equal('running' in data, false);
  const page = listOverrides({ store });
  assert.equal(page.runtimeTotal, 3); assert.equal(page.runtime.length, 3);
  assert.equal(page.nextAfter, null); assert.equal('model' in page, false);
  const handler = createConfigHandler({ store, readSessionMode: () => 'multi', observeRunning: () => ({ hasProcess: false }) });
  for (const sessionGroup of ['chat:B', 'chat:a', 'chat:empty']) {
    const runtime = data.runtime.find(row => row.sessionGroup === sessionGroup)?.runtime ?? data.baseline.runtime;
    const result = await handler('runtime', { action: 'get', sessionGroup });
    assert.equal(result.data.resolved.runtime, runtime);
    for (const rt of ['claude', 'codex']) {
      const model = await handler('model', { action: 'get', sessionGroup, runtime: rt });
      const row = data.model.find(row => row.sessionGroup === sessionGroup && row.runtime === rt);
      assert.deepEqual(model.data.desired, row ? { runtime: rt, mode: 'override', model: row.model, effort: row.effort } : { runtime: rt, mode: 'default' });
    }
  }
  assert.equal(observer.pragma('data_version', { simple: true }), version);
  assert.ok(dbBytes().equals(before), 'database or WAL bytes changed');
});

// Isolated private DB/HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR only; no live resources.
// Covers snapshot reads under a writer; run for override/read-transaction changes, skip unrelated UI.
test('override snapshot reads committed rows while another writer holds its transaction', { timeout: 10000 }, async t => {
  const { store, db, filename } = storeFixture(t, {}, true);
  const paths = Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR'].map(key => [key, process.env[key]]));
  assert.ok(filename.startsWith(paths.TMPDIR + path.sep));
  assert.ok(paths.PM2_HOME.startsWith(paths.HOME + path.sep));
  console.log(JSON.stringify({ overridesWriter: filename, ...paths }));
  db.pragma('busy_timeout=100');
  const writer = startHeldWriter(filename,
    "INSERT INTO group_model_overrides(session_group,runtime,model,effort) VALUES ('chat:pending','codex','held-model','high')");
  const timer = setTimeout(() => writer.child.kill('SIGKILL'), 5000);
  try {
    const [state] = await writer.held;
    assert.equal(state.journal, 'wal'); assert.equal(state.inTransaction, true);
    assert.deepEqual(listOverrides({ store, groups: ['chat:pending'] }).model, []);
    assert.equal(listOverrides({ store }).runtimeTotal, 0);
    writer.child.send('commit');
    const [code, signal] = await writer.exited;
    assert.equal(code, 0, writer.stderr()); assert.equal(signal, null);
    assert.deepEqual(listOverrides({ store, groups: ['chat:pending'] }).model,
      [{ sessionGroup: 'chat:pending', runtime: 'codex', model: 'held-model', effort: 'high' }]);
  } finally {
    clearTimeout(timer);
    if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill('SIGKILL');
    await writer.exited;
  }
});

test('only selected override groups read baseline configuration', t => {
  const { store, dependencies } = storeFixture(t);
  dependencies.readConfig = () => ({ state: 'missing' });
  assert.deepEqual(listOverrides({ store }), { runtimeTotal: 0, runtime: [], nextAfter: null });
  assert.deepEqual(listOverrides({ store, groups: ['chat:absent'] }), { baseline: { runtime: 'claude', sessionMode: 'single' }, runtime: [], model: [] });
  for (const readConfig of [
    () => ({ state: 'unreadable' }), () => { throw new Error('bad JSON'); },
    () => ({ state: 'ok', config: { runtime: 'unknown' } }),
  ]) {
    let reads = 0;
    dependencies.readConfig = () => { reads++; return readConfig(); };
    const page = listOverrides({ store });
    assert.deepEqual(page, { runtimeTotal: 0, runtime: [], nextAfter: null });
    assert.equal('baseline' in page, false); assert.equal(reads, 0);
    assert.throws(() => listOverrides({ store, groups: ['chat:absent'] }), { code: 'CONFIG_UNREADABLE' });
    assert.equal(reads, 1);
  }
});

test('runtime override pages are bounded, ordered and retain the unfiltered total', t => {
  const { store, db } = storeFixture(t);
  const insert = db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)');
  db.transaction(() => {
    for (let i = 0; i < 250; i++) insert.run(`chat:${i % 2 ? 'oc_' : 'other_'}${String(i).padStart(3, '0')}`, i % 2 ? 'codex' : 'claude');
  })();
  db.prepare('INSERT INTO group_model_overrides(session_group,runtime,model,effort) VALUES (?,?,?,?)').run('chat:model-only', 'codex', 'm', 'high');
  const expected = db.prepare('SELECT session_group FROM group_runtime_overrides ORDER BY session_group COLLATE BINARY').all();
  const keys = [];
  let after;
  for (const size of [100, 100, 50]) {
    const page = listOverrides({ store, after });
    assert.equal(page.runtimeTotal, 250); assert.equal(page.runtime.length, size);
    assert.equal('model' in page, false);
    for (const row of page.runtime) keys.push(row.sessionGroup);
    assert.equal(page.nextAfter, size === 50 ? null : page.runtime.at(-1).sessionGroup);
    after = page.nextAfter;
  }
  assert.equal(keys.length, 250); assert.equal(new Set(keys).size, 250);
  for (let i = 0; i < keys.length; i++) assert.equal(keys[i], expected[i].session_group);
  const first = listOverrides({ store, match: 'OC_' });
  const second = listOverrides({ store, match: 'OC_', after: first.nextAfter });
  assert.equal(first.runtimeTotal, 250); assert.equal(second.runtimeTotal, 250);
  assert.equal(first.runtime.length, 100); assert.equal(second.runtime.length, 25); assert.equal(second.nextAfter, null);
  for (const row of [...first.runtime, ...second.runtime]) assert.ok(row.sessionGroup.toLowerCase().includes('oc_'));
  assert.equal(new Set([...first.runtime, ...second.runtime].map(row => row.sessionGroup)).size, 125);
  db.prepare('DELETE FROM group_runtime_overrides WHERE session_group>=?').run(expected[100].session_group);
  const exact = listOverrides({ store });
  assert.equal(exact.runtime.length, 100); assert.equal(exact.runtimeTotal, 100); assert.equal(exact.nextAfter, null);
});

test('runtime pagination reads at most one extra SQL row even with a large override table', t => {
  const { store, db } = storeFixture(t);
  const insert = db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)');
  db.transaction(() => { for (let i = 0; i < 100000; i++) insert.run(`chat:g${String(i).padStart(6, '0')}`, 'codex'); })();
  const prepare = db.prepare.bind(db), reads = [];
  db.prepare = sql => {
    const statement = prepare(sql);
    if (!/^\s*SELECT\b/i.test(sql) || !/\bFROM\s+group_runtime_overrides\b/i.test(sql) || /\bCOUNT\s*\(/i.test(sql)) return statement;
    const read = { sql, rows: 0 }; reads.push(read);
    const iterate = (...args) => {
      const cursor = statement.iterate(...args);
      return {
        [Symbol.iterator]() { return this; },
        next() {
          const row = cursor.next();
          if (!row.done) {
            read.rows++;
            if (read.rows > 101) { cursor.return(); assert.fail('runtime page read more than limit + 1 SQL rows'); }
          }
          return row;
        },
        return() { return cursor.return(); },
      };
    };
    return new Proxy(statement, { get(target, key) {
      if (key === 'iterate') return iterate;
      if (key === 'all') return (...args) => Array.from(iterate(...args));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try {
    const page = listOverrides({ store });
    assert.equal(page.runtimeTotal, 100000); assert.equal(page.runtime.length, 100);
    assert.equal(page.nextAfter, 'chat:g000099');
    assert.equal(reads.length, 1); assert.equal(reads[0].rows, 101);
    assert.match(reads[0].sql, /\bLIMIT\b/i);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 10000);
  } finally { db.prepare = prepare; }
});

test('override pages preserve literal search and binary cursors', t => {
  const { store, db } = storeFixture(t);
  assert.equal(listOverrides({ store }).runtimeTotal, 0);
  const insert = db.prepare('INSERT INTO group_runtime_overrides(session_group,runtime) VALUES (?,?)');
  db.transaction(() => {
    for (let i = 0; i < 101; i++) insert.run(`lark:${i % 2 ? 'OC_' : 'oc_'}${String(i).padStart(3, '0')}`, 'codex');
    for (const group of ['lark:ocX1', 'chat:other']) insert.run(group, 'claude');
  })();
  const first = listOverrides({ store, match: 'OC_' });
  const second = listOverrides({ store, match: 'OC_', after: first.nextAfter });
  assert.equal(first.runtime.length, 100); assert.equal(second.runtime.length, 1);
  assert.equal(first.runtimeTotal, 103); assert.equal(second.runtimeTotal, 103);
  assert.equal(second.nextAfter, null);
  const keys = [...first.runtime, ...second.runtime].map(row => row.sessionGroup);
  assert.equal(new Set(keys).size, 101);
  for (const key of keys) assert.ok(key.toLowerCase().includes('oc_'));
  assert.equal(keys.includes('lark:ocX1'), false);
  db.prepare('DELETE FROM group_runtime_overrides WHERE session_group=?').run(second.runtime[0].sessionGroup);
  const exact = listOverrides({ store, match: 'OC_' });
  assert.equal(exact.runtime.length, 100); assert.equal(exact.nextAfter, null);
  db.prepare('DELETE FROM group_runtime_overrides').run();
  for (let i = 0; i < 99; i++) insert.run(`chat:A${String(i).padStart(2, '0')}`, 'codex');
  for (const group of ['chat:B', 'chat:a']) insert.run(group, 'codex');
  const sorted = listOverrides({ store });
  assert.equal(sorted.runtime.length, 100);
  for (let i = 0; i < 99; i++) assert.equal(sorted.runtime[i].sessionGroup, `chat:A${String(i).padStart(2, '0')}`);
  assert.equal(sorted.runtime[99].sessionGroup, 'chat:B');
  assert.equal(sorted.nextAfter, 'chat:B');
  const last = listOverrides({ store, after: sorted.nextAfter });
  assert.deepEqual(last.runtime, [{ sessionGroup: 'chat:a', runtime: 'codex' }]);
  assert.equal(last.nextAfter, null);
});
