import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createContinuationRestarts } from '../router/continuation.js';
import { messageForStatus } from '../status-notice-templates.js';
import { routerFixture as baseFixture } from './helpers/router-fixture.js';

function routerFixture(t, options) {
  const paths = Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR'].map(key => [key, process.env[key]]));
  const realHome = os.userInfo().homedir;
  for (const value of Object.values(paths)) assert.ok(value && value !== realHome && !value.startsWith(realHome + '/'));
  assert.ok(paths.ZYLOS_DIR.startsWith(paths.HOME + '/'));
  assert.ok(paths.PM2_HOME.startsWith(paths.HOME + '/'));
  const f = baseFixture(t, options);
  assert.equal(f.filename, ':memory:');
  t.diagnostic(JSON.stringify({ paths, database: f.filename, externalIO: 'injected' }));
  return f;
}

test('restart failures share one machine window and exclude recovered groups', () => {
  let clock = 0;
  const alerts = [], diagnostics = [];
  const restarts = createContinuationRestarts({ now: () => clock,
    deps: { alert: (event, fields) => alerts.push({ event, ...fields }) },
    diagnostic: (event, fields) => diagnostics.push({ event, ...fields }) });
  const fail = (group, reason = { kind: 'launch_error', code: 'REFUSED' }) => restarts.failed(group, 'run', reason);
  for (const group of ['a', 'b', 'c']) for (let i = 0; i < 5; i++) fail(group);
  for (let i = 0; i < 4; i++) fail('below-threshold');
  assert.equal(alerts.length, 1); assert.equal(alerts[0].others, 0);
  clock = 1799000; fail('b'); assert.equal(alerts.length, 1);
  restarts.ready('a'); clock = 1800000;
  fail('c', { kind: 'timeout', seconds: 17 });
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts[1], { event: 'continuation_start_failed', sessionGroup: 'c', runId: 'run', failures: 6,
    reason: { kind: 'timeout', seconds: 17 }, others: 1 });
  assert.deepEqual(diagnostics[1].reason, alerts[1].reason);
  clock += 1800000; fail('a'); assert.equal(alerts.length, 2);
});

test('ready without history does not create restart pacing state and observation does not clear failures', () => {
  let clock = 0; const alerts = [];
  const restarts = createContinuationRestarts({ now: () => clock, deps: { alert: (...args) => alerts.push(args) }, diagnostic() {} });
  restarts.ready('unknown'); restarts.observe('unknown', { present: false }); clock = 5000;
  assert.equal(restarts.canStart('unknown'), false);
  for (let i = 0; i < 4; i++) restarts.failed('a', 'run');
  restarts.observe('a', { present: true, ready: true, runId: 'ready' });
  restarts.failed('a', 'run'); assert.equal(alerts.length, 1);
});

test('restart notice defaults exactly match bilingual contract and append other groups', () => {
  const message = messageForStatus({ context: 'repeated_failure', noticeCode: 'could_not_restart', group: 'a', count: 5,
    reason: { kind: 'launch_error', code: 'DENIED', message: 'private error' }, others: 2 }, {});
  assert.equal(message, '[Zylos] 对话「a」连续 5 次没能重启。最后一次的原因：启动报错（DENIED）。系统会继续重试；已在排队的消息可能在恢复前失败。另有 2 个对话也重启失败。\n' +
    '[Zylos] Conversation "a" could not restart: 5 attempts failed in a row. Last failure: launch error (DENIED). It keeps retrying. Messages already queued for this conversation can fail before it recovers. 2 other conversations are failing too.');
  assert.equal(message.includes('private error'), false);
});

test('all repeated failure template IDs accept overrides and invalid values fall back', () => {
  const templates = {
    could_not_restart: { zh: '{group}/{count}/{reason}', en: '{group}/{count}/{reason}' },
    could_not_restart_others: { zh: '其他{others}', en: 'others{others}' },
    could_not_restart_launch_error: { zh: '错误{code}', en: 'error{code}' },
    could_not_restart_timeout: { zh: '等待{seconds}', en: 'wait{seconds}' },
    ended_unexpectedly: { zh: '结束{group}/{count}', en: 'ended{group}/{count}' },
  };
  const config = { brand: 'Acme', templates: { repeated_failure: templates } };
  const input = { context: 'repeated_failure', noticeCode: 'could_not_restart', group: 'g', count: 5, others: 1 };
  assert.equal(messageForStatus({ ...input, reason: { kind: 'timeout', seconds: 12 } }, config), '[Acme] g/5/等待12其他1\n[Acme] g/5/wait12 others1');
  assert.equal(messageForStatus(input, config), '[Acme] g/5/错误unknown其他1\n[Acme] g/5/errorunknown others1');
  assert.equal(messageForStatus({ ...input, noticeCode: 'ended_unexpectedly' }, config), '[Acme] 结束g/5\n[Acme] endedg/5');
  for (const invalid of ['', ' '.repeat(4), 'x'.repeat(2001), '\u0000bad']) {
    const fallback = { templates: { repeated_failure: { could_not_restart: { zh: invalid, en: invalid } } } };
    assert.equal(messageForStatus(input, fallback), messageForStatus(input, {}));
  }
});

// Integration boundary: actual scheduler/activation with a real private in-memory
// SQLite store and injected clock/runtime. Run for failure reasons or readiness
// reset changes; skip unrelated UI. Official runner isolates five environment
// paths; no tmux/PM2/network. Fixture stops Router and closes its DB after each case.
test('inbound readiness clears continuation failures and launch diagnostics contain only error codes', async t => {
  const f = routerFixture(t); f.put('origin');
  const row = f.add('a'); f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
  f.db.recordRunEnd('a', { runId: 'old', reason: 'unexpected' });
  const adapter = f.deps.getSessionAdapter;
  let attempts = 0;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async () => { attempts++; throw Object.assign(Error('private error'), { code: 'REFUSED' }); } });
  await f.create().initialize(); await f.rounds(2);
  for (const delay of [5000,10000,20000,40000,60000]) { f.advance(delay); await f.rounds(4); }
  const alerts = () => f.calls.filter(row => row[0] === 'alert');
  assert.equal(alerts().length, 1);
  assert.equal(attempts, 5);
  assert.deepEqual(alerts()[0][2].reason, { kind: 'launch_error', code: 'REFUSED' });
  assert.deepEqual(f.events.find(e => e.event === 'continuation_start_failed').reason, { kind: 'launch_error', code: 'REFUSED' });
  f.deps.getSessionAdapter = adapter; f.add('a'); await f.rounds(6);
  assert.equal(f.router.state.activations.size, 0);
  const runId = f.scene.get('a').runId;
  f.scene.delete('a'); await f.rounds(2); f.db.recordRunEnd('a', { runId, reason: 'unexpected' });
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async () => { attempts++; throw Error('no code'); } });
  f.advance(1800000); await f.rounds(4);
  assert.equal(attempts, 6, 'post-recovery continuation actually failed once');
  assert.equal(alerts().length, 1);
  for (let i = 0; i < 4; i++) { f.advance(60000); await f.rounds(4); }
  assert.equal(attempts, 10); assert.equal(alerts().length, 2);
  const fields = alerts()[1][2];
  assert.deepEqual(fields.reason, { kind: 'launch_error', code: 'unknown' });
  const message = messageForStatus({ context: 'repeated_failure', noticeCode: 'could_not_restart', group: fields.sessionGroup,
    count: fields.failures, reason: fields.reason, others: fields.others }, {});
  assert.ok(message.includes('launch error (unknown)'));
  assert.equal(message.includes('no code'), false); assert.equal(message.includes('private error'), false);
});

// Integration boundary: scheduler computes actual timeout seconds, while runs
// that became ready never increment its failure counter. Same private SQLite,
// injected clock/runtime and fixture cleanup as above; no external services.
// Run for activation timeout calculation/settlement changes; skip unrelated UI.
test('five readiness timeouts report floored elapsed seconds', async t => {
  const f = routerFixture(t, { readyTimeoutMs: 1000 }); f.put('origin');
  const row = f.add('a'); f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
  const id = f.db.recordRunEnd('a', { runId: 'old', reason: 'unexpected' }).continuationControlId;
  const adapter = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    f.put('a', { runId: input.runId, ready: false });
  } });
  await f.create().initialize(); await f.rounds(2);
  for (const delay of [5000,10000,20000,40000,60000]) {
    f.advance(delay); await f.rounds(3); f.advance(2500); await f.rounds(3);
  }
  const alerts = f.calls.filter(row => row[0] === 'alert');
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0][2].reason, { kind: 'timeout', seconds: 2 });
  assert.equal(f.db.getControlById(id).status, 'pending');
});

// Integration boundary: actual continuation NAME_CONFLICT settlement/counter.
// Run for conflict handling or failure classification; skip unrelated UI. Private
// SQLite/clock/runtime, no external services, Router and DB cleaned by fixture.
test('continuation name conflicts count as failures with their structured code', async t => {
  const f = routerFixture(t); f.put('origin');
  const row = f.add('a'); f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
  const id = f.db.recordRunEnd('a', { runId: 'old', reason: 'unexpected' }).continuationControlId;
  let attempts = 0;
  f.deps.getSessionAdapter = () => ({ launch: async () => { attempts++; throw Object.assign(Error('private conflict'), { code: 'NAME_CONFLICT' }); } });
  await f.create().initialize(); await f.rounds(2);
  for (const delay of [5000,10000,20000,40000,60000]) { f.advance(delay); await f.rounds(4); }
  assert.equal(attempts, 5);
  const alerts = f.calls.filter(row => row[0] === 'alert');
  assert.equal(alerts.length, 1); assert.equal(alerts[0][2].failures, 5);
  assert.deepEqual(alerts[0][2].reason, { kind: 'launch_error', code: 'NAME_CONFLICT' });
  assert.equal(f.db.getControlById(id).status, 'pending');
});

// Integration boundary: ready/exit loop through the actual scheduler, private
// SQLite and clock; run for activation-ready counter changes, skip unrelated UI.
test('ready runs that immediately exit never emit Router failure alerts', async t => {
  const f = routerFixture(t); f.put('origin');
  const row = f.add('a'); f.sqlite.prepare("UPDATE conversations SET status='delivered' WHERE id=?").run(row.id);
  f.db.recordRunEnd('a', { runId: 'old', reason: 'unexpected' });
  await f.create().initialize(); await f.rounds(2);
  for (const delay of [5000,10000,20000,40000,60000,60000]) {
    f.advance(delay); await f.rounds(5);
    const runId = f.scene.get('a').runId;
    f.scene.delete('a'); await f.rounds(2);
    f.db.recordRunEnd('a', { runId, reason: 'unexpected' }); await f.rounds(2);
  }
  assert.equal(f.calls.filter(row => row[0] === 'launch').length, 6);
  assert.equal(f.calls.filter(row => row[0] === 'alert').length, 0);
});

// Integration boundary: failure release preserves the original held deadline;
// expiry yields to inbound at the exact boundary. Private SQLite/clock/runtime,
// no tmux/PM2/network; run for continuation failure settlement, skip other UI.
test('failed starts restore held state until exact expiry and then yield to inbound', async t => {
  const f = routerFixture(t, { poolSize: 1 }); f.put('origin');
  f.add('a'); f.sqlite.prepare("UPDATE conversations SET status='delivered'").run();
  f.db.takeSlot('a', { runId: 'old', k: 1 });
  f.db.recordRunEnd('a', { runId: 'old', reason: 'unexpected' });
  const held = f.db.listSlotOccupancy()[0];
  const adapter = f.deps.getSessionAdapter;
  f.deps.getSessionAdapter = runtime => ({ ...adapter(runtime), launch: async input => {
    f.calls.push(['launch', input]);
    if (input.sessionGroup === 'a') throw Error('rejected');
    f.put(input.sessionGroup, { runId: input.runId });
  } });
  await f.create().initialize(); await f.rounds(2);
  for (const delay of [5000,10000,20000,40000]) {
    f.advance(delay); await f.rounds(4);
    assert.equal(f.db.listSlotOccupancy().length, 1);
    assert.deepEqual(f.db.listSlotOccupancy()[0], held);
  }
  const inbound = f.add('c'); f.advance(44999); await f.rounds(4);
  assert.equal(f.db.listSlotOccupancy()[0].state, 'held');
  assert.equal(f.row(inbound.id).status, 'pending');
  f.advance(1); await f.rounds(6);
  assert.equal(f.db.listSlotOccupancy().some(row => row.sessionGroup === 'a'), false);
  assert.equal(f.row(inbound.id).status, 'delivered');
  assert.equal(f.calls.filter(row => row[0] === 'launch').at(-1)[1].sessionGroup, 'c');
  assert.equal(f.db.listPendingContinuations().some(row => row.sessionGroup === 'a'), true);
});
