import test from 'node:test';
import assert from 'node:assert/strict';
import { waitingReason, fenceLabel } from '../src/lib/workbench/waiting-reason.js';
const now = 1800000000000;
const row = patch => ({ sessionGroup: 'a', presence: 'not_running', createdAt: now / 1000 - 10,
  queue: { pending: { count: 1, oldestAt: now - 2000 } }, fence: null, target: { runtime: 'claude' },
  live: { status: { valid: true, state: 'idle' } }, ...patch });
const ctx = health => ({ now, pool: { used: 0, capacity: 3 }, runtimeHealth: { claude: { source: 'record', health, cooldownUntil: now / 1000 + 60 } }, activations: [] });
test('fence labels include authentication and manual restart', () => {
  for (const [reason, label] of Object.entries({ ttl: 'TTL', evict: '驱逐', upgrade: '升级', model_config: '配置', manual_restart: '手工重启', mode_switch: '模式切换', auth: '认证' })) assert.equal(fenceLabel(reason), label);
});
for (const reason of ['ttl', 'manual_restart', null]) test('fence precedes queue and health: ' + reason, () => {
  const result = waitingReason(row({ fence: { reason, createdAt: 42 } }), ctx('auth_failed'));
  assert.deepEqual(result, { kind: 'fenced', fenceReason: reason ?? 'mode_switch', since: 42 });
});
for (const presence of ['starting', 'not_running']) test('unknown queue preserves presence evidence: ' + presence, () => {
  const result = waitingReason(row({ presence, queue: { known: false } }), ctx('auth_failed'));
  assert.equal(result.kind, presence === 'starting' ? 'starting' : 'unknown');
  if (presence !== 'starting') { assert.equal(result.reason, 'queue_summary_failed');assert.equal(result.pendingKnown, false); }
});
for (const presence of ['starting', 'not_running']) test('empty sparse queue does not manufacture waiting: ' + presence, () => {
  const result = waitingReason(row({ presence, queue: { pending: { count: 0 } } }), ctx('auth_failed'));
  assert.equal(result?.kind ?? null, presence === 'starting' ? 'starting' : null);
});
for (const health of ['auth_failed', 'rate_limited', 'recovering', 'unavailable', 'down', 'ok']) test('runtime health gates busy groups before queue classification: ' + health, () => {
  const result = waitingReason(row({ presence: 'running', live: { status: { valid: true, state: 'busy' } } }), ctx(health));
  assert.equal(result.kind, health === 'auth_failed' ? 'auth_wait' : ['rate_limited', 'recovering'].includes(health) ? 'rate_wait' : health === 'ok' ? 'queued' : 'unknown');
  if (['rate_limited', 'recovering'].includes(health)) assert.equal(result.cooldownUntil, now / 1000 + 60);
  if (['unavailable', 'down'].includes(health)) { assert.equal(result.reason, 'no_rule');assert.equal(result.health, health); }
});
test('unknown target is not guessed from healthy accounts and unreadable health is explicit', () => {
  assert.deepEqual(waitingReason(row({ target: { runtime: null, reason: 'override_list_failed' } }), ctx('ok')), { kind: 'unknown', reason: 'override_list_failed' });
  assert.equal(waitingReason(row(), { ...ctx('ok'), runtimeHealth: { claude: { source: 'unreadable', health: null } } }).reason, 'runtime_health_unreadable');
  assert.equal(waitingReason(row(), { ...ctx('down'), runtimeHealth: { claude: { source: 'missing' } } }).reason, 'no_rule');
});
test('latest failed activation reports bounded count, while a newer start clears it', () => {
  const event = (type, age, group = 'a') => ({ session_group: group, timestamp: new Date(now - age).toISOString(), event_type: type, metadata: { reason: 'ready_timeout' } });
  const activations = [event('activate_failed', 3000), event('activate_timeout', 2000), event('activate_timeout', 1000), event('activate_failed', 1800001), event('activate_failed', 0, 'other')];
  const result = waitingReason(row(), { ...ctx('ok'), activations });
  assert.equal(result.kind, 'start_failed');assert.equal(result.count30m, 3);assert.equal(result.lastAt, activations[2].timestamp);assert.equal(result.reasonCode, 'ready_timeout');
  assert.equal(waitingReason(row(), { ...ctx('ok'), activations: [...activations, event('activate_new', 0)] }).reason, 'no_rule');
});
test('healthy starting, absent and running-idle groups retain their distinct reasons', () => {
  assert.equal(waitingReason(row({ presence: 'starting' }), ctx('ok')).kind, 'starting');
  assert.equal(waitingReason(row(), ctx('ok')).reason, 'no_rule');
  assert.equal(waitingReason(row({ presence: 'running' }), ctx('ok')).reason, 'no_rule');
});

test('pending starting groups wait for authentication before reporting startup', () => {
  assert.deepEqual(waitingReason(row({ presence: 'starting' }), ctx('auth_failed')),
    { kind: 'auth_wait', runtime: 'claude' });
});

test('activation failures include the exact thirty-minute boundary and exclude older events', () => {
  const event = age => ({ session_group: 'a', timestamp: new Date(now - age).toISOString(),
    event_type: 'activate_failed', metadata: { reason: 'ready_timeout' } });
  const atBoundary = waitingReason(row(), { ...ctx('ok'), activations: [event(1800000), event(1800001)] });
  assert.equal(atBoundary.kind, 'start_failed'); assert.equal(atBoundary.count30m, 1);
  assert.equal(atBoundary.lastAt, new Date(now - 1800000).toISOString());
  assert.equal(waitingReason(row(), { ...ctx('ok'), activations: [event(1800001)] }).reason, 'no_rule');
});

test('activation failure reasons preserve codes and redact arbitrary error text', () => {
  const failure = reason => ({ session_group: 'a', timestamp: new Date(now).toISOString(),
    event_type: 'activate_failed', metadata: { reason } });
  const reasonFor = reason => waitingReason(row(), { ...ctx('ok'), activations: [failure(reason)] }).reasonCode;
  assert.equal(reasonFor('ready_timeout'), 'ready_timeout');
  const secret = 'sk-123456789012345678901234';
  const reason = reasonFor('launch failed with ' + secret + ' for person@example.com');
  assert.equal(reason.includes(secret), false); assert.equal(reason.includes('person@example.com'), false);
  assert.match(reason, /REDACTED/); assert.match(reason, /EMAIL/);
  assert.equal(reasonFor({ message: secret }), null);
});

test('full pool is evaluated after guards and before recent startup failure', () => {
  const context = { ...ctx('ok'), pool: { used: 3, capacity: 3 }, position: 2,
    activations: [{ session_group: 'a', timestamp: new Date(now).toISOString(), event_type: 'activate_failed', metadata: {} }] };
  assert.deepEqual(waitingReason(row(), context), { kind: 'pool_wait', position: 2 });
  assert.equal(waitingReason(row({ fence: { reason: 'upgrade' } }), context).kind, 'fenced');
  assert.equal(waitingReason(row({ queue: { known: false } }), context).reason, 'queue_summary_failed');
  assert.equal(waitingReason(row({ target: { runtime: null, reason: 'override_list_failed' } }), context).reason, 'override_list_failed');
  assert.equal(waitingReason(row(), { ...context, runtimeHealth: {} }).reason, 'runtime_health_unreadable');
  assert.equal(waitingReason(row(), { ...context, ...ctx('auth_failed') }).kind, 'auth_wait');
  assert.equal(waitingReason(row(), { ...context, ...ctx('rate_limited') }).kind, 'rate_wait');
  assert.equal(waitingReason(row({ presence: 'starting' }), context).kind, 'starting');
});

test('owned slots bypass capacity while retaining startup failure and other guards', () => {
  const context = { ...ctx('ok'), pool: { used: 4, capacity: 3 }, position: 1, ownsSlot: true };
  assert.deepEqual(waitingReason(row(), context), { kind: 'unknown', reason: 'no_rule' });
  assert.equal(waitingReason(row(), { ...context, activations: [{ session_group: 'a', timestamp: now,
    event_type: 'activate_timeout', metadata: {} }] }).kind, 'start_failed');
  assert.equal(waitingReason(row({ fence: { reason: 'auth' } }), context).kind, 'fenced');
  assert.equal(waitingReason(row(), { ...context, runtimeHealth: { claude: { health: 'auth_failed' } } }).kind, 'auth_wait');
});

test('unreadable occupancy falls through startup failure and never manufactures a queue position', () => {
  const context = { ...ctx('ok'), pool: { used: null, capacity: 3 }, position: 1 };
  assert.deepEqual(waitingReason(row(), context), { kind: 'unknown', reason: 'pool_occupancy_unreadable' });
  const event = { session_group: 'a', timestamp: now, event_type: 'activate_failed', metadata: {} };
  assert.equal(waitingReason(row(), { ...context, activations: [event] }).kind, 'start_failed');
  assert.equal(waitingReason(row({ queue: { pending: { count: 0 } } }), context), null);
});
