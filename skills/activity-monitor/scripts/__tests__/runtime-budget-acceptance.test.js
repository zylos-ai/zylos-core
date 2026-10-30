import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator, recoveryEligibility } from '../runtime-health.js';
import { MessageRouter } from '../message-router.js';

const T = 1792000000;
function registered(reply) {
  assert.equal(reply.result, 'registered');
  assert.equal(Object.hasOwn(reply, 'attemptCount'), false);
  assert.equal(Object.hasOwn(reply, 'attemptAt'), false);
}
function schedulingValues(state) {
  const s = state.scheduling;
  return [s.restartFailureCount, s.lastRecoveryAt, s.lastDownCheckAt];
}

function fixture(t, Coordinator = RuntimeHealthCoordinator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = T * 1000, scenes = [], probe = false, cache = null, writes = 0;
  const health = new Coordinator({ zylosDir: root, now: () => clock, readMode: () => 'multi',
    resolveTargetRuntime: () => 'claude', listScenes: () => scenes, probeInFlight: () => probe,
    readNegativeCache: () => cache });
  const store = health.store('claude'), originalWrite = store.write.bind(store);
  store.write = state => { writes++; return originalWrite(state); };
  const set = (healthValue, budget = {}) => {
    const state = store.read(); state.health = healthValue; state.reason = healthValue === 'rate_limited' ? 'rate_limit_unclassified' : 'runtime_unavailable';
    Object.assign(state.scheduling, { restartFailureCount: 1, lastRecoveryAt: T, lastUserMessageRecoveryAt: 0, lastDownCheckAt: 0, cooldownUntil: 0 }, budget);
    store.write(state); writes = 0;
  };
  set('unavailable');
  return { root, health, store, set, read: () => store.read(), writes: () => writes,
    clock: seconds => { clock = seconds * 1000; }, scenes: value => { scenes = value; }, probe: value => { probe = value; }, cache: value => { cache = value; },
    request: () => ({ version: 1, type: 'start_attempt', requestId: `sa-${clock}-123456789abc`, runtime: 'claude', sessionGroup: 'telegram:one', runId: randomUUID() }) };
}
function budget(f) { const s = f.read().scheduling; return [s.restartFailureCount, s.lastRecoveryAt]; }
function result(request, extra = {}) { return { runtime: 'claude', runId: request.runId, current: { ...request }, terminal: 'timeout', ...extra }; }

test('registration survives observed appearance, READY, exit', async t => {
  const f = fixture(t); f.clock(T + 60); const request = f.request();
  registered(await f.health.registerStartAttempt(request));assert.deepEqual(schedulingValues(f.read()), [2, T + 60, 0]);
  const before = fs.readFileSync(f.store.file, 'utf8');
  for (const ready of [false, true]) {
    f.scenes([{ ...request, ready }]);
    assert.equal((await f.health.registerStartAttempt(f.request())).code, 'scene_present');
    assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
  }
  f.scenes([]); await f.health.noteRunExited('claude', request.runId);
  assert.deepEqual(budget(f), [2, T + 60]);
  f.clock(T + 359); assert.equal((await f.health.registerStartAttempt(f.request())).notBefore, (T + 360) * 1000);
  f.clock(T + 360); registered(await f.health.registerStartAttempt(f.request()));assert.deepEqual(schedulingValues(f.read()), [3, T + 360, 0]);
});

async function linkedSequence(t, Coordinator) {
  const f = fixture(t, Coordinator); f.clock(T + 60); const request = f.request();
  await f.health.registerStartAttempt(request); f.clock(T + 61);
  await f.health.applyProbeResult(result(request)); assert.deepEqual(budget(f), [2, T + 61]);
  f.clock(T + 62); const origin = { ...request, sessionGroup: 'origin', runId: randomUUID() };
  await f.health.applyProbeResult(result(origin)); assert.deepEqual(budget(f), [3, T + 62]);
  const auth = fixture(t, Coordinator); auth.clock(T + 60); const authRequest = auth.request();
  await auth.health.registerStartAttempt(authRequest); auth.clock(T + 61);
  await auth.health.applyProbeResult(result(authRequest, { matches: { authFailure: { detected: true } } }));
  assert.equal(auth.read().health, 'auth_failed'); assert.deepEqual(budget(auth), [2, T + 60]);
}
test('exact bound/Origin/auth rows', async t => {
  await linkedSequence(t, RuntimeHealthCoordinator);
});

async function lostReplySequence(t, Coordinator) {
  const f = fixture(t, Coordinator); f.clock(T + 60); const r1 = f.request();
  await f.health.registerStartAttempt(r1); // reply is deliberately not used to launch
  f.scenes([{ runtime: 'claude', sessionGroup: 'origin', runId: randomUUID(), ready: true }]);
  const r2 = { ...r1, runId: randomUUID() }; f.clock(T + 61);
  const before = fs.readFileSync(f.store.file, 'utf8');
  await f.health.applyProbeResult(result(r2, { current: { ...r2, runId: randomUUID() } }));
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
  await f.health.applyProbeResult(result(r2)); assert.deepEqual(budget(f), [3, T + 61]);
  assert.equal(f.health.associations.get('claude').runId, r1.runId);
}
test('lost reply, unregistered same-group and stale identity', async t => {
  await lostReplySequence(t, RuntimeHealthCoordinator);
});

async function accelerationSequences(t, Coordinator) {
  const down = fixture(t, Coordinator); down.set('down', { restartFailureCount: 2, lastDownCheckAt: T }); down.clock(T + 3600);
  const reply = await down.health.registerStartAttempt(down.request());
  registered(reply);assert.deepEqual(schedulingValues(down.read()), [2, T, T + 3600]);
  const unavailable = fixture(t, Coordinator); unavailable.set('unavailable', { restartFailureCount: 3 }); unavailable.clock(T + 1);
  await unavailable.health.notifyUserMessage('claude'); assert.deepEqual(budget(unavailable), [0, 0]);
  registered(await unavailable.health.registerStartAttempt(unavailable.request()));assert.deepEqual(schedulingValues(unavailable.read()), [1, T + 1, 0]);
  const limited = fixture(t, Coordinator); limited.set('rate_limited', { restartFailureCount: 3, cooldownUntil: T + 500 }); limited.clock(T + 1);
  await limited.health.notifyUserMessage('claude'); assert.deepEqual(budget(limited), [3, T]);
  assert.equal(limited.read().scheduling.cooldownUntil, 0); assert.equal(limited.read().scheduling.lastUserMessageRecoveryAt, T + 1);
  registered(await limited.health.registerStartAttempt(limited.request()));assert.deepEqual(schedulingValues(limited.read()), [4, T + 1, 0]);
}
test('down, unavailable and rate-message budget sequences', async t => {
  await accelerationSequences(t, RuntimeHealthCoordinator);
});

async function cacheSequence(t, Router) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-acceptance-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = T * 1000;
  const router = new Router({ healthCoordinator: {}, resolveTargetRuntime: () => 'claude', cacheDirectory: root, now: () => now });
  router.writeNegativeCache('claude', 'unavailable', 'runtime_unavailable');
  const before = fs.readFileSync(router.cachePath('claude'), 'utf8');
  router.writeNegativeCache('codex', 'unavailable', 'runtime_unavailable'); router.clearCache('codex');
  assert.equal(fs.readFileSync(router.cachePath('claude'), 'utf8'), before);
  const legacy = path.join(root, 'legacy.json'); fs.writeFileSync(legacy, JSON.stringify({ version: 1, recovered: false, expiresAt: now + 999999 }));
  router.clearLegacyCache(legacy); assert.equal(fs.existsSync(legacy), false);
  const f = router.cachePath('claude'); const current = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(current), version: 1 }));
  const eligible=()=>recoveryEligibility({health:'unavailable',reason:'runtime_unavailable'},
    {runtime:'claude',cache:router.readNegativeCache('claude'),nowMs:now});
  assert.equal(eligible().eligible,true);
  fs.writeFileSync(f, current); now += 29999; assert.equal(eligible().code,'probe_cache');
  now++; assert.equal(eligible().eligible,true);
}
test('runtime cache bytes, v1 rejection/removal, exact expiry and shared-path control', async t => {
  await cacheSequence(t, MessageRouter);
  class Bad extends MessageRouter { cachePath() { return path.join(this.cacheDirectory, 'shared.json'); } }
  await assert.rejects(cacheSequence(t, Bad), { code: 'ENOENT' });
});

// A: ordered predicates, exact reply fields, and file side effects. Socket
// framing/invalid JSON is covered separately by supervisor-request/socket tests.
test('A exact decision rows, missing/unreadable and no writes', async t => {
  const cases = [
    ['ok', 'ok', {}, T, 'not_restricted'],
    ['auth', 'auth_failed', {}, T, 'auth_blocked'],
    ['cooldown', 'rate_limited', { cooldownUntil: T + 1 }, T, 'rate_limit_cooldown', (T + 1) * 1000],
    ['cooldown-equal', 'rate_limited', { cooldownUntil: T + 60 }, T + 60, 'registered'],
    ['backoff-59', 'unavailable', {}, T + 59, 'attempt_backoff', (T + 60) * 1000],
    ['backoff-60', 'unavailable', {}, T + 60, 'registered'],
    ['down-3599', 'down', { lastDownCheckAt: T }, T + 3599, 'down_retry_interval', (T + 3600) * 1000],
    ['down-3600', 'down', { lastDownCheckAt: T }, T + 3600, 'registered'],
    ['same-second', 'unavailable', { lastUserMessageRecoveryAt: T }, T, 'attempt_backoff', (T + 60) * 1000],
    ['accelerated', 'unavailable', { lastUserMessageRecoveryAt: T + 1 }, T + 1, 'registered'],
  ];
  for (const [label, healthValue, scheduling, now, code, notBefore] of cases) {
    const f = fixture(t); f.set(healthValue, scheduling); f.clock(now); const request = f.request();
    const cacheDir = path.join(f.root, 'activity-monitor', 'message-router-probe-cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const f11 = path.join(cacheDir, 'claude.json'); fs.writeFileSync(f11, 'sentinel: never modified');
    const bytes = fs.readFileSync(f.store.file, 'utf8'); const reply = await f.health.registerStartAttempt(request);
    const envelope = { version: 1, type: 'start_attempt', requestId: request.requestId };
    if (code === 'registered') {
      assert.deepEqual(reply, { ...envelope, ok: true, result: 'registered', reason: label === 'accelerated' ? 'user_message' : 'recovery_due' }, label);
      registered(reply);
      assert.deepEqual(schedulingValues(f.read()), healthValue === 'down' ? [1, T, now] : [2, now, 0], label);
      assert.equal(f.writes(), 1, label); assert.equal(f.read().health, healthValue, label);
    } else {
      assert.deepEqual(reply, code === 'not_restricted' ? { ...envelope, ok: true, result: code } : { ...envelope, ok: false, code, ...(notBefore === undefined ? {} : { notBefore }) }, label);
      assert.equal(f.writes(), 0, label); assert.equal(fs.readFileSync(f.store.file, 'utf8'), bytes, label);
    }
    assert.equal(fs.readFileSync(f11, 'utf8'), 'sentinel: never modified', label);
  }
  for (const missing of [true, false]) {
    const f = fixture(t); if (missing) fs.unlinkSync(f.store.file); else fs.writeFileSync(f.store.file, '{bad');
    const request = f.request(); const reply = await f.health.registerStartAttempt(request);
    assert.deepEqual(reply, { version: 1, type: 'start_attempt', requestId: request.requestId, ok: true, result: 'not_restricted' });
    assert.equal(f.writes(), 0);
    if (!missing) {
      const quarantined = fs.readdirSync(path.dirname(f.store.file)).filter(name => name.startsWith('claude.json.corrupt-'));
      assert.equal(quarantined.length, 1); assert.equal(fs.readFileSync(path.join(path.dirname(f.store.file), quarantined[0]), 'utf8'), '{bad');
    }
  }
});

async function sameSecond(t, Coordinator) {
  const f = fixture(t, Coordinator); f.set('unavailable', { lastUserMessageRecoveryAt: T });
  const reply = await f.health.registerStartAttempt(f.request()); assert.equal(reply.code, 'attempt_backoff'); assert.equal(f.writes(), 0);
}
async function probeFields(t, Coordinator) {
  const f = fixture(t, Coordinator); f.probe(true);
  const reply = await f.health.registerStartAttempt(f.request()); assert.equal(reply.code, 'probe_inflight'); assert.equal(Object.hasOwn(reply, 'notBefore'), false);
}
async function failedPublish(t, Coordinator) {
  const f = fixture(t, Coordinator); f.clock(T + 60); const bytes = fs.readFileSync(f.store.file, 'utf8');
  f.store.write = () => { throw Object.assign(new Error('rename failed'), { code: 'EACCES' }); };
  const reply = await f.health.registerStartAttempt(f.request()); assert.equal(reply.code, 'health_write_failed');
  assert.equal(fs.readFileSync(f.store.file, 'utf8'), bytes); assert.equal(f.health.associations.size, 0);
}
test('detects same-second acceleration, probe notBefore and false registration on publication failure', async t => {
  await sameSecond(t, RuntimeHealthCoordinator); await probeFields(t, RuntimeHealthCoordinator); await failedPublish(t, RuntimeHealthCoordinator);
});
