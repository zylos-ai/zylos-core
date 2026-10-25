import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageRouter, messageForRoute, normalizeHealth, validRouteRequest } from '../message-router.js';

const request = (overrides = {}) => ({ version: 2, type: 'route', requestId: 'req-1', channel: 'telegram', endpoint: 'ep1',
  componentName: 'telegram', sessionGroup: 'telegram:one', noReply: false, receivedAt: 1792000000000, ...overrides });
function fixture(t, overrides = {}) {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'route-test-'));
  t.after(() => fs.rmSync(cacheDirectory, { recursive: true, force: true }));
  const states = { claude: { health: 'ok', reason: '', scheduling: {} }, codex: { health: 'unavailable', reason: 'heartbeat_timeout', scheduling: {} } };
  const calls = { probes: [], notify: [], targets: [] };
  const coordinator = { store: runtime => ({ read: () => states[runtime] }), notifyUserMessage: runtime => { calls.notify.push(runtime); return false; } };
  const router = new MessageRouter({ healthCoordinator: coordinator, cacheDirectory,
    resolveTargetRuntime: group => { calls.targets.push(group); return group === 'telegram:two' ? 'codex' : 'claude'; },
    requestProbe: async runtime => calls.probes.push(runtime), ...overrides });
  return { router, states, calls, coordinator, cacheDirectory };
}

test('IB-02 public messages hide internal recovery details and normalize old health', () => {
  for (const reason of ['tool_timeout_exec', 'sticky_context_restart']) assert.match(messageForRoute({ health: 'unavailable', reason }), /temporarily unavailable/i);
  assert.equal(normalizeHealth('recovering'), 'unavailable');
  assert.equal(normalizeHealth('down'), 'unavailable');
  assert.equal(normalizeHealth('rate_limited'), 'rate_limited');
});
test('IB-02 v2 requires all fields; v1 maps target to null', async t => {
  for (const field of ['componentName', 'sessionGroup', 'channel', 'endpoint', 'receivedAt', 'noReply']) {
    const input = request(); delete input[field]; assert.equal(validRouteRequest(input), false, field);
  }
  assert.equal(validRouteRequest(request({ coreSide: true })), false);
  assert.equal(validRouteRequest(request({ coreSide: true, coreSource: 'scheduler' })), true);
  assert.equal(validRouteRequest(request({ sessionGroup: '../bad' })), false);
  const f = fixture(t); const result = await f.router.route(request({ version: 1 }));
  assert.deepEqual(f.calls.targets, [null]); assert.equal(result.version, 1); assert.equal(result.recovered, true);
});
test('IB-02 transition holds before target resolution or probe', async t => {
  const f = fixture(t, { getModeTransition: () => ({ phase: 'gating' }) });
  const result = await f.router.route(request());
  assert.equal(result.decision, 'pending'); assert.equal(result.transitionHold, true);
  assert.deepEqual(f.calls.targets, []); assert.deepEqual(f.calls.probes, []);
});
test('IB-02 unknown runtime is pending and never borrows a health record', async t => {
  const f = fixture(t, { resolveTargetRuntime: () => 'unknown' });
  const result = await f.router.route(request());
  assert.equal(result.runtime, 'unknown'); assert.equal(result.observation, 'runtime_unknown');
  assert.equal(result.decision, 'pending'); assert.deepEqual(f.calls.notify, []);
});
test('IB-02 rate limit is pending; non-noReply acceleration runs before cache', async t => {
  const f = fixture(t); f.states.claude.health = 'rate_limited'; f.states.claude.reason = 'rate_limit_detected';
  f.coordinator.notifyUserMessage = runtime => { assert.equal(runtime, 'claude'); f.calls.notify.push(runtime); return true; };
  f.router.writeNegativeCache('claude', 'rate_limited', 'rate_limit_detected');
  const result = await f.router.route(request());
  assert.deepEqual(f.calls.probes, ['claude']); assert.deepEqual(f.calls.notify, ['claude']);
  assert.equal(result.decision, 'pending'); assert.equal(result.recovered, true); assert.equal(result.userMessage, undefined);
});
test('IB-02 caches and merges probes independently per runtime', async t => {
  const resolvers = []; const f = fixture(t, { requestProbe: runtime => new Promise(resolve => resolvers.push({runtime, resolve})) });
  f.states.claude = { health: 'unavailable', reason: 'heartbeat_timeout', scheduling: {} };
  const pending = [f.router.route(request()), f.router.route(request({ requestId: '2' })), f.router.route(request({ sessionGroup: 'telegram:two', requestId: '3' }))];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(resolvers.map(x => x.runtime).sort(), ['claude', 'codex']);
  resolvers.forEach(x => x.resolve()); await Promise.all(pending);
  const result = await f.router.route(request());
  assert.equal(result.cacheHit, true); assert.equal(result.recovered, false); assert.equal(resolvers.length, 2);
  assert.equal(result.userMessage, messageForRoute({ health: 'unavailable', reason: 'heartbeat_timeout' }));
});
test('IB-02 healthy state clears its own cache and noReply never accelerates', async t => {
  const f = fixture(t); f.router.writeNegativeCache('claude', 'unavailable', 'old'); f.router.writeNegativeCache('codex', 'unavailable', 'heartbeat_timeout');
  const result = await f.router.route(request()); assert.equal(result.decision, 'pending');
  assert.equal(fs.existsSync(f.router.cachePath('claude')), false); assert.equal(fs.existsSync(f.router.cachePath('codex')), true);
  const unavailable = await f.router.route(request({ sessionGroup: 'telegram:two', noReply: true }));
  assert.equal(unavailable.recovered, false); assert.equal(unavailable.userMessage, undefined); assert.deepEqual(f.calls.notify, []);
});
test('IB-02 auth external failures sanitize details; core and channel-less noReply stay pending', async t => {
  let checks = 0;
  const f = fixture(t, { checkAuth: () => { checks++; return { status: 'failure', reason: '\u0000bad\n' + 'a'.repeat(600) }; } });
  f.states.claude.health = 'auth_failed';
  const result = await f.router.route(request());
  assert.equal(result.decision, 'auth_rejected'); assert.equal(result.auth.result, 'failed');
  assert.equal(result.auth.detail.length, 500); assert.doesNotMatch(result.auth.detail, /[\x00-\x1f]/); assert.ok(result.userMessage);
  assert.equal((await f.router.route(request({ coreSide: true, coreSource: 'scheduler' }))).decision, 'pending');
  assert.equal((await f.router.route(request({ noReply: true, channel: null, componentName: null }))).decision, 'pending');
  assert.equal(checks, 1);
});
test('IB-02 successful authentication waits for lifecycle release; uncertain is explicit', async t => {
  const f = fixture(t, { checkAuth: () => ({ status: 'success' }) }); f.states.claude.health = 'auth_failed';
  assert.equal((await f.router.route(request())).decision, 'pending'); assert.equal(f.states.claude.health, 'auth_failed');
  f.router.checkAuth = () => ({ status: 'uncertain', reason: 'not confirmed' });
  assert.equal((await f.router.route(request())).auth.result, 'unconfirmed');
});
