import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { SupervisorHealthObserver } from '../supervisor-health-observer.js';

// actual observer/coordinator; injected runtime screen and control
// acknowledgements. No model API, real quota, dispatcher process or tmux is involved.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rate-probe-')));
  let now = 1800000000000, matches = {}, coordinator, observer;
  let scenes = [{ sessionGroup: 'telegram:a', runtime: 'codex', runId: randomUUID(),
    sessionId: 'session-a', present: true, ready: true }];
  const controls = [];
  const reopen = async () => {
    await observer?.shutdown();
    coordinator = new RuntimeHealthCoordinator({ zylosDir: root, now: () => now,
      readMode: () => 'multi', resolveTargetRuntime: () => 'codex', listScenes: () => scenes });
    observer = new SupervisorHealthObserver({ coordinator, now: () => now, readMode: () => 'multi',
      listScenes: () => scenes, readIdentity: group => scenes.find(scene => scene.sessionGroup === group),
      readState: () => ({ tools: [] }), readScreen: () => 'injected runtime response', matchScreen: () => matches,
      buildTargetBinding: scene => ({ runId: scene.runId }),
      insertControl: (content, opts) => { controls.push({ id: controls.length + 1, content, ...opts, status: 'pending' }); return controls.length; },
      getControlById: id => controls[id - 1] });
    coordinator.probeInFlight = runtime => observer.probeInFlight(runtime);
    await coordinator.restore('codex');
  };
  t.after(async () => { await observer?.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const probe = async ({ terminal = 'failed', force = false, evidence = {} } = {}) => {
    matches = evidence;
    const result = observer.requestProbe('codex', { force });
    await Promise.all([...observer.preparations]);
    const pending = observer.probes.get('codex');
    assert.ok(pending?.controlId, 'probe inserted a real observer control');
    controls[pending.controlId - 1].status = terminal;
    await observer.pollProbe(pending);
    return result;
  };
  return { reopen, probe, controls, health: () => coordinator.store('codex').read(),
    get coordinator() { return coordinator; }, get observer() { return observer; },
    now: () => now, advance: ms => { now += ms; }, setScenes: value => { scenes = value; },
    newScene: () => { scenes = [{ sessionGroup: 'telegram:b', runtime: 'codex', runId: randomUUID(), sessionId: 'session-b', present: true, ready: true }]; } };
}

async function verifyRateRecovery(t, { expired }) {
  const f = fixture(t); await f.reopen();
  const cooldown = f.now() / 1000 + 60;
  assert.equal((await f.probe({ force: true, evidence: { rateLimit: { detected: true, cooldownUntil: cooldown } } })).classification, 'rate_limited');
  assert.equal(f.health().rateLimitActive, true);
  assert.equal(f.health().scheduling.cooldownUntil, cooldown);
  if (expired) {
    // The wall clock reaches the boundary; requestProbe -> due -> restore must
    // publish zero itself before the auth result. Do not seed cooldown=0.
    f.advance(60000);
  } else {
    const before = f.controls.length;
    assert.equal((await f.observer.requestProbe('codex')).recovered, false);
    assert.equal(f.controls.length, before, 'normal demand respects future cooldown');
  }
  const expectedCooldown = expired ? 0 : cooldown;
  assert.equal((await f.probe({ force: !expired, evidence: { authFailure: { detected: true } } })).classification, 'auth_error');
  assert.equal(f.health().health, 'auth_failed');
  assert.equal(f.health().rateLimitActive, true);
  assert.equal(f.health().scheduling.cooldownUntil, expectedCooldown);
  await f.reopen();
  assert.equal(f.health().health, 'auth_failed');
  assert.equal(f.health().rateLimitActive, true);
  assert.equal(f.health().scheduling.cooldownUntil, expectedCooldown);
  f.setScenes([]); // auth release is allowed only after the old runtime is gone.
  assert.equal(await f.coordinator.beginAuthRecovery('codex', { status: 'success' }, []), true);
  assert.equal(await f.coordinator.completeAuthRecovery('codex', { isGone: () => true }), true);
  assert.equal(f.health().health, 'rate_limited', 'auth success cannot clear independent rate limit');
  assert.equal(f.health().rateLimitActive, true);
  assert.equal(f.health().scheduling.cooldownUntil, expectedCooldown);
  f.newScene();
  if (!expired) {
    const before = f.controls.length;
    assert.equal((await f.observer.requestProbe('codex')).recovered, false);
    assert.equal(f.controls.length, before);
    f.advance(60000);
  }
  assert.equal((await f.probe({ terminal: 'done' })).recovered, true);
  assert.equal(f.health().health, 'ok'); assert.equal(f.health().rateLimitActive, false);
  assert.equal(f.health().scheduling.cooldownUntil, 0);
}

for (const expired of [false, true]) test(`injected rate limit, ${expired ? 'probe-driven zero' : 'future cooldown'}, auth restart/release, then successful probe`, async t => {
  await verifyRateRecovery(t, { expired });
});

test('no independent rate limit: auth restart/release returns directly to ok', async t => {
  const f = fixture(t); await f.reopen();
  assert.equal((await f.probe({ force: true, evidence: { authFailure: { detected: true } } })).classification, 'auth_error');
  assert.equal(f.health().rateLimitActive, false); await f.reopen();
  assert.equal(f.health().health, 'auth_failed'); assert.equal(f.health().rateLimitActive, false);
  f.setScenes([]);
  assert.equal(await f.coordinator.beginAuthRecovery('codex', { status: 'success' }, []), true);
  assert.equal(await f.coordinator.completeAuthRecovery('codex', { isGone: () => true }), true);
  assert.equal(f.health().health, 'ok'); assert.equal(f.health().rateLimitActive, false);
  assert.equal(f.health().scheduling.cooldownUntil, 0);
});
