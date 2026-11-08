import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageRouter, messageForRoute, validRouteRequest } from '../message-router.js';
import { normalizeHealth, RuntimeHealthCoordinator } from '../runtime-health.js';
import { SupervisorHealthObserver } from '../supervisor-health-observer.js';

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

test('public messages hide internal recovery details and normalize old health', () => {
  for (const reason of ['tool_timeout_exec', 'sticky_context_restart']) assert.match(messageForRoute({ health: 'unavailable', reason }), /temporarily unavailable/i);
  assert.equal(normalizeHealth('recovering'), 'unavailable');
  assert.equal(normalizeHealth('down'), 'unavailable');
  assert.equal(normalizeHealth('rate_limited'), 'rate_limited');
});
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
test('unknown runtime is pending and never borrows a health record', async t => {
  const f = fixture(t, { resolveTargetRuntime: () => 'unknown' });
  const result = await f.router.route(request());
  assert.equal(result.runtime, 'unknown'); assert.equal(result.observation, 'runtime_unknown');
  assert.equal(result.decision, 'pending'); assert.deepEqual(f.calls.notify, []);
});
test('rate limit is pending; non-noReply acceleration runs before cache', async t => {
  const f = fixture(t); f.states.claude.health = 'rate_limited'; f.states.claude.reason = 'rate_limit_detected';
  f.coordinator.notifyUserMessage = runtime => { assert.equal(runtime, 'claude'); f.calls.notify.push(runtime); return true; };
  f.router.writeNegativeCache('claude', 'rate_limited', 'rate_limit_detected');
  const result = await f.router.route(request());
  assert.deepEqual(f.calls.probes, ['claude']); assert.deepEqual(f.calls.notify, ['claude']);
  assert.equal(result.decision, 'pending'); assert.equal(result.recovered, true); assert.equal(result.userMessage, undefined);
});
test('routes share observer preparation but an absent target is not a failed probe', async t => {
  const resolvers = []; const f = fixture(t);
  const observer = new SupervisorHealthObserver({ coordinator: {
    restore: runtime => new Promise(resolve => resolvers.push({runtime, resolve: () => resolve(f.states[runtime])})),
    readNegativeCache: runtime => f.router.readNegativeCache(runtime),
    registeredAttempt: () => null,
  }, readMode: () => 'multi', listScenes: () => [] });
  f.router.requestProbe = runtime => observer.requestProbe(runtime);
  f.states.claude = { health: 'unavailable', reason: 'heartbeat_timeout', scheduling: {} };
  const pending = [f.router.route(request()), f.router.route(request({ requestId: '2' })), f.router.route(request({ sessionGroup: 'telegram:two', requestId: '3' }))];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(resolvers.map(x => x.runtime).sort(), ['claude', 'codex']);
  resolvers.forEach(x => x.resolve()); await Promise.all(pending);
  assert.equal(fs.existsSync(f.router.cachePath('claude')), false);
  assert.equal(fs.existsSync(f.router.cachePath('codex')), false);
  assert.equal(resolvers.length, 2);
});
test('healthy state clears its own cache and noReply never accelerates', async t => {
  const f = fixture(t); f.router.writeNegativeCache('claude', 'unavailable', 'old'); f.router.writeNegativeCache('codex', 'unavailable', 'heartbeat_timeout');
  const result = await f.router.route(request()); assert.equal(result.decision, 'pending');
  assert.equal(fs.existsSync(f.router.cachePath('claude')), false); assert.equal(fs.existsSync(f.router.cachePath('codex')), true);
  const unavailable = await f.router.route(request({ sessionGroup: 'telegram:two', noReply: true }));
  assert.equal(unavailable.recovered, false); assert.equal(unavailable.userMessage, undefined); assert.deepEqual(f.calls.notify, []);
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
test('successful authentication waits for lifecycle release; uncertain is explicit', async t => {
  const f = fixture(t, { checkAuth: () => ({ status: 'success' }) }); f.states.claude.health = 'auth_failed';
  assert.equal((await f.router.route(request())).decision, 'pending'); assert.equal(f.states.claude.health, 'auth_failed');
  f.router.checkAuth = () => ({ status: 'uncertain', reason: 'not confirmed' });
  assert.equal((await f.router.route(request())).auth.result, 'unconfirmed');
});

test('legacy no-reply routing preserves explicit channels during authentication failure', async t => {
  let checks = 0;
  const f = fixture(t, { checkAuth: () => { checks++; return { status: 'failure', reason: 'not_logged_in' }; } });
  f.states.claude.health = 'auth_failed';
  for (const channel of ['telegram', 'system']) {
    const input = request({ version: 1, channel, noReply: true });
    delete input.componentName;
    const result = await f.router.route(input);
    assert.equal(result.decision, 'auth_rejected');
    assert.equal(result.auth.result, 'failed');
  }
  assert.equal(checks, 2);
  const input = request({ version: 1, channel: null, noReply: true });
  delete input.componentName;
  assert.equal((await f.router.route(input)).decision, 'pending');
  assert.equal(checks, 2);
});

test('authentication notification holds during transition and rejects invalid runtime before recovery', async t => {
  const f = fixture(t, { getModeTransition: () => ({ phase: 'gating' }) });
  f.states.claude.health = 'unavailable';
  const input = { version: 1, type: 'auth_completed', requestId: 'auth', runtime: 'claude' };
  await f.router.notifyAuthCompleted(input);
  assert.deepEqual(f.calls.notify, []); assert.deepEqual(f.calls.probes, []);
  await assert.rejects(f.router.notifyAuthCompleted({ ...input, runtime: '../invalid' }), { code: 'invalid_request' });
});

test('authentication without a ready scene leaves a user-message launch available and queues no probe', async t => {
  const f = fixture(t), now = 1792000000000;
  const coordinator = new RuntimeHealthCoordinator({ zylosDir: f.cacheDirectory, now: () => now,
    readMode: () => 'multi', resolveTargetRuntime: () => 'claude', listScenes: () => [] });
  const store = coordinator.store('claude'), state = store.read();
  state.health = 'unavailable';
  Object.assign(state.scheduling, { restartFailureCount: 3, lastRecoveryAt: now / 1000 - 1 });
  store.write(state);
  let controls = 0;
  const observer = new SupervisorHealthObserver({ coordinator, now: () => now,
    readMode: () => 'multi', listScenes: () => [], insertControl: () => { controls++; } });
  t.after(() => observer.shutdown());
  f.router.healthCoordinator = coordinator; f.router.now = () => now;
  f.router.requestProbe = runtime => observer.requestProbe(runtime);
  await f.router.notifyAuthCompleted({ version: 1, type: 'auth_completed', requestId: 'auth', runtime: 'claude' });
  assert.equal(controls, 0); assert.equal(observer.probes.size, 0);
  assert.equal(f.router.readNegativeCache('claude'), null);
  assert.equal(store.read().scheduling.lastUserMessageRecoveryAt, now / 1000);
  const launch = await coordinator.registerStartAttempt({ version: 1, type: 'start_attempt', requestId: 'sa-1-0123456789ab',
    runtime: 'claude', sessionGroup: 'telegram:waiting', runId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(launch.ok, true); assert.equal(launch.reason, 'user_message');
});

test('authentication recovery uses the existing observer to prefer a ready Origin of the same runtime', async t => {
  const f = fixture(t), now = 1792000000000, controls = [];
  const scenes = [
    { sessionGroup: 'telegram:other', runtime: 'codex', ready: true, present: true, runId: 'other' },
    { sessionGroup: 'telegram:starting', runtime: 'claude', ready: false, present: true, runId: 'starting' },
    { sessionGroup: 'telegram:one', runtime: 'claude', ready: true, present: true, runId: 'chat', sessionId: 'chat-session' },
    { sessionGroup: 'origin', runtime: 'claude', ready: true, present: true, runId: 'origin-run', sessionId: 'origin-session' },
  ];
  const coordinator = new RuntimeHealthCoordinator({ zylosDir: f.cacheDirectory, now: () => now,
    readMode: () => 'multi', resolveTargetRuntime: () => 'claude', listScenes: () => scenes });
  const store = coordinator.store('claude'), state = store.read(); state.health = 'unavailable'; store.write(state);
  const observer = new SupervisorHealthObserver({ coordinator, now: () => now, readMode: () => 'multi', listScenes: () => scenes,
    readIdentity: group => scenes.find(scene => scene.sessionGroup === group),
    buildTargetBinding: scene => ({ runId: scene.runId }), readState: () => ({ state: 'idle', tools: [] }), readScreen: () => 'healthy',
    insertControl: (content, options) => { controls.push({ id: controls.length + 1, content, ...options, status: 'done' }); return controls.at(-1); },
    getControlById: id => controls[id - 1] });
  t.after(() => observer.shutdown());
  f.router.healthCoordinator = coordinator; f.router.now = () => now;
  f.router.requestProbe = runtime => observer.requestProbe(runtime);
  const pending = f.router.notifyAuthCompleted({ version: 1, type: 'auth_completed', requestId: 'auth', runtime: 'claude' });
  for (let i = 0; i < 30 && !controls.length; i++) await new Promise(resolve => setImmediate(resolve));
  await Promise.all([...observer.preparations]);
  assert.equal(controls.length, 1); assert.equal(controls[0].sessionGroup, 'origin');
  assert.equal(controls[0].targetBinding.runId, 'origin-run');
  await observer.pollProbe(observer.probes.get('claude'));
  await pending;
  assert.equal(store.read().health, 'ok');
});

// real input acceleration must remain usable by the next dispatcher scheduling round.
test('absent recovery target leaves accelerated admission uncached; completed failure still caches', async t => {
  for (const accelerated of [false, true]) {
    const f = fixture(t); f.states.claude.health = 'unavailable';
    f.coordinator.notifyUserMessage = () => accelerated;
    const observer = new SupervisorHealthObserver({ coordinator: {
      restore: () => f.states.claude, readNegativeCache: () => null, registeredAttempt: () => null,
    }, readMode: () => 'multi', listScenes: () => [] });
    t.after(() => observer.shutdown());
    f.router.requestProbe = runtime => observer.requestProbe(runtime);
    const absent = await f.router.route(request());
    assert.equal(absent.recovered, false);
    assert.equal(f.router.readNegativeCache('claude'), null, 'no target means no probe result to cache');
    f.router.requestProbe = async () => ({ recovered: false, classification: 'other' });
    await f.router.route(request());
    assert.equal(f.router.readNegativeCache('claude').health, 'unavailable');
    f.coordinator.notifyUserMessage = () => false;
    assert.equal((await f.router.route(request())).cacheHit, true);
  }
});

for (const terminal of ['failed', 'timeout']) test(`actual observer ${terminal} control result caches, while no target queues no control`, async t => {
  const f = fixture(t), now = 1792000000000, controls = [];
  let scenes = [];
  const coordinator = new RuntimeHealthCoordinator({ zylosDir: f.cacheDirectory, now: () => now,
    readMode: () => 'multi', resolveTargetRuntime: () => 'claude', listScenes: () => scenes });
  const state = coordinator.store('claude').read(); state.health = 'unavailable';
  coordinator.store('claude').write(state);
  const observer = new SupervisorHealthObserver({ coordinator, now: () => now,
    readMode: () => 'multi', listScenes: () => scenes,
    readIdentity: group => scenes.find(scene => scene.sessionGroup === group),
    readState: () => ({ state: 'idle', tools: [] }), readScreen: () => 'injected failed runtime response', matchScreen: () => ({}),
    buildTargetBinding: scene => ({ runId: scene.runId }),
    insertControl: (content, options) => {
      controls.push({ id: controls.length + 1, content, ...options, status: 'pending' }); return controls.at(-1);
    }, getControlById: id => controls[id - 1] });
  t.after(() => observer.shutdown());
  coordinator.probeInFlight = runtime => observer.probeInFlight(runtime);
  f.router.healthCoordinator = coordinator; f.router.now = () => now;
  f.router.requestProbe = runtime => observer.requestProbe(runtime);
  for (let i = 0; i < 2; i++) {
    const absent = await f.router.route(request({ noReply: true }));
    assert.equal(absent.recovered, false); assert.equal(Object.hasOwn(absent, 'noTarget'), false);
    assert.equal(controls.length, 0); assert.equal(observer.probes.size, 0);
    assert.equal(f.router.readNegativeCache('claude'), null);
  }
  scenes = [{ sessionGroup: 'telegram:one', runId: 'probe-run', runtime: 'claude',
    sessionId: 'probe-session', present: true, ready: true }];
  const pending = f.router.route(request({ noReply: true }));
  for (let i = 0; i < 20 && controls.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  await Promise.all([...observer.preparations]);
  assert.equal(controls.length, 1); assert.equal(controls[0].targetBinding.runId, 'probe-run');
  controls[0].status = terminal;
  await observer.pollProbe(observer.probes.get('claude'));
  assert.equal((await pending).recovered, false);
  assert.equal(coordinator.store('claude').read().scheduling.restartFailureCount, 1, 'actual terminal result reached the health coordinator');
  const cache = f.router.readNegativeCache('claude');
  assert.equal(cache.health, 'unavailable'); assert.equal(cache.recovered, false);
  assert.equal(cache.expiresAt, now + 30000);
  assert.equal((await f.router.route(request({ noReply: true }))).cacheHit, true);
  assert.equal(controls.length, 1, 'cached failure must not enqueue another observer control');
  await observer.shutdown();
});
