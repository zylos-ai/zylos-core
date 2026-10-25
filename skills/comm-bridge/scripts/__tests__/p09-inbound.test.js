import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { receive, parseReceiveArgs } from '../c4-receive.js';
import { validRouteResponse, queryRoute, fallbackFileRoute } from '../c4-entry-route.js';
import { appendEntryEvent, queryRejection } from '../c4-entry-events.js';
import { dataError } from '../c4-session-group.js';
import { statusNoticeKey } from '../status-notice.js';

const input = ['--channel', 'chat', '--endpoint', 'room|msg:1', '--content', 'hello'];
const pending = { decision: 'pending', recovered: true, runtime: 'codex', health: 'rate_limited', reason: 'quota', transitionHold: false };
const rejected = { recovered: false, runtime: 'codex', health: 'unavailable', reason: 'down', transitionHold: false, userMessage: 'unavailable' };
const auth = result => ({ ...rejected, decision: 'auth_rejected', health: 'auth_failed', reason: 'auth_failed', auth: { result, detail: 'probe\u0000failed' } });
function setup(t) {
  const f = fixture(t, {}, true);
  fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.claude', 'skills', 'chat'), { recursive: true });
  const events = [], order = [];
  const dependencies = { db: f.store,
    queryRoute: async () => pending,
    appendEntryEvent: async event => { assert.ok(f.db.prepare('SELECT id FROM conversations WHERE id=?').get(event.conversation_id)); order.push('event'); events.push(event); return true; },
    reserveStatusNotice: (_channel, _endpoint, route) => { assert.ok(f.db.prepare('SELECT id FROM conversations WHERE session_group=?').get(route.sessionGroup)); order.push('reserve'); return { suppressed: false }; },
    sendStatusNotice: () => { order.push('send'); return { outcome: 'sent' }; }, diagnostic: () => {} };
  return { ...f, events, order, dependencies };
}

test('IF-01 validates before route/D5/D6; name/group errors emit one F14 and ordinary argument errors none', async t => {
  const f = setup(t); let routed = 0, events = 0;
  f.dependencies.queryRoute = async () => { routed++; return pending; };
  f.dependencies.appendEntryEvent = async () => { events++; return true; };
  for (const name of ['', '-x', 'x'.repeat(96), 'a b']) {
    await assert.rejects(receive([...input, '--session-group', name], f.dependencies), { code: name.length > 95 ? 'SESSION_GROUP_TOO_LONG' : 'SESSION_GROUP_INVALID' });
  }
  await assert.rejects(receive(['--channel', 'p09-not-installed', '--content', 'text', '--no-reply'], f.dependencies), { code: 'INVALID_ARGS' });
  assert.equal(events, 5);
  await assert.rejects(receive(['--channel', 'chat', '--endpoint', '', '--content', 'text'], f.dependencies), { code: 'INVALID_ARGS' });
  assert.equal(events, 5);
  for (const args of [input.slice(0, 4), [...input, '--priority', '1x'], [...input, '--group', 'chat'], [...input, '--core-source', 'fake']]) {
    await assert.rejects(receive(args, f.dependencies), { code: 'INVALID_ARGS' });
  }
  assert.equal(events, 5); assert.equal(routed, 0);
  for (const table of ['conversations', 'channel_namespaces', 'group_heads']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.throws(() => parseReceiveArgs([...input, '--priority']), { code: 'INVALID_ARGS' });
});

test('IB-01 option-like nonempty text is retained as message content', async t => {
  const f = setup(t);
  const result = await receive(['--channel', 'chat', '--content', '--- notes'], f.dependencies);
  assert.equal(f.db.prepare('SELECT content FROM conversations WHERE id=?').get(result.id).content, '--- notes');
});

test('IF-02 explicit pending/transition/rate-limit takes precedence; unavailable and noReply stay failed', async t => {
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

test('IF-02/05 auth final group and failure category survive event/cooldown/send failures after commit', async t => {
  const f = setup(t);
  for (const result of ['failed', 'unconfirmed']) {
    f.dependencies.queryRoute = async request => { assert.equal(request.sessionGroup, result === 'failed' ? null : 'chat:Team'); return auth(result); };
    f.dependencies.reserveStatusNotice = (_c, _e, route) => { assert.equal(route.sessionGroup, 'chat:Team'); f.order.push('reserve'); return { suppressed: true }; };
    const reply = await receive([...input, '--session-group', 'Team'], f.dependencies);
    assert.equal(reply.action, 'auth_rejected'); assert.equal(reply.reasonLogged, true);
    const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(reply.id);
    assert.equal(row.status, 'failed'); assert.equal(row.delivery_action, 'auth_rejected');
    assert.equal(f.events.at(-1).reason_code, 'auth_check_' + result);
  }
  assert.deepEqual(f.order, ['event', 'reserve', 'event', 'reserve']);
  f.dependencies.queryRoute = async () => auth('failed');
  f.dependencies.appendEntryEvent = async () => false;
  const noReply = await receive([...input, '--no-reply'], f.dependencies);
  assert.equal(noReply.reasonLogged, false); assert.equal(noReply.action, 'auth_rejected');
  f.dependencies.reserveStatusNotice = () => { throw new Error('busy'); };
  await assert.rejects(receive(input, f.dependencies), { code: 'UNHEALTHY_NOTIFY_FAILED', persisted: ['D1'] });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE status='failed' AND delivery_action='auth_rejected'").get().n, 4);
});

test('IF-05 real rollback/DB_BUSY prevent F14 and cooldown; postcommit uncertainty preserves failed row', async t => {
  const f = setup(t); f.dependencies.queryRoute = async () => auth('failed');
  f.db.exec("CREATE TRIGGER reject_inbound AFTER INSERT ON conversations BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(receive(input, f.dependencies), { code: 'DB_WRITE_FAILED', persisted: [] });
  assert.equal(f.events.length, 0); assert.equal(f.order.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 0);
  f.db.exec('DROP TRIGGER reject_inbound');
  const other = new Database(f.filename); t.after(() => other.close()); f.db.pragma('busy_timeout=10'); other.exec('BEGIN IMMEDIATE');
  try { await assert.rejects(receive(input, f.dependencies), { code: 'DB_BUSY', persisted: [] }); }
  finally { other.exec('ROLLBACK'); }
  assert.equal(f.events.length, 0);
  f.dependencies.sendStatusNotice = () => ({ outcome: 'uncertain' });
  await assert.rejects(receive(input, f.dependencies), { code: 'UNHEALTHY_NOTIFY_UNCERTAIN', persisted: ['D1'] });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM conversations WHERE status='failed'").get().n, 1);
  assert.deepEqual(f.order, ['event', 'reserve']);
  f.dependencies.db = { ...f.store, insertConversation: () => { throw Object.assign(new Error('unknown commit'), { persisted: null }); } };
  await assert.rejects(receive(input, f.dependencies), { code: 'INTERNAL_ERROR', persisted: null });
});

test('IF-05 preserves data-layer contract errors and marks unexpected postcommit errors unknown', async t => {
  const f = setup(t);
  for (const code of ['SESSION_GROUP_INVALID', 'SESSION_GROUP_TOO_LONG', 'NAMESPACE_EXHAUSTED']) {
    f.dependencies.db = { ...f.store, insertConversation: () => { throw dataError(code, 'contract rejection'); } };
    await assert.rejects(receive(input, f.dependencies), { code, persisted: [] });
  }
  f.dependencies.db = { ...f.store, insertConversation: (...args) => { f.store.insertConversation(...args); throw new Error('after commit'); } };
  await assert.rejects(receive(input, f.dependencies), { code: 'INTERNAL_ERROR', persisted: null });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
});

test('IB-04 suppression conditional update is postcommit and retains terminal failed state', async t => {
  const f = setup(t); f.dependencies.queryRoute = async () => rejected;
  f.dependencies.reserveStatusNotice = () => ({ suppressed: true });
  const reply = await receive(input, f.dependencies);
  const row = f.db.prepare('SELECT * FROM conversations WHERE id=?').get(reply.id);
  assert.equal(reply.action, 'suppressed'); assert.equal(row.status, 'failed'); assert.equal(row.delivery_action, 'suppressed');
  assert.match(row.content, /Status notification suppressed by cooldown while health=unavailable reason=down\./);
  f.dependencies.db = { ...f.store, markStatusNoticeSuppressed: () => { throw new Error('busy'); } };
  const failed = await receive(input, f.dependencies);
  assert.equal(failed.action, 'suppressed'); assert.equal(f.db.prepare('SELECT delivery_action AS a FROM conversations WHERE id=?').get(failed.id).a, null);
});

test('IB-02 v2 correlation/branches reject malformed responses and fall back exactly once', async () => {
  const request = { type: 'route', requestId: '1-1', noReply: false };
  const response = { version: 2, type: 'route', requestId: '1-1', ...pending };
  assert.equal(validRouteResponse(response, request), true);
  for (const extra of [{ version: 1 }, { requestId: 'wrong' }, { decision: 'new' }, { recovered: false }, { auth: { result: 'failed', detail: 'bad' } }, { transitionHold: 'yes' }, { runtime: '' }, { decision: undefined }, { decision: 'auth_rejected', auth: { result: 'success' } }]) {
    let fallbacks = 0;
    const result = await queryRoute(request, { ipcRoute: async () => ({ ...response, ...extra }), fallbackFileRoute: () => { fallbacks++; return pending; } });
    assert.equal(result, pending); assert.equal(fallbacks, 1);
  }
});

test('IB-02 rejects unknown decisions and missing reply text on otherwise valid rejection responses', async () => {
  const request = { type: 'route', requestId: 'rejection', noReply: false };
  const response = { version: 2, type: 'route', requestId: request.requestId, ...rejected };
  const authResponse = { ...response, ...auth('unconfirmed') };
  for (const valid of [response, authResponse]) {
    assert.equal(validRouteResponse(valid, request), true);
    assert.equal(await queryRoute(request, { ipcRoute: async () => valid }), valid);
  }
  const invalid = [{ ...response, decision: 'new' }, { ...response, userMessage: undefined }, { ...authResponse, userMessage: undefined }];
  for (const response of invalid) {
    let fallbacks = 0;
    assert.equal(validRouteResponse(response, request), false);
    const result = await queryRoute(request, { ipcRoute: async () => response, fallbackFileRoute: () => { fallbacks++; return pending; } });
    assert.equal(result, pending); assert.equal(fallbacks, 1);
  }
});

test('IF-04 fallback six-level order, target runtime only, and Core external auth distinction', async () => {
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

test('DM-50 six tuple distinguishes groups/runtime/reason, supports missing health and delimiter-bearing endpoint', () => {
  const key = (group, runtime, health, reason, endpoint = 'room::x|msg:1') => statusNoticeKey('chat', endpoint, health, reason, group, runtime);
  assert.equal(new Set([key('chat:A', 'claude'), key('chat:B', 'claude'), key('chat:A', 'codex'), key('chat:A', 'claude', 'ok', 'other')]).size, 4);
  assert.deepEqual(JSON.parse(key('chat:A', 'codex').slice(3)), ['chat', 'room::x', 'chat:A', 'codex', 'unavailable', 'unavailable']);
  assert.deepEqual(JSON.parse(key('chat:A', 'codex', 'auth_failed').slice(3)).slice(-2), ['auth_failed', 'auth_failed']);
  assert.notEqual(key('chat:A', 'codex', 'ok', 'x::y', 'a'), key('chat:A', 'codex', 'ok', 'y', 'a::x'));
});

test('IF-06/DM-51 query current/rotated logs, ignores incomplete/bad lines, remains read only, refuses errors', async t => {
  const f = setup(t); f.dependencies.queryRoute = async () => auth('failed');
  const reply = await receive([...input, '--no-reply'], f.dependencies);
  const filename = path.join(path.dirname(f.filename), 'receive-events.jsonl');
  const event = { v: 1, event: 'auth_rejected', conversation_id: reply.id, reason_code: 'auth_check_failed', detail: 'evidence', runtime: 'codex', ts: 123 };
  fs.writeFileSync(filename, JSON.stringify(event) + '\n{bad}\nnull\n' + JSON.stringify({ ...event, detail: 'partial' }));
  const deps = { filename, diagnostic: () => {}, getConversationsByRange: (a, b) => f.db.prepare('SELECT * FROM conversations WHERE id BETWEEN ? AND ?').all(a, b) };
  const before = fs.readFileSync(filename);
  assert.equal(queryRejection(String(reply.id), deps).detail, 'evidence'); assert.deepEqual(fs.readFileSync(filename), before);
  fs.renameSync(filename, filename.replace('.jsonl', '.123.jsonl'));
  assert.equal(queryRejection(String(reply.id), deps).runtime, 'codex');
  assert.throws(() => queryRejection('999', deps), { code: 'NOT_FOUND' });
  const queued = f.store.insertConversation('in', 'chat', null, 'pending');
  assert.throws(() => queryRejection(String(queued.id), deps), { code: 'NOT_REJECTED' });
  assert.throws(() => queryRejection(String(reply.id), { ...deps, io: { readdirSync: fs.readdirSync, readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }), { code: 'INTERNAL_ERROR' });
  const empty = path.join(path.dirname(f.filename), 'missing', 'receive-events.jsonl');
  assert.equal(queryRejection(String(reply.id), { ...deps, filename: empty }).reason, 'expired_or_missing');
  assert.throws(() => queryRejection('9223372036854775807', { filename: empty,
    getConversationsByRange: () => assert.fail('unsafe id must not query a rounded neighbor') }), { code: 'NOT_FOUND' });
  assert.throws(() => queryRejection('9223372036854775808', { filename: empty,
    getConversationsByRange: () => assert.fail('unsafe id must not query a rounded neighbor') }), { code: 'NOT_FOUND' });
  fs.writeFileSync(filename, JSON.stringify({ ...event, runtime: 'future-runtime', detail: 'future evidence' }) + '\n');
  assert.equal(queryRejection(String(reply.id), deps).runtime, 'future-runtime');
  assert.equal(queryRejection(String(reply.id), deps).detail, 'future evidence');
});

test('F14 sanitizes bytes via frozen P04 append API and reports append failure', async () => {
  const events = []; const dependencies = { now: () => 123, createJsonlStream: () => ({ append: async row => events.push(row) }) };
  await appendEntryEvent({ event: 'auth_rejected', endpoint: 'r|req:1|msg:2|parent:3', detail: '\u0000' + 'x'.repeat(600) }, dependencies);
  assert.equal(events[0].ts, 123); assert.equal(events[0].endpoint, 'r'); assert.equal(events[0].detail.length, 500);
  assert.equal(await appendEntryEvent({ event: 'group_rejected' }, { diagnostic: () => {}, createJsonlStream: () => ({ append: async () => { throw new Error('denied'); } }) }), false);
});
