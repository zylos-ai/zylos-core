import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
import { Store } from '../src/lib/store.js';
import { createDisplayNames, validKey, validName, fallbackName } from '../src/lib/workbench/display-names.js';
import { searchGroups } from '../src/lib/workbench/group-search.js';
import { AuthGate, hashApiKey } from '../src/lib/auth.js';
import { StateEngine } from '../src/lib/state-engine.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { createGroupSnapshot, workbenchResponse } from '../src/lib/workbench/group-snapshot.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'display-name-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, names: createDisplayNames({ store, zylosDir: root }) };
}
test('human names resist agent overwrite and clear while human changes and idempotent clears succeed', t => {
  const f = fixture(t), key = 'telegram:a';
  assert.deepEqual(f.names.setName(key, ' 产品周会 ', 'human'), { sessionGroup: key, displayName: '产品周会', source: 'human' });
  const before = f.store.getGroupDisplayName(key);
  assert.throws(() => f.names.setName(key, 'agent', 'agent'), { code: 'NAME_SET_BY_HUMAN' });
  assert.throws(() => f.names.clearName(key, 'agent'), { code: 'NAME_SET_BY_HUMAN' });
  assert.deepEqual(f.store.getGroupDisplayName(key), before);
  assert.deepEqual(f.names.clearName(key, 'human'), { sessionGroup: key, displayName: null, source: null });
  assert.deepEqual(f.names.clearName(key, 'agent'), { sessionGroup: key, displayName: null, source: null });
  f.names.setName(key, 'agent', 'agent');
  assert.deepEqual(f.names.setName(key, 'human again', 'human'), { sessionGroup: key, displayName: 'human again', source: 'human' });
  const second = new Store(path.join(f.root, 'dashboard.db'));
  try { assert.throws(() => createDisplayNames({ store: second }).setName(key, 'late agent', 'agent'), { code: 'NAME_SET_BY_HUMAN' }); }
  finally { second.close(); }
});
test('display names count Unicode code points and reject control characters and invalid keys', t => {
  const f = fixture(t);
  for (const value of ['', ' ', 'x'.repeat(41), 'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u0085b', 'a\u2028b', null]) {
    assert.equal(validName(value), null); assert.throws(() => f.names.setName('telegram:a', value, 'agent'), { code: 'NAME_INVALID' });
  }
  assert.equal(validName(' 😀 '.repeat(1)), '😀');
  assert.equal(f.names.setName('telegram:a', '😀'.repeat(40), 'agent').displayName, '😀'.repeat(40));
  assert.throws(() => f.names.setName('telegram:a', '😀'.repeat(41), 'human'), { code: 'NAME_INVALID' });
  for (const key of ['origin', 'bad key', '', null, 'Telegram:a', 'telegram:']) {
    assert.equal(validKey(key), false); assert.throws(() => f.names.setName(key, 'name', 'human'), { code: 'KEY_INVALID' });
    assert.throws(() => f.names.clearName(key, 'human'), { code: 'KEY_INVALID' });
  }
});
test('fallback labels use only platform and parsed group segment', () => {
  assert.equal(fallbackName('origin'), 'Origin');
  assert.equal(fallbackName('telegram'), 'Telegram');
  assert.equal(fallbackName('telegram:dm-1001'), 'Telegram · dm-1001');
  for (const [key, label] of [['lark:a', 'Lark'], ['feishu:a', '飞书'], ['web-console:a', '网页控制台'], ['openmax:a', 'OpenMax'], ['wechat:a', '微信'], ['custom:a', 'custom']]) assert.equal(fallbackName(key), label + ' · a');
  assert.equal(fallbackName('custom:a', 'telegram'), 'Telegram · a');
});
// Cross-module search integration: real SQLite/name service and existing group
// search consumer; Core key lookup and snapshot inputs injected. Run for name
// search wiring, skip rendering-only edits. Owned DB, no children/network/PM2/tmux;
// fixture closes Store before removing only its temporary root.
test('display-name search feeds both historical and snapshot rows through the existing group search', async t => {
  const f = fixture(t);
  f.names.setName('telegram:a', '产品周会', 'human'); f.names.setName('telegram:b', '周报', 'agent');
  assert.deepEqual(new Set(f.names.search('周', 50).map(row => row.sessionGroup)), new Set(['telegram:a', 'telegram:b']));
  assert.equal(f.names.listAll().get('telegram:a').source, 'human');
  const existing = { sessionGroup: 'telegram:a', name: f.names.getName('telegram:a') };
  let calls = 0;
  const result = await searchGroups('周', { displayNames: f.names, runC4Db: async () => { calls++; return { ok: true, data: [] }; },
    getSnapshot: async () => ({ rows: [existing], listKnown: true }) });
  assert.deepEqual(new Set(result.rows.map(row => row.sessionGroup)), new Set(['telegram:a', 'telegram:b']));
  assert.equal(result.rows.find(row => row.sessionGroup === 'telegram:a'), existing);
  assert.equal(result.rows.find(row => row.sessionGroup === 'telegram:b').name.displayName, '周报');
  assert.equal(calls, 0);
  f.names.setName('telegram:c', 'Ascii', 'agent'); assert.equal(f.names.search('ASCII', 50)[0].displayName, 'Ascii');
});

// HTTP integration: real createServer/AuthGate/Store/name service and group snapshot consumer.
// Run for name API, local auth or snapshot wiring; skip rendering-only edits.
// Runner supplies isolated HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR. Own loopback
// random port and SQLite; Core/CLI inputs injected, no Core child/real PM2/tmux.
// Requests bounded3s, case15s; close server, Store and auth timer before root cleanup.
test('local name routes require admin and publish human-owned names in group snapshots', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name-http-')), data = path.join(root, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  let server, engine, auth, clock = 1800000000000;
  const previous = process.env.ZYLOS_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    clearInterval(auth?._cleanupTimer); engine?.store.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.module('node:child_process', { namedExports: { ...childProcess, execFileSync: () => '1.0.0', execFile: () => assert.fail('Core child forbidden') } });
  t.mock.module('../src/lib/state-engine.js', { namedExports: { StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } } } });
  t.mock.module('../src/lib/auth.js', { namedExports: { ...await import('../src/lib/auth.js'), AuthGate: class extends AuthGate { constructor(...args) { super(...args); auth = this; } } } });
  t.mock.module('../src/lib/workbench/group-snapshot.js', { namedExports: { workbenchResponse,
    createGroupSnapshot: options => createGroupSnapshot({ ...options, now: () => clock,
      cli: { runC4Db: async args => ({ ok: true, data: args[0] === 'groups' ? { groups: [{ sessionGroup: 'telegram:a', componentName: 'telegram' }], hasOlder: false } : { groups: [], globalFence: null } }),
        readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) },
      loadCoreModule: async name => name === 'config.js' ? { readSessionMode: () => ({ mode: 'multi' }) }
        : name === 'session-state-reader.js' ? { readAccountUsage: async () => null }
          : { collectStatus: async () => ({ view: 'multi', origin: { presence: 'not_running' }, groups: [], groupListError: null, runtimeHealth: {} }) },
    }),
  } });
  process.env.ZYLOS_DIR = root;
  const { createServer } = await import(`../src/index.js?display-name-http=${Date.now()}`);
  if (previous === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = previous;
  server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function token(scope, marker) {
    const token = `zylos_st_${marker.repeat(64)}`, key = engine.store.insertApiKey({ name: scope, keyHash: hashApiKey(`zylos_ak_${marker.repeat(64)}`), scope });
    engine.store.insertApiSession({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), apiKeyId: Number(key.lastInsertRowid), scope, createdAt: Date.now(), expiresAt: Date.now() + 60000 });
    return token;
  }
  const read = token('read', 'a'), admin = token('admin', 'b');
  const request = (route, method = 'GET', body, credential = admin) => fetch(origin + route, { method, signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const route = '/api/workbench/groups/telegram%3Aa/name';
  for (const method of ['PUT', 'DELETE']) assert.equal((await request(route, method, method === 'PUT' ? { name: 'blocked' } : undefined, read)).status, 403);
  let response = await request(route, 'PUT', { name: '<script>' }); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: { sessionGroup: 'telegram:a', displayName: '<script>', source: 'human' } });
  response = await request('/api/workbench/groups'); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rows.find(row => row.sessionGroup === 'telegram:a').name, { sessionGroup: 'telegram:a', displayName: '<script>', source: 'human' });
  const names = createDisplayNames({ store: engine.store });
  assert.throws(() => names.setName('telegram:a', 'agent', 'agent'), { code: 'NAME_SET_BY_HUMAN' });
  assert.equal((await request('/api/workbench/groups/origin/name', 'PUT', { name: 'bad' })).status, 400);
  response = await request(route, 'PUT', { name: '' }); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'NAME_INVALID');
  response = await request(route, 'PUT', { name: 'x'.repeat(4096) });
  assert.equal(response.status, 413); assert.deepEqual(await response.json(), { error: 'payload_too_large' });
  response = await fetch(origin + route, { method: 'PUT', signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid_json' });
  await t.test('unexpected name storage failures return a generic server error', async child => {
    const detail = 'private SQLite storage failure';
    const write = child.mock.method(engine.store, 'writeGroupDisplayName', () => {
      throw Object.assign(new Error(detail), { code: 'SQLITE_BUSY' });
    });
    try {
      for (const method of ['PUT', 'DELETE']) {
        const failed = await request(route, method, method === 'PUT' ? { name: 'valid' } : undefined);
        assert.equal(failed.status, 500);
        const body = await failed.text();
        assert.equal(body.includes(detail), false); assert.equal(body.includes('SQLITE_BUSY'), false);
        assert.deepEqual(JSON.parse(body), { error: 'internal_error' });
      }
    } finally { write.mock.restore(); }
  });
  response = await request(route, 'DELETE'); assert.equal(response.status, 200); assert.equal((await response.json()).data.displayName, null);
  clock += 2100; response = await request('/api/workbench/groups'); assert.equal((await response.json()).rows.find(row => row.sessionGroup === 'telegram:a').name, null);
});

test('naming candidates carry only the redacted preview text, never the reader message', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'display-name-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const secret = 'sk-' + 'q'.repeat(32);
  const groups = [{ sessionGroup: 'telegram:a', componentName: 'telegram', lastActivityAt: 5,
    preview: { timestamp: 5, channel: 'telegram', endpoint: 'a', text: 'please use ' + secret, message: 'please use ' + secret, messageSource: { kind: 'scheduled_task', taskId: 'task-ab12cd34' } } }];
  const names = createDisplayNames({ store, zylosDir: root, runC4Db: async () => ({ ok: true, data: groups }) });
  const [row] = await names.listNames();
  assert.equal(row.preview.text, 'please use [REDACTED]');
  assert.equal(Object.hasOwn(row.preview, 'message'), false);
  assert.equal(Object.hasOwn(row.preview, 'messageSource'), false);
  assert.equal(JSON.stringify(row).includes(secret) || JSON.stringify(row).includes('task-ab12cd34'), false);
});
