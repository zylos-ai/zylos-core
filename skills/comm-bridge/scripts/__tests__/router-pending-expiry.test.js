import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';
const environment = createTestEnvironment();
const cooldownDb = await import('../c4-db.js');
const { fixture } = await import('./c4-v2-test-helpers.js');
const { routerFixture } = await import('./helpers/router-fixture.js');
const { createPendingExpiryHandler } = await import('../router/expiry.js');
const { createStatusNoticeSender } = await import('../c4-status-notice.js');
const { messageForStatus } = await import('../status-notice-templates.js');
const NOW = 1800000000;
after(() => { cooldownDb.close(); environment.cleanup(); });
let seq = 0;
function child(code = 0) {
  const result = new EventEmitter(); result.pid = 99; result.stdin = new EventEmitter();
  result.stdin.end = () => queueMicrotask(() => result.emit('close', code, null));
  result.kill = () => result.emit('close', null, 'SIGKILL'); return result;
}
const getRow = (db, id) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
function expired(f, { channel = 'chat', endpoint = `expiry-${++seq}`, content = 'old message', options } = {}) {
  const r = f.store.insertConversation('in', channel, endpoint, content, options);
  f.db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(NOW - 1801, r.id);
  const original = getRow(f.db, r.id);
  assert.equal(f.store.expirePending(r.id, 1800), true);
  return original;
}
function sender(extra = {}) {
  return createStatusNoticeSender({ db: cooldownDb, now: () => NOW, spawn: () => child(),
    render: () => 'notice', diagnostic: () => {}, log: () => {}, ...extra });
}

test('IF70 runtime resolution and public health: single/multi, scene/config/unknown, after real expiry', async t => {
  const f = fixture(t, { now: () => NOW * 1000 });
  for (const mode of ['single', 'multi']) for (const runtime of ['claude', 'codex']) {
    for (const [healthRecord, expected] of [[{ missing: true }, 'ok'], [{ unreadable: true }, 'unavailable'],
      [{ health: 'down', publicHealth: 'unavailable' }, 'unavailable'], [{ health: 'rate_limited', publicHealth: 'rate_limited' }, 'rate_limited']]) {
      for (const present of [false, true]) {
        const original = expired(f), calls = [], before = getRow(f.db, original.id);
        const health = new Proxy(healthRecord, { get(target, key) { assert.ok(['missing', 'unreadable', 'health', 'publicHealth'].includes(key)); return target[key]; } });
        const handler = createPendingExpiryHandler({ isComponent: () => true,
          resolveSessionLaunchConfig: input => { calls.push(['resolve', input]); return { runtime }; },
          readRuntimeHealth: name => { assert.deepEqual(getRow(f.db, original.id), before); calls.push(['health', name]); return health; },
          sendStatusNotice: async (record, route) => { calls.push(['notice', record, route]); return { outcome: 'sent' }; } });
        await handler(original, { sessionMode: mode, identity: { present, runtime } });
        assert.equal(calls.filter(c => c[0] === 'resolve').length, present ? 0 : 1);
        if (!present) assert.deepEqual(calls[0][1], { sessionGroup: mode === 'single' ? null : original.session_group, sessionMode: mode });
        assert.deepEqual(calls.find(c => c[0] === 'health'), ['health', runtime]);
        const notice = calls.find(c => c[0] === 'notice'); assert.strictEqual(notice[1], original);
        assert.deepEqual(notice[2], { runtime, health: expected, reason: 'pending_expired', noticeKind: 'pending_expired' });
        assert.deepEqual(getRow(f.db, original.id), before);
      }
    }
  }
  const original = expired(f);
  for (const identity of [undefined, { present: true, runtime: 'unknown' }, { present: false }]) {
    let route;
    const handler = createPendingExpiryHandler({ isComponent: () => true,
      resolveSessionLaunchConfig: () => { throw Error('config unreadable'); }, readRuntimeHealth: () => assert.fail('unknown runtime must not read baseline health'),
      sendStatusNotice: async (_, rt) => { route = rt; } });
    await handler(original, { sessionMode: 'multi', identity });
    assert.equal(route.runtime, 'unknown'); assert.equal(route.health, 'unavailable');
  }
});

test('IF70 late expiry reuses exact launch resolution; live runtime still takes precedence', async t => {
  const f = fixture(t, { now: () => NOW * 1000 }), original = expired(f), runtimes = [];
  const frozen = { runtime: 'codex', mode: 'override', model: 'saved-model' };
  const handler = createPendingExpiryHandler({ isComponent: () => true,
    resolveSessionLaunchConfig: () => assert.fail('must not resolve a second time'),
    readRuntimeHealth: runtime => { runtimes.push(runtime); return { missing: true }; }, sendStatusNotice: sender() });
  await handler(original, { sessionMode: 'multi', identity: { present: false }, launchConfig: frozen });
  await handler(original, { sessionMode: 'multi', identity: { present: true, runtime: 'claude' }, launchConfig: frozen });
  assert.deepEqual(runtimes, ['codex', 'claude']);
});

test('IF70 eligibility uses D1 route only: noReply/system/void/internal skip; scheduler-shaped row sends', async t => {
  const f = fixture(t, { now: () => NOW * 1000 }); let sent = 0;
  const handler = createPendingExpiryHandler({ isComponent: channel => channel === 'chat',
    resolveSessionLaunchConfig: () => ({ runtime: 'claude' }), readRuntimeHealth: () => ({ missing: true }),
    sendStatusNotice: async () => { sent++; return { outcome: 'sent' }; } });
  for (const record of [expired(f, { endpoint: null }), { channel: 'system', endpoint_id: 'a' },
    { channel: 'void', endpoint_id: 'a' }, { channel: 'internal', endpoint_id: 'chat:a' }, { channel: 'missing-component', endpoint_id: 'a' }]) {
    assert.equal((await handler(record, { identity: { present: false }, sessionMode: 'multi' })).outcome, 'skipped');
  }
  const record = expired(f, { content: '[Scheduled task: scheduler] expired reminder' });
  assert.equal((await handler(record, { identity: { present: false }, sessionMode: 'multi' })).outcome, 'sent');
  assert.equal(sent, 1);
});

test('IF70 real D1 and D4 retain pending_expired across sent/suppressed/failed/uncertain and shared template', async t => {
  const f = fixture(t, { now: () => NOW * 1000 });
  const config = { language: 'en', brand: 'Expiry Test', templates: { inbound: { unavailable: { zh: '过期测试。', en: 'Configured expiry body.' } } } };
  for (const outcome of ['sent', 'suppressed', 'failed', 'uncertain']) {
    const record = expired(f), before = getRow(f.db, record.id); let body;
    const send = sender({ render: route => messageForStatus(route, config), spawn: () => {
      if (outcome === 'failed') throw Error('not started');
      const c = child(outcome === 'uncertain' ? 1 : 0), end = c.stdin.end;
      c.stdin.end = text => { body = text; end(); }; return c;
    } });
    const handler = createPendingExpiryHandler({ isComponent: () => true, resolveSessionLaunchConfig: () => ({ runtime: 'claude' }),
      readRuntimeHealth: () => ({ unreadable: true }), sendStatusNotice: send });
    const context = { sessionMode: 'multi', identity: { present: false } };
    if (outcome === 'suppressed') await handler(record, context);
    assert.equal((await handler(record, context)).outcome, outcome);
    assert.deepEqual(getRow(f.db, record.id), before);
    assert.equal(before.status, 'failed'); assert.equal(before.delivery_action, 'pending_expired');
    assert.equal(f.store.getNextPending(), null);
    if (outcome !== 'failed') assert.equal(body, messageForStatus({ runtime: 'claude', health: 'unavailable', reason: 'pending_expired', noticeKind: 'pending_expired' }, config));
  }
});

test('IF70 scheduler calls expiry receipt only after commit, skips launch/start_attempt, continues next fresh row', async t => {
  const f = routerFixture(t); f.put('origin'); f.put('chat');
  const old = f.add('chat'), fresh = f.add('chat');
  f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now() / 1000 - 1801, old.id);
  const observed = [];
  const handler = createPendingExpiryHandler({ isComponent: () => true,
    resolveSessionLaunchConfig: () => assert.fail('live scene must be used'),
    readRuntimeHealth: runtime => { assert.equal(f.row(old.id).delivery_action, 'pending_expired'); observed.push(['health', runtime]); return { missing: true }; },
    sendStatusNotice: async row => { observed.push(['notice', row.id]); return sender()(row, { runtime: 'claude', health: 'ok', reason: 'pending_expired' }); } });
  f.deps.handleExpired = handler;
  const router = f.create(); await router.initialize(); await f.rounds(4);
  assert.deepEqual(observed, [['health', 'claude'], ['notice', old.id]]);
  assert.equal(f.row(old.id).status, 'failed'); assert.equal(f.row(fresh.id).status, 'delivered');
  assert.equal(f.calls.some(c => ['launch', 'submit'].includes(c[0])), false);
  assert.deepEqual(f.calls.filter(c => c[0] === 'conversation').map(c => c[1]), [fresh.id]);
});
