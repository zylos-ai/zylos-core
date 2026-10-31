import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

function harness() {
  const notices = [];
  const timers = [];
  const observer = { intent: { targetKey: 'local', attempt: 0 }, ws: {} };
  const context = vm.createContext({
    state: { observer }, observer, ws: observer.ws, generation: 1, targetKey: 'local',
    observerTargetKey: () => 'local', observerSessionCurrent: () => true,
    t: key => key,
    async closeObserver({ preserveIntent }) { if (!preserveIntent) observer.intent = null; },
    setObserverNotice: (...args) => notices.push(args),
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    openObserver: async () => {},
  });
  vm.runInContext(app.slice(app.indexOf('function observerRetryable('), app.indexOf('async function closeObserver(')), context);
  const start = app.indexOf('    ws.onclose =');
  vm.runInContext(app.slice(start, app.indexOf('    observer.renewTimer =', start)), context);
  return { context, observer, notices, timers };
}

test('Observer retry policy recognizes public reasons and still rejects authentication failures', () => {
  const { context } = harness();
  for (const code of ['pong_timeout', 'lease_invalid', 'lease_expired']) assert.equal(context.observerRetryable({ code }), true);
  assert.equal(context.observerRetryable({ code: 'auth_expired' }), false);
  assert.equal(context.observerRetryable({ status: 401 }), false);
  assert.equal(context.observerRetryable({ status: 403 }), false);
  assert.equal(context.observerRetryable(), true);
});

test('Observer onclose reads auth_expired, stops reconnecting, and shows the localized notice', async () => {
  const h = harness();
  h.observer.ws.onclose({ reason: 'auth_expired' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.observer.intent, null);
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.notices, [['observer.session_expired', 'error']]);
});

test('Observer all non-authentication close reasons preserve backoff reconnect', async () => {
  for (const reason of ['pong_timeout', 'lease_invalid', 'dashboard_shutdown', 'upstream_closed',
    'child_failure', 'observer_stopped', 'observer_unavailable', 'stream_error', 'unknown_future_reason', '']) {
    const h = harness();
    h.observer.ws.onclose({ reason });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.observer.intent);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].delay, 1000);
    assert.deepEqual(h.notices, [['observer.waiting_for_agent', 'connecting']]);
  }
});

test('Observer ignores close events from a replaced connection', async () => {
  const h = harness();
  const previous = h.observer.ws;
  h.observer.ws = {};
  previous.onclose({ reason: 'auth_expired' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.observer.intent);
  assert.equal(h.notices.length, 0);
  assert.equal(h.timers.length, 0);
});
