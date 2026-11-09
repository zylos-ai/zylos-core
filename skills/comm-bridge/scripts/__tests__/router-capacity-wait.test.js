import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapacityWaits } from '../router/capacity-wait.js';
import { routerFixture } from './helpers/router-fixture.js';

function fixture() {
  let clock = 1800000000123, health = { health: 'ok' };
  const events = [], sent = [], tasks = [];
  const state = { sceneObservable: true, mode: 'multi', slots: new Map([['busy', {}]]) };
  const deps = { db: { resolveSessionLaunchConfig: () => ({ runtime: 'codex' }) },
    readRuntimeHealth: () => health, sendStatusNotice: async (row, route) => { sent.push({ row, route }); return { outcome: 'sent' }; } };
  const manager = createCapacityWaits({ deps, state, options: { poolSize: () => 1 },
    now: () => clock, diagnostic: (event, fields) => events.push({ event, ...fields }), track: task => tasks.push(task) });
  const row = { id: 1, direction: 'in', channel: 'telegram', endpoint_id: 'user-window', session_group: 'chat:one' };
  return { manager, deps, state, row, events, sent, advance: ms => { clock += ms; },
    setHealth: value => { health = value; }, settle: () => Promise.all(tasks) };
}

test('capacity granted within ten seconds records the same wait clock without a receipt', async () => {
  const f = fixture(); f.manager.wait('chat:one', f.row); f.advance(9999);
  f.manager.wait('chat:one', f.row); f.manager.acquired('chat:one'); await f.settle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.events.length, 2);
  const [started, acquired] = f.events;
  assert.equal(started.event, 'wait_capacity'); assert.equal(started.occupied_slots, 1); assert.equal(started.pool_limit, 1);
  assert.equal(acquired.event, 'capacity_wait_acquired'); assert.equal(acquired.wait_ms, 9999);
  assert.equal(acquired.wait_started_at_ms, started.wait_started_at_ms);
});

test('capacity wait sends once strictly after ten seconds across multiple pending messages', async () => {
  const f = fixture(); f.manager.wait('chat:one', f.row); f.advance(10000); f.manager.wait('chat:one', f.row);
  await f.settle(); assert.equal(f.sent.length, 0);
  f.advance(1); f.manager.wait('chat:one', f.row);
  f.manager.wait('chat:one', { ...f.row, id: 2, endpoint_id: 'second-message' }); await f.settle();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].row.endpoint_id, 'user-window');
  assert.equal(f.sent[0].row.channel, 'telegram'); assert.equal(f.sent[0].route.decision, 'capacity_wait');
  assert.equal(f.sent[0].route.runtime, 'codex'); assert.equal(f.sent[0].route.noticeCode, 'capacity_wait');
  const notice = f.events.find(event => event.event === 'capacity_wait_notice');
  assert.equal(notice.wait_started_at_ms, f.events[0].wait_started_at_ms); assert.equal(notice.wait_ms, 10001);
});

test('a later capacity episode starts a new timer and can request one new receipt', async () => {
  const f = fixture(); f.manager.wait('chat:one', f.row); f.advance(10001); f.manager.wait('chat:one', f.row); await f.settle();
  f.manager.acquired('chat:one'); f.advance(5000); f.manager.wait('chat:one', f.row);
  f.advance(10000); f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 1);
  f.advance(1); f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 2);
  const starts = f.events.filter(event => event.event === 'wait_capacity');
  assert.equal(starts.length, 2); assert.equal(starts[1].wait_started_at_ms - starts[0].wait_started_at_ms, 15001);
});

for (const row of [ { channel: 'internal' }, { channel: 'system' }, { channel: 'void' },
  { endpoint_id: null }, { direction: 'out' } ]) {
  test(`capacity wait excludes ${JSON.stringify(row)} from user receipts`, async () => {
    const f = fixture(); const record = { ...f.row, ...row };
    f.manager.wait('chat:one', record); f.advance(20000); f.manager.wait('chat:one', record); await f.settle();
    assert.equal(f.sent.length, 0);
  });
}

test('health restrictions and unreadable health do not start or continue capacity notice clocks', async () => {
  for (const health of ['auth_failed', 'rate_limited', 'unavailable', 'down', 'recovering']) {
    const f = fixture(); f.setHealth({ health }); f.manager.wait('chat:one', f.row); f.advance(20000);
    f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 0); assert.equal(f.events.length, 0);
  }
  const f = fixture(); f.manager.wait('chat:one', f.row); f.advance(9000);
  f.setHealth({ unreadable: true }); f.manager.wait('chat:one', f.row); f.advance(20000);
  f.setHealth({ health: 'ok' }); f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 0);
  f.advance(10001); f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 1);
});

test('unobservable scenes, free capacity and resident groups cannot start capacity waits', () => {
  const f = fixture(); f.state.sceneObservable = false; f.manager.wait('chat:one', f.row);
  f.state.sceneObservable = true; f.state.slots.clear(); f.manager.wait('chat:one', f.row);
  f.state.slots.set('busy', {}); f.manager.wait(null, f.row); f.manager.wait('origin', f.row);
  assert.equal(f.events.length, 0);
});

test('departed groups and router stop discard waiting state', async () => {
  const f = fixture(); f.manager.wait('chat:one', f.row); f.advance(20000); f.manager.sweep(new Set());
  f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 0);
  f.advance(20000); f.manager.stop(); f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 0);
});

test('a new user message does not inherit a rowless continuation receipt clock', async () => {
  const f = fixture(); f.manager.wait('chat:one'); f.advance(30000);
  f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 0);
  f.advance(10001); f.manager.wait('chat:one', f.row); await f.settle(); assert.equal(f.sent.length, 1);
  assert.equal(f.events.filter(event => event.event === 'wait_capacity').length, 2);
});

for (const finish of ['acquired', 'clear', 'stop', 'health']) {
  test(`a deferred capacity receipt is cancelled when ${finish} ends eligibility`, async () => {
    const f = fixture(); f.manager.wait('chat:one', f.row); f.advance(10001); f.manager.wait('chat:one', f.row);
    if (finish === 'health') f.setHealth({ health: 'auth_failed' });
    else f.manager[finish]('chat:one');
    await f.settle(); assert.equal(f.sent.length, 0);
  });
}

test('real Router capacity gate uses the shared timer and ends it at slot acquisition', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin'); f.put('busy'); const row = f.add('waiting');
  const sent = []; f.deps.sendStatusNotice = async (record, route) => { sent.push({ record, route }); return { outcome: 'sent' }; };
  await f.create().initialize(); await f.rounds(3);
  const start = f.events.find(event => event.event === 'wait_capacity'); assert.ok(start);
  f.advance(10001); await f.rounds(3); assert.equal(sent.length, 1); assert.equal(sent[0].record.id, row.id);
  f.scene.delete('busy'); f.db.recordRunEnd('busy', { runId: 'run-busy', reason: 'ttl' });
  await f.rounds(5);
  assert.equal(f.row(row.id).status, 'delivered');
  const granted = f.events.find(event => event.event === 'capacity_wait_acquired'); assert.ok(granted);
  assert.equal(granted.wait_started_at_ms, start.wait_started_at_ms); assert.equal(granted.wait_ms, 10001);
});
