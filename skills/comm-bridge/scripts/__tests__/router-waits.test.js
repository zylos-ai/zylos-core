import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelivery } from '../router/delivery.js';
import { routerFixture } from './helpers/router-fixture.js';

function setup(t) {
  const f = routerFixture(t); f.put('origin'); f.put('chat');
  const calls = { claims: 0, requeues: 0, opens: 0, pastes: 0 };
  const status = { state: 'idle', idle_seconds: 10, health: 'ok' };
  const claim = f.db.claimConversation, requeue = f.db.requeueConversation;
  f.db.claimConversation = id => { calls.claims++; return claim(id); };
  f.db.requeueConversation = id => { calls.requeues++; return requeue(id); };
  // routerFixture supplies the store; facade-only control settlement is the
  // injected boundary here, as in the delivery unit fixture. Scheduling, gate
  // decisions, backoff and wait transitions still execute product code.
  f.db.requeueControl = id => f.sqlite.prepare("UPDATE control_queue SET status='pending' WHERE id=? AND status='running'").run(id);
  f.db.ackControl = id => f.sqlite.prepare("UPDATE control_queue SET status='done' WHERE id=? AND status='running'").run(id);
  f.db.getConversationsByRange = (first, last) => f.sqlite.prepare('SELECT * FROM conversations WHERE id BETWEEN ? AND ?').all(first, last);
  const delivery = createDelivery({ ...f.deps, getSessionMode: () => 'multi', now: f.now,
    sleep: async ms => f.advance(ms),
    openTmuxConnection: async () => { calls.opens++; return { close: async () => {}, command: async args => args.at(-1) === '#{cursor_x}' ? '2' : '0' }; },
    resolveSessionTarget: async ({ sessionGroup }) => f.scene.get(sessionGroup),
    revalidateSessionTarget: async () => {},
    readSessionState: async group => ({ identity: f.scene.get(group), status: { valid: true, value: status } }),
    getSessionAdapter: () => ({ sendText: async () => { calls.pastes++; }, sendKeys: async () => {}, captureScreen: async () => '❯ ' }),
    formatConversation: row => row.content,
    notifyDelivered: () => {},
  }, { periodicEnabled: false, captureEnabled: false });
  Object.assign(f.deps, { deliverConversation: delivery.deliverConversation, deliverControl: delivery.deliverControl,
    canAttemptDelivery: delivery.canAttempt, finishDeliveryWait: delivery.finishWait, sweepDeliveryWaits: delivery.sweepWaits });
  t.after(() => delivery.stop());
  return { ...f, counts: calls, status, delivery };
}
const transitions = f => f.events.filter(row => ['delivery_deferred', 'delivery_wait_changed', 'delivery_resumed', 'delivery_expired', 'delivery_wait_ended'].includes(row.event));
async function seconds(f, count) { for (let i = 0; i < count; i++) { f.advance(1000); await f.rounds(); } }

// Integration boundary: real scheduler + delivery + conditional SQLite ledger;
// fake clock/READY/adapter only, with no tmux or child I/O. Run for delivery
// gating, lane backoff or expiry changes; unrelated transport/UI may skip. The
// official runner isolates HOME/ZYLOS_DIR/PM2/temp/socket paths and each fixture
// closes its in-memory DB and router/delivery lifecycle in teardown.
for (const kind of ['runtime health', 'require_idle']) {
  test(`ten minutes of ${kind} gating records transitions without per-second claims`, async t => {
    const f = setup(t), row = f.add('chat', kind === 'require_idle' ? { requireIdle: true } : undefined);
    if (kind === 'runtime health') f.health.set('claude', { publicHealth: 'rate_limited', health: 'rate_limited' });
    else f.status.state = 'busy';
    await f.create().initialize(); await f.rounds(2); await seconds(f, 600);
    assert.equal(f.row(row.id).status, 'pending');
    assert.equal(transitions(f).length, 1);
    assert.equal(transitions(f)[0].event, 'delivery_deferred');
    assert.ok(f.counts.claims < 30, `claims=${f.counts.claims}`);
    assert.equal(f.counts.requeues, f.counts.claims);
    assert.equal(f.counts.opens, f.counts.claims);
    assert.equal(f.counts.pastes, 0);
    // A recovery control is a different row and must not wait for a gated head.
    const recovery = f.db.insertControl('recover', { sessionGroup: 'chat', bypassState: true, priority: 0, appendAckSuffix: false });
    await f.rounds(); assert.equal(f.db.getControlById(recovery.id).status, 'done');
    f.health.clear(); f.status.state = 'idle'; await seconds(f, 30);
    assert.equal(f.row(row.id).status, 'delivered');
    const resumed = transitions(f).find(event => event.event === 'delivery_resumed');
    assert.ok(resumed.durationMs >= 600000); assert.ok(resumed.attempts > 1); assert.ok(resumed.deferredChecks > 500);
    assert.equal(transitions(f).length, 2);
  });
}

test('reason changes and pending expiry each close a truthful wait phase once', async t => {
  const f = setup(t), row = f.add('chat'); f.options.pendingMaxAgeSeconds = 600;
  f.health.set('claude', { health: 'rate_limited', publicHealth: 'rate_limited' });
  await f.create().initialize(); await f.rounds(2); await seconds(f, 100);
  f.health.set('claude', { health: 'auth_failed', publicHealth: 'unavailable' });
  await seconds(f, 501);
  const events = transitions(f);
  assert.equal(events.length, 3); assert.equal(events[0].reason, 'runtime_rate_limited');
  assert.equal(events[1].event, 'delivery_wait_changed'); assert.equal(events[1].previousReason, 'runtime_rate_limited');
  assert.equal(events[1].reason, 'runtime_unavailable'); assert.ok(events[1].phaseDurationMs >= 100000);
  assert.equal(events[2].event, 'delivery_expired'); assert.ok(events[2].durationMs >= 600000);
  assert.equal(f.row(row.id).delivery_action, 'pending_expired');
  const claims = f.counts.claims; await seconds(f, 120); assert.equal(f.counts.claims, claims); assert.equal(transitions(f).length, 3);
});

test('control deadline expiration closes wait and later cancellation is not mislabeled expired', async t => {
  const f = setup(t); f.health.set('claude', { health: 'rate_limited', publicHealth: 'rate_limited' });
  const control = f.db.insertControl('sync', { sessionGroup: 'chat', ackDeadlineAt: f.now() / 1000 + 60, appendAckSuffix: false });
  await f.create().initialize(); await f.rounds(2); await seconds(f, 120);
  assert.equal(f.db.getControlById(control.id).status, 'timeout'); assert.equal(transitions(f).length, 2);
  assert.equal(transitions(f)[1].event, 'delivery_expired');
  const row = f.add('chat'); await f.rounds();
  f.sqlite.prepare("UPDATE conversations SET status='failed',delivery_action='cancelled' WHERE id=?").run(row.id);
  await f.rounds();
  const ended = transitions(f).at(-1); assert.equal(ended.event, 'delivery_wait_ended'); assert.equal(ended.outcome, 'failed');
  const n = transitions(f).length; await seconds(f, 60); assert.equal(transitions(f).length, n);
});


test('a waiting row reports the currently observed run when its executor changes', async t => {
  const f = setup(t), row = f.add('chat');
  f.health.set('claude', { health: 'rate_limited', publicHealth: 'rate_limited' });
  await f.create().initialize(); await f.rounds(2);
  const replacement = f.put('chat', { runId: 'replacement-run', sessionId: 'replacement-session' });
  f.health.set('claude', { health: 'auth_failed', publicHealth: 'unavailable' });
  await seconds(f, 5);
  const changed = transitions(f).find(event => event.event === 'delivery_wait_changed');
  assert.equal(changed.runId, replacement.runId); assert.ok(changed.durationMs >= 5000);
  // Resume can be the very first gate evaluation on another replacement run.
  const resumedRun = f.put('chat', { runId: 'resumed-run', sessionId: 'resumed-session' });
  f.health.clear(); await seconds(f, 10);
  const resumed = transitions(f).find(event => event.event === 'delivery_resumed');
  assert.equal(resumed.runId, resumedRun.runId); assert.equal(resumed.attempts, 2);
  assert.equal(f.row(row.id).session_id, resumedRun.sessionId);
});

test('a recovery control takes precedence over a stalled expired-message receipt', async t => {
  const f = setup(t), row = f.add('chat');
  f.sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(f.now() / 1000 - 1801, row.id);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let entered = false;
  f.deps.handleExpired = async () => { entered = true; await hold; };
  t.after(() => release());
  const recovery = f.db.insertControl('recover', { sessionGroup: 'chat', bypassState: true, priority: 0, appendAckSuffix: false });
  const router = f.create();
  try {
    await router.initialize(); await f.rounds(2);
    assert.equal(f.db.getControlById(recovery.id).status, 'done');
    assert.equal(entered, false);
    router.tick();
    for (let i = 0; i < 20 && !entered; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(entered, true);
  } finally { release(); await router.idle(); }
  assert.equal(f.row(row.id).delivery_action, 'pending_expired');
});
