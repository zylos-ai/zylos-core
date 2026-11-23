import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { receive } from '../c4-receive.js';
import { validRouteResponse, queryRoute, fallbackFileRoute } from '../c4-entry-route.js';

const input = ['--channel', 'chat', '--endpoint', 'room|msg:1', '--content', 'hello'];
const pending = { decision: 'pending', recovered: true, runtime: 'codex', health: 'rate_limited', reason: 'quota', transitionHold: false };
const rejected = { recovered: false, runtime: 'codex', health: 'unavailable', reason: 'down', transitionHold: false, userMessage: 'unavailable' };
const auth = result => ({ ...rejected, decision: 'auth_rejected', health: 'auth_failed', reason: 'auth_failed', auth: { result, detail: 'probe\u0000failed' } });
function setup(t, storeDependencies = {}) {
  const f = fixture(t, storeDependencies, true);
  fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'chat'), { recursive: true });
  const events = [], order = [];
  const dependencies = { db: f.store,
    queryRoute: async () => pending,
    appendEntryEvent: async event => { assert.ok(f.db.prepare('SELECT id FROM conversations WHERE id=?').get(event.conversation_id)); order.push(event.event); events.push(event); return true; },
    reserveStatusNotice: (_channel, _endpoint, route) => { assert.ok(f.db.prepare('SELECT id FROM conversations WHERE session_group=?').get(route.sessionGroup)); order.push('reserve'); return { suppressed: false }; },
    sendStatusNotice: () => { order.push('send'); return { outcome: 'sent' }; }, diagnostic: () => {} };
  return { ...f, events, order, dependencies };
}

test('dashboard origin is stored in origin in both session modes and refuses a caller-chosen group', async t => {
  for (const mode of ['single', 'multi']) {
    const f = setup(t, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } }) });
    fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'dashboard'), { recursive: true });
    const rejections = [];
    let routed = 0;
    f.dependencies.queryRoute = async () => { routed++; return pending; };
    f.dependencies.appendEntryEvent = async event => { if (event.event === 'group_rejected') rejections.push(event); return true; };
    const stored = await receive(['--channel', 'dashboard', '--endpoint', 'origin', '--content', `from ${mode}`], f.dependencies);
    assert.equal(f.db.prepare('SELECT session_group FROM conversations WHERE id=?').get(stored.id).session_group, 'origin', mode);
    await assert.rejects(receive(['--channel', 'dashboard', '--endpoint', 'origin', '--content', 'grouped', '--session-group', 'origin'], f.dependencies),
      { code: 'INVALID_ARGS', message: /fixed address dashboard origin/ });
    await assert.rejects(receive(['--channel', 'dashboard', '--endpoint', 'origin', '--content', 'grouped', '--session-group', 'Team'], f.dependencies),
      { code: 'INVALID_ARGS' });
    assert.equal(routed, 1, `${mode}: a refused message is not routed`);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE content='grouped'").get().n, 0, `${mode}: nothing stored`);
    assert.deepEqual(rejections.map(event => [event.channel, event.endpoint, event.reason_code, event.conversation_id]),
      [['dashboard', 'origin', 'INVALID_ARGS', null], ['dashboard', 'origin', 'INVALID_ARGS', null]]);
    // The address `origin` means nothing special on another channel.
    const other = await receive(['--channel', 'chat', '--endpoint', 'origin', '--content', 'elsewhere', '--session-group', 'Team'], f.dependencies);
    assert.equal(other.sessionGroup, 'chat:Team', mode);
  }
});

test('explicit pending/transition/rate-limit takes precedence; unavailable and noReply stay failed', async t => {
  const f = setup(t);
  for (const route of [pending, { ...pending, transitionHold: true }, rejected]) {
    f.dependencies.queryRoute = async () => route;
    const result = await receive([...input, '--session-group', 'Team'], f.dependencies);
    const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(result.id);
    assert.equal(row.status, route.decision === 'pending' ? 'pending' : 'failed');
    assert.equal(result.sessionGroup, 'chat:Team');
  }
  f.dependencies.queryRoute = async request => { assert.equal(request.coreSide, true); assert.equal(request.componentName, 'chat'); return rejected; };
  const result = await receive([...input, '--session-group', 'New', '--no-reply', '--core-source', 'scheduler'], f.dependencies);
  const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(result.id);
  assert.equal(row.status, 'failed'); assert.equal(row.endpoint_id, null); assert.equal(row.session_group, 'chat:New');
  assert.equal(f.store.getNextPending({ sessionGroups: ['chat:New'] }), null);
});

test('real rollback/DB_BUSY prevent and cooldown; postcommit uncertainty preserves failed row', async t => {
  const f = setup(t); f.dependencies.queryRoute = async () => auth('failed');
  f.db.exec("CREATE TRIGGER reject_inbound AFTER INSERT ON conversations BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(receive(input, f.dependencies), { code: 'DB_WRITE_FAILED', persisted: [] });
  assert.equal(f.events.length, 0); assert.equal(f.order.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 0);
  f.db.exec('DROP TRIGGER reject_inbound');
  const other = new Database(f.filename); t.after(() => other.close()); f.db.pragma('busy_timeout=10'); other.exec('BEGIN IMMEDIATE');
  try { await assert.rejects(receive(input, f.dependencies), { code: 'DB_BUSY', persisted: [] }); }
  finally { other.exec('ROLLBACK'); }
  assert.equal(f.events.length, 0); assert.equal(f.order.length, 0);
  f.dependencies.sendStatusNotice = () => ({ outcome: 'uncertain' });
  await assert.rejects(receive(input, f.dependencies), { code: 'UNHEALTHY_NOTIFY_UNCERTAIN', persisted: ['D1'] });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE status='failed'").get().n, 1);
  assert.deepEqual(f.order, ['message_received', 'auth_rejected', 'reserve']);
  assert.deepEqual(f.events.map(event => event.event), ['message_received', 'auth_rejected']);
  const row = f.db.prepare("SELECT * FROM conversations WHERE status='failed'").get();
  assert.equal(f.events[0].conversation_id, row.id);
  assert.equal(f.events[0].session_group, row.session_group);
  assert.equal(f.events[0].reason_code, 'auth_rejected');
  assert.ok(Number.isFinite(f.events[0].received_at_ms));
  f.dependencies.db = { ...f.store, insertConversation: () => { throw new Error('unknown commit'); } };
  await assert.rejects(receive(input, f.dependencies), { code: 'INTERNAL_ERROR', persisted: null });
  assert.deepEqual(f.order, ['message_received', 'auth_rejected', 'reserve']);
  assert.equal(f.events.length, 2, 'an unknown commit must not append events or reserve another notice');
});

test('v2 correlation/branches reject malformed responses and fall back exactly once', async () => {
  const request = { type: 'route', requestId: '1-1', noReply: false };
  const response = { version: 2, type: 'route', requestId: '1-1', ...pending };
  assert.equal(validRouteResponse(response, request), true);
  for (const extra of [{ version: 1 }, { requestId: 'wrong' }, { decision: 'new' }, { recovered: false }, { auth: { result: 'failed', detail: 'bad' } }, { transitionHold: 'yes' }, { runtime: '' }, { decision: undefined }, { decision: 'auth_rejected', auth: { result: 'success' } }]) {
    let fallbacks = 0;
    const result = await queryRoute(request, { ipcRoute: async () => ({ ...response, ...extra }), fallbackFileRoute: () => { fallbacks++; return pending; } });
    assert.equal(result, pending); assert.equal(fallbacks, 1);
  }
});

test('fallback six-level order, target runtime only, and Core external auth distinction', async () => {
  for (const coreSide of [false, true]) {
    const request = { sessionGroup: 'chat:A', componentName: 'chat', coreSide };
    const reads = [];
    const deps = { diagnostic: () => {}, getModeTransition: () => null, resolveTargetRuntime: async () => 'codex', readRuntimeHealth: runtime => { reads.push(runtime); return { health: 'auth_failed', publicHealth: 'auth_failed', reason: 'auth_failed' }; } };
    const authRoute = await fallbackFileRoute(request, deps);
    assert.equal(authRoute.decision, coreSide ? 'pending' : 'auth_rejected');
    if (!coreSide) {
      assert.equal(authRoute.auth.detail, 'router_unavailable: health record auth_failed');
      assert.equal(authRoute.auth.result, 'unconfirmed');
    }
    assert.deepEqual(reads, ['codex']);
    for (const status of [{ missing: true }, { unreadable: true }, { health: 'ok', publicHealth: 'ok' }, { health: 'rate_limited', publicHealth: 'rate_limited' }]) {
      const result = await fallbackFileRoute(request, { ...deps, readRuntimeHealth: () => status }); assert.equal(result.decision, 'pending');
    }
    const down = await fallbackFileRoute(request, { ...deps, readRuntimeHealth: () => ({ health: 'down', publicHealth: 'unavailable', reason: 'dead' }) });
    assert.equal(down.decision, undefined); assert.equal(down.recovered, false);
    for (const extra of [{ getModeTransition: () => ({ state: 'open' }) }, { getModeTransition: () => { throw new Error('busy'); } }, { resolveTargetRuntime: async () => 'unknown' }]) {
      let healthReads = 0;
      const result = await fallbackFileRoute(request, { ...deps, ...extra, readRuntimeHealth: () => { healthReads++; return { health: 'ok', publicHealth: 'ok' }; } });
      assert.equal(result.decision, 'pending');
      assert.equal(healthReads, 0, 'transition and unknown runtime must stop before reading health');
    }
  }
});
