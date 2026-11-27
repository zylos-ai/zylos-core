import test from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_MAX_AGE_SECONDS } from '../c4-config.js';
import { createDelivery } from '../router/delivery.js';
import { formatConversation } from '../router/format.js';
import { routerFixture } from './helpers/router-fixture.js';

function setup(t) {
  const f = routerFixture(t); f.put('origin'); f.put('chat');
  const calls = { claims: 0, requeues: 0, controlClaims: 0, controlRequeues: 0, opens: 0, pastes: 0 };
  const status = { state: 'idle', idle_seconds: 10, health: 'ok' };
  const sample = { valid: true, value: status };
  const sent = [];
  const claim = f.db.claimConversation, requeue = f.db.requeueConversation;
  f.db.claimConversation = id => { calls.claims++; return claim(id); };
  f.db.requeueConversation = id => { calls.requeues++; return requeue(id); };
  const claimControl = f.db.claimControl;
  f.db.claimControl = id => { calls.controlClaims++; return claimControl(id); };
  // routerFixture supplies the store; facade-only control settlement is the
  // injected boundary here, as in the delivery unit fixture. Scheduling, gate
  // decisions, backoff and wait transitions still execute product code.
  f.db.requeueControl = id => {
    calls.controlRequeues++;
    return f.sqlite.prepare("UPDATE control_queue SET status='pending' WHERE id=? AND status='running'").run(id);
  };
  f.db.ackControl = id => f.sqlite.prepare("UPDATE control_queue SET status='done' WHERE id=? AND status='running'").run(id);
  // Match the c4-db deadline facade's persisted reason, including its existing
  // preservation of an earlier error. The shared fixture only sets status.
  f.db.expireTimedOutControls = now => f.sqlite.prepare(`UPDATE control_queue
    SET status='timeout',last_error=COALESCE(last_error,'ACK_DEADLINE_EXCEEDED')
    WHERE status IN ('pending','running') AND ack_deadline_at<?`).run(now).changes;
  f.db.getConversationsByRange = (first, last) => f.sqlite.prepare('SELECT * FROM conversations WHERE id BETWEEN ? AND ?').all(first, last);
  const delivery = createDelivery({ ...f.deps, getSessionMode: () => 'multi', now: f.now,
    sleep: async ms => f.advance(ms),
    openTmuxConnection: async () => { calls.opens++; return { close: async () => {}, command: async args => args.at(-1) === '#{cursor_x}' ? '2' : '0' }; },
    resolveSessionTarget: async ({ sessionGroup }) => f.scene.get(sessionGroup),
    revalidateSessionTarget: async () => {},
    readSessionState: async group => ({ identity: f.scene.get(group), status: sample }),
    session: { sendText: async ({ text }) => { calls.pastes++; sent.push(text); }, sendKeys: async () => {}, captureScreen: async () => '❯ ' },
    formatConversation,
    notifyDelivered: () => {},
  }, { periodicEnabled: false, captureEnabled: false });
  Object.assign(f.deps, { deliverConversation: delivery.deliverConversation, deliverControl: delivery.deliverControl,
    canAttemptDelivery: delivery.canAttempt, finishDeliveryWait: delivery.finishWait, sweepDeliveryWaits: delivery.sweepWaits });
  t.after(() => delivery.stop());
  return { ...f, counts: calls, status, sample, sent, delivery };
}
const transitions = f => f.events.filter(row => ['delivery_deferred', 'delivery_wait_changed', 'delivery_resumed', 'delivery_expired', 'delivery_wait_ended'].includes(row.event));
async function seconds(f, count) { for (let i = 0; i < count; i++) { f.advance(1000); await f.rounds(); } }

test('a blocked Sync control backs off before claiming and stops retrying after its deadline', async t => {
  const f = setup(t); f.health.set('claude', { health: 'rate_limited', publicHealth: 'rate_limited' });
  const control = f.db.insertControl('group sync', { sessionGroup: 'chat', priority: 2,
    ackDeadlineAt: f.now() / 1000 + 300, appendAckSuffix: false });
  await f.create().initialize(); await f.rounds(2);
  assert.equal(f.counts.controlClaims, 1);
  // Observe every boundary, not just the final total: a missing preclaim check
  // would claim/requeue/open at each intervening scheduler tick.
  const start = f.now();
  for (const [at, expected] of [[1000, 2], [2000, 2], [3000, 3], [6000, 3], [7000, 4],
    [14000, 4], [15000, 5], [30000, 5], [31000, 6], [60000, 6], [61000, 7]]) {
    await seconds(f, (start + at - f.now()) / 1000);
    assert.equal(f.counts.controlClaims, expected, `claims at ${at}ms`);
    assert.equal(f.counts.controlRequeues, expected, `requeues at ${at}ms`);
    assert.equal(f.counts.opens, expected, `connections at ${at}ms`);
  }
  await seconds(f, 240);
  assert.equal(f.db.getControlById(control.id).status, 'timeout');
  assert.equal(f.db.getControlById(control.id).last_error, 'ACK_DEADLINE_EXCEEDED');
  assert.equal(f.counts.controlClaims, 14);
  assert.equal(f.counts.controlRequeues, 14);
  assert.equal(f.counts.opens, 14);
  assert.equal(f.counts.pastes, 0);
  assert.equal(transitions(f).length, 2);
  assert.equal(transitions(f)[0].event, 'delivery_deferred');
  assert.equal(transitions(f)[1].event, 'delivery_expired');
  await seconds(f, 300);
  assert.equal(f.counts.controlClaims, 14, 'terminal Sync must never be claimed again');
  assert.equal(f.counts.controlRequeues, 14);
  assert.equal(f.counts.opens, 14);
  assert.equal(transitions(f).length, 2);
});

test('an inbound message queued behind a fence is delivered after a long wait', async t => {
  const f = setup(t);
  f.db.setDrainFence('chat', { reason: 'evict', runId: f.scene.get('chat').runId });
  const message = f.add('chat');
  await f.create().initialize();
  f.advance((PENDING_MAX_AGE_SECONDS + 60) * 1000);
  await f.rounds();
  assert.equal(f.row(message.id).status, 'pending');
  assert.equal(f.sent.length, 0);

  f.db.clearDrainFence('chat');
  await f.rounds(2);
  assert.equal(f.row(message.id).status, 'delivered');
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].split('\n', 1)[0], /^\[C4\] This message waited in the queue for /);
});
