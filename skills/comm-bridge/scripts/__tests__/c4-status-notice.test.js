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

test('IB04 D4 six-tuple independent cooldown and exact 600 second boundary', async () => {
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

test('IB04 pre-spawn failures release their reservation; nonzero and signals retain it', async () => {
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

test('IB04 a failed old sender cannot clear a later reservation', async () => {
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

test('IB04 noReply and pending skip before render/reserve; DB and diagnostics do not invent success', async () => {
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

test('IB04 stdin exception after child started drains close before returning', async () => {
  const child = fakeChild(); let close;
  child.stdin.end = () => { throw Error('stdin unavailable'); };
  child.kill = () => { close = () => child.emit('close', null, 'SIGKILL'); return true; };
  let settled = false;
  const record = row(); const pending = sender({ spawn: () => child })(record, route).then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(typeof close, 'function');
  close(); assert.equal((await pending).outcome, 'uncertain'); assert.ok(reservation(record));
});

test('IB04 real child gets original argv and shared template stdin; whole and subgroup scopes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c4 receipt's ")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'capture.json'), script = path.join(dir, 'recorder.cjs');
  fs.writeFileSync(script, `let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>body+=x);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({argv:process.argv.slice(2),body})));`);
  const config = { language: 'en', brand: 'Test Brand', templates: { inbound: { unavailable: { zh: '自定义不可用。', en: 'Custom unavailable.' } } } };
  const send = sender({ spawn, script, render: rt => messageForStatus(rt, config) });
  for (const [channel, group, tail] of [['chat', 'chat:a:b', ['--session-group', 'a:b']], ['chat', 'chat', []], ['chat', null, []], ['internal', 'chat:a', []]]) {
    const record = row({ channel, session_group: group, endpoint_id: `it's $(literal) \`literal\` a"b\\c\n${sequence}` });
    assert.equal((await send(record, route)).outcome, 'sent');
    const captured = JSON.parse(fs.readFileSync(output));
    assert.deepEqual(captured.argv, [channel, record.endpoint_id, ...tail]);
    assert.equal(captured.body, messageForStatus(route, config));
  }
});

test('IB04 real timed-out sender is killed and classified uncertain, not retried', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-timeout-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'hang.cjs'); fs.writeFileSync(script, "process.stdin.resume();setInterval(()=>{},1000);");
  const record = row(), diagnostics = [];
  const result = await sender({ spawn, script, timeoutMs: 40, diagnostic: (...args) => diagnostics.push(args) })(record, route);
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.signal, 'SIGKILL'); assert.ok(reservation(record));
  assert.equal(diagnostics.length, 1); assert.equal((await sender()(record, route)).outcome, 'suppressed');
});

test('IB04 receipt assertions reject dropped group/runtime keys and nonzero-as-failed mutants', async () => {
  const moduleURL = new URL('../c4-status-notice.js', import.meta.url);
  const original = fs.readFileSync(moduleURL, 'utf8');
  async function mutant(before, after) {
    assert.ok(original.includes(before), 'mutation anchor exists');
    const source = original.replace(before, after)
      .replaceAll('import.meta.url', JSON.stringify(moduleURL.href))
      .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, moduleURL).href}'`);
    return (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).createStatusNoticeSender;
  }
  for (const [before, after, changed] of [
    ['record.session_group ?? null,', 'null,', { session_group: 'chat:other' }],
    ["route.runtime || 'unknown', health", "'unknown', health", { runtime: 'codex' }],
  ]) {
    const create = await mutant(before, after), record = row();
    const send = create({ db, render: () => 'notice', spawn: () => fakeChild(), diagnostic: () => {} });
    assert.equal((await send(record, route)).outcome, 'sent');
    const result = await send(changed.session_group ? { ...record, ...changed } : record, changed.runtime ? { ...route, ...changed } : route);
    assert.throws(() => assert.equal(result.outcome, 'sent'), { code: 'ERR_ASSERTION' });
    assert.equal(result.outcome, 'suppressed');
  }
  const create = await mutant("exitCode === 0 ? 'sent' : 'uncertain'", "exitCode === 0 ? 'sent' : 'failed'");
  const record = row(), send = create({ db, render: () => 'notice', spawn: () => fakeChild(1), diagnostic: () => {} });
  const result = await send(record, route);
  assert.throws(() => assert.equal(result.outcome, 'uncertain'), { code: 'ERR_ASSERTION' });
  assert.equal(reservation(record), undefined);
});
