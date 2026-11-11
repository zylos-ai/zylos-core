import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const db = await import('../c4-db.js');
const { createStatusNoticeSender, statusNoticeKey } = await import('../c4-status-notice.js');
const { messageForStatus } = await import('../status-notice-templates.js');
after(() => { db.close(); environment.cleanup(); });
let sequence = 0;
function row(extra = {}) { return { id: ++sequence, channel: 'chat', endpoint_id: `receipt-${sequence}`, session_group: 'chat:a', ...extra }; }
const route = { runtime: 'claude', health: 'unavailable', reason: 'pending_expired', noticeKind: 'pending_expired' };
function fakeChild(exitCode = 0, signal = null) {
  const child = new EventEmitter(); child.pid = 42;
  child.stdin = new EventEmitter();
  child.stdin.end = () => queueMicrotask(() => child.emit('close', exitCode, signal));
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
  return child;
}
function sender(options = {}) { return createStatusNoticeSender({ db, render: () => 'receipt', diagnostic: () => {}, log: () => {}, spawn: () => fakeChild(), ...options }); }
function reservation(record, routing = route) { return db.getStatusNoticeCooldowns().find(item => item.cooldown_key === statusNoticeKey(record, routing)); }

test('six-tuple independent cooldown and exact 600 second boundary', async () => {
  let now = 1800000000, calls = 0;
  const send = sender({ now: () => now, spawn: () => { calls++; return fakeChild(); } });
  const record = row({ endpoint_id: 'tuple|msg:1|type:group|req:2|parent:3' });
  assert.equal((await send(record, route)).outcome, 'sent');
  assert.equal((await send({ ...record, endpoint_id: 'tuple|type:group|msg:99' }, route)).outcome, 'suppressed');
  for (const [r, rt] of [
    [{ ...record, channel: 'other' }, route], [{ ...record, endpoint_id: 'different' }, route],
    [{ ...record, session_group: 'chat:b' }, route], [record, { ...route, runtime: 'codex' }],
    [record, { ...route, health: 'auth_failed' }], [record, { ...route, reason: 'auth_failed' }],
  ]) assert.equal((await send(r, rt)).outcome, 'sent');
  assert.equal(calls, 7);
  now += 599; assert.equal((await send(record, route)).outcome, 'suppressed');
  now++; assert.equal((await send(record, route)).outcome, 'sent');
  assert.equal(calls, 8);
  // Notice kind is diagnostic only: it cannot create another resend authority.
  assert.equal((await send(record, { ...route, noticeKind: 'failure' })).outcome, 'suppressed');
});

test('pre-spawn failures release their reservation; nonzero and signals retain it', async () => {
  for (const spawnFailure of [() => { throw Error('cannot spawn'); }, () => spawn('/missing-c4-test-executable', [])]) {
    const record = row(); const result = await sender({ spawn: spawnFailure })(record, route);
    assert.equal(result.outcome, 'failed'); assert.equal(result.code, 'UNHEALTHY_NOTIFY_FAILED');
    assert.equal(reservation(record), undefined);
    assert.equal((await sender()(record, route)).outcome, 'sent');
  }
  for (const [code, signal] of [[1, null], [null, 'SIGTERM']]) {
    const record = row(); const result = await sender({ spawn: () => fakeChild(code, signal) })(record, route);
    assert.equal(result.outcome, 'uncertain'); assert.equal(result.code, 'UNHEALTHY_NOTIFY_UNCERTAIN');
    assert.ok(reservation(record)); assert.equal((await sender()(record, route)).outcome, 'suppressed');
  }
});

test('a failed old sender cannot clear a later reservation', async () => {
  const record = row(); let clock = 1800010000;
  const send = sender({ now: () => clock, spawn: () => {
    clock += 600;
    db.reserveStatusNoticeCooldown({ cooldownKey: statusNoticeKey(record, route), channel: record.channel,
      endpoint: record.endpoint_id, statusType: route.health, reason: route.reason, ttl: 600, now: clock });
    throw Error('old spawn failed');
  } });
  assert.equal((await send(record, route)).outcome, 'failed');
  assert.equal(reservation(record).last_notified_at, clock);
});

test('noReply and pending skip before render/reserve; DB and diagnostics do not invent success', async () => {
  const unexpected = () => { throw Error('must not call'); };
  const send = sender({ render: unexpected, db: { reserveStatusNoticeCooldown: unexpected } });
  assert.equal((await send(row({ endpoint_id: null }), route)).outcome, 'skipped');
  assert.equal((await send(row(), { ...route, decision: 'pending' })).outcome, 'skipped');
  let spawned = false;
  assert.equal((await sender({ db: { reserveStatusNoticeCooldown: () => { throw Error('busy'); } },
    spawn: () => { spawned = true; } })(row(), route)).outcome, 'failed');
  assert.equal(spawned, false);
  assert.equal((await sender({ diagnostic: () => { throw Error('log full'); } })(row(), route)).outcome, 'sent');
  const record = row();
  assert.equal((await sender({ db: { ...db, clearStatusNoticeCooldownReservation: () => { throw Error('busy'); } },
    spawn: () => { throw Error('spawn failed'); } })(record, route)).outcome, 'failed');
  assert.ok(reservation(record));
});

test('stdin exception after child started drains close before returning', async () => {
  const child = fakeChild(); let close;
  child.stdin.end = () => { throw Error('stdin unavailable'); };
  child.kill = () => { close = () => child.emit('close', null, 'SIGKILL'); return true; };
  let settled = false;
  const record = row(); const pending = sender({ spawn: () => child })(record, route).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(typeof close, 'function');
  close(); assert.equal((await pending).outcome, 'uncertain'); assert.ok(reservation(record));
});

test('real child gets original argv and shared template stdin without inherited session identity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c4 receipt's ")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'capture.json'), script = path.join(dir, 'recorder.cjs');
  fs.writeFileSync(script, `let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>body+=x);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({argv:process.argv.slice(2),body,runId:process.env.ZYLOS_RUN_ID,sessionGroup:process.env.ZYLOS_SESSION_GROUP,systemSend:process.env.ZYLOS_SYSTEM_SEND})));`);
  const previous = { ZYLOS_RUN_ID: process.env.ZYLOS_RUN_ID, ZYLOS_SESSION_GROUP: process.env.ZYLOS_SESSION_GROUP };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.ZYLOS_RUN_ID = 'stale-system-run';
  process.env.ZYLOS_SESSION_GROUP = 'chat:unrelated';
  const config = { language: 'en', brand: 'Test Brand', templates: { inbound: { unavailable: { zh: '自定义不可用。', en: 'Custom unavailable.' } } } };
  const send = sender({ spawn, script, render: rt => messageForStatus(rt, config) });
  for (const [channel, group] of [['chat', 'chat:a:b'], ['chat', 'chat'], ['chat', null], ['internal', 'chat:a']]) {
    const record = row({ channel, session_group: group, endpoint_id: `it's $(literal) \`literal\` a"b\\c\n${sequence}` });
    assert.equal((await send(record, route)).outcome, 'sent');
    const captured = JSON.parse(fs.readFileSync(output));
    assert.deepEqual(captured.argv, [channel, record.endpoint_id]);
    assert.equal(captured.body, messageForStatus(route, config));
    assert.equal(captured.runId, undefined);
    assert.equal(captured.sessionGroup, undefined);
    assert.equal(captured.systemSend, '1');
  }
});

test('real timed-out sender is killed and classified uncertain, not retried', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-timeout-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'hang.cjs'); fs.writeFileSync(script, "process.stdin.resume();setInterval(()=>{},1000);");
  const record = row(), diagnostics = [];
  const result = await sender({ spawn, script, timeoutMs: 40, diagnostic: (...args) => diagnostics.push(args) })(record, route);
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.signal, 'SIGKILL'); assert.ok(reservation(record));
  assert.equal(diagnostics.length, 1); assert.equal((await sender()(record, route)).outcome, 'suppressed');
});

test('capacity wait sends the shared receipt to the original channel and endpoint with cooldown', async () => {
  const record = row({ direction: 'in', channel: 'telegram', endpoint_id: 'original-room', session_group: 'telegram:original' });
  const routing = { decision: 'capacity_wait', context: 'capacity', noticeCode: 'capacity_wait',
    health: 'capacity_wait', reason: 'capacity_wait', runtime: 'codex', waitStartedAtMs: 1800000000123 };
  const calls = [];
  const send = sender({ render: input => messageForStatus(input, {}), spawn: (exe, argv) => {
    const child = fakeChild();
    child.stdin.end = message => { calls.push({ exe, argv, message }); queueMicrotask(() => child.emit('close', 0, null)); };
    return child;
  } });
  assert.equal((await send(record, routing)).outcome, 'sent');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(1), ['telegram', 'original-room']);
  assert.equal(calls[0].message, messageForStatus(routing, {}));
  assert.match(calls[0].message, /消息已收到。目前同时处理的对话较多，正在排队/);
  assert.equal((await send({ ...record, id: record.id + 1 }, routing)).outcome, 'suppressed');
  assert.equal(calls.length, 1);
  assert.equal((await send(record, { ...routing, waitStartedAtMs: routing.waitStartedAtMs + 10001 })).outcome, 'sent');
  assert.equal(calls.length, 2, 'a distinct wait episode can send inside the existing 600-second cooldown');
});

test('capacity wait skips internal, system, outbound, no-reply and admission-pending records', async () => {
  const unexpected = () => { throw Error('must not render, reserve or spawn'); };
  const send = sender({ render: unexpected, db: { reserveStatusNoticeCooldown: unexpected }, spawn: unexpected });
  const routing = { decision: 'capacity_wait', context: 'capacity', noticeCode: 'capacity_wait',
    health: 'capacity_wait', reason: 'capacity_wait', runtime: 'claude' };
  for (const change of [{ channel: 'internal' }, { channel: 'system' }, { direction: 'out' },
    { direction: undefined }, { endpoint_id: null }]) {
    assert.equal((await send(row({ direction: 'in', ...change }), routing)).outcome, 'skipped');
  }
  assert.equal((await send(row({ direction: 'in' }), { ...routing, decision: 'pending' })).outcome, 'skipped');
});
