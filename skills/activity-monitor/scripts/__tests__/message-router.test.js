import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageRouter, validRouteRequest } from '../message-router.js';

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

test('v2 requires all fields; v1 maps target to null', async t => {
  for (const field of ['componentName', 'sessionGroup', 'channel', 'endpoint', 'receivedAt', 'noReply']) {
    const input = request(); delete input[field]; assert.equal(validRouteRequest(input), false, field);
  }
  assert.equal(validRouteRequest(request({ coreSide: true })), false);
  assert.equal(validRouteRequest(request({ coreSide: true, coreSource: 'scheduler' })), true);
  assert.equal(validRouteRequest(request({ sessionGroup: '../bad' })), false);
  const f = fixture(t); const result = await f.router.route(request({ version: 1 }));
  assert.deepEqual(f.calls.targets, [null]); assert.equal(result.version, 1); assert.equal(result.recovered, true);
});
test('transition holds before target resolution or probe', async t => {
  const f = fixture(t, { getModeTransition: () => ({ phase: 'gating' }) });
  const result = await f.router.route(request());
  assert.equal(result.decision, 'pending'); assert.equal(result.transitionHold, true);
  assert.deepEqual(f.calls.targets, []); assert.deepEqual(f.calls.probes, []);
});
test('rate limit is pending; non-noReply acceleration runs before cache', async t => {
  const f = fixture(t); f.states.claude.health = 'rate_limited'; f.states.claude.reason = 'rate_limit_detected';
  f.coordinator.notifyUserMessage = runtime => { assert.equal(runtime, 'claude'); f.calls.notify.push(runtime); return true; };
  f.router.writeNegativeCache('claude', 'rate_limited', 'rate_limit_detected');
  const result = await f.router.route(request());
  assert.deepEqual(f.calls.probes, ['claude']); assert.deepEqual(f.calls.notify, ['claude']);
  assert.equal(result.decision, 'pending'); assert.equal(result.recovered, true); assert.equal(result.userMessage, undefined);
});
test('auth external failures sanitize details; core and channel-less noReply stay pending', async t => {
  let checks = 0;
  const f = fixture(t, { checkAuth: () => { checks++; return { status: 'failure', reason: '\u0000bad\n' + 'a'.repeat(600) }; } });
  f.states.claude.health = 'auth_failed';
  const result = await f.router.route(request());
  assert.equal(result.decision, 'auth_rejected'); assert.equal(result.auth.result, 'failed');
  assert.equal(result.auth.detail.length, 500); assert.doesNotMatch(result.auth.detail, /[\x00-\x1f]/); assert.ok(result.userMessage);
  assert.equal((await f.router.route(request({ coreSide: true, coreSource: 'scheduler' }))).decision, 'pending');
  assert.equal((await f.router.route(request({ noReply: true, channel: 'system', componentName: null, sessionGroup: 'origin' }))).decision, 'pending');
  assert.equal(checks, 1);
});

