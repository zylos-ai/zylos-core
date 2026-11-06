import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { SupervisorHealthObserver } from '../supervisor-health-observer.js';

const WAIT_MS = 30 * 60 * 1000;

// Real observer, coordinator and health files; screen, activity and C4 rows are
// bounded in-memory inputs. No dispatcher, model API, tmux or service is used.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-busy-'));
  let now = 1800000000000, mode = 'multi', transition = null, matches = {};
  let scenes = [], nextId = 1;
  const activity = new Map(), controls = [], stops = [], fences = new Set(), errors = [];
  const coordinator = new RuntimeHealthCoordinator({ zylosDir: root, now: () => now,
    readMode: () => mode, resolveTargetRuntime: () => 'claude', listScenes: () => scenes });
  const observer = new SupervisorHealthObserver({ coordinator, now: () => now,
    readMode: () => mode, listScenes: () => scenes,
    readIdentity: group => scenes.find(scene => scene.sessionGroup === group),
    readState: scene => activity.get(scene.runId), readScreen: () => '', matchScreen: () => matches,
    getModeTransition: () => transition, getDrainFence: group => fences.has(group),
    buildTargetBinding: scene => ({ runId: scene.runId }),
    insertControl: (content, options) => {
      const row = { id: nextId++, content, ...options, status: 'pending' };
      controls.push(row); return row;
    },
    getControlById: id => controls.find(row => row.id === id),
    stop: scene => { stops.push(scene); return true; }, log: error => errors.push(error) });
  coordinator.probeInFlight = runtime => observer.probeInFlight(runtime);
  t.after(async () => { await observer.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const setHealth = (health, budget = {}) => {
    const state = coordinator.store('claude').read();
    state.health = health; state.reason = ''; Object.assign(state.scheduling, budget);
    coordinator.store('claude').write(state);
  };
  setHealth('unavailable');
  const state = (scene, value = {}) => activity.set(scene.runId, {
    state: value.tools?.length ? 'busy' : 'idle', sessionId: scene.sessionId,
    lastActivityAt: now - 5000, transcriptMtimeMs: null, idleSince: now - 2000, events: [],
    healthIdentity: { session_id: scene.sessionId, claude_pid: 42 }, ...value,
    tools: (value.tools ?? []).map(tool => ({ name: 'Bash', startedAt: now, input: {}, ...tool })) });
  const add = (group, value = {}) => {
    const scene = { sessionGroup: group, runtime: 'claude', runId: randomUUID(),
      sessionId: randomUUID(), ready: true, present: true, processRunning: true };
    scenes.push(scene); state(scene, value); return scene;
  };
  const prepare = async (options) => {
    const result = observer.requestProbe('claude', options);
    await Promise.all([...observer.preparations]);
    assert.equal(errors.length, 0);
    return { result, probe: observer.probes.get('claude'), row: controls.at(-1) };
  };
  return { root, coordinator, observer, controls, stops, fences, add, state, setHealth, prepare,
    now: () => now, advance: ms => { now += ms; },
    scenes: () => scenes, setScenes: value => { scenes = value; }, setMode: value => { mode = value; },
    setTransition: value => { transition = value; }, setMatches: value => { matches = value; },
    health: () => coordinator.store('claude').read(),
    bytes: () => fs.readFileSync(coordinator.store('claude').file, 'utf8'),
    reconcile: (demand = new Map([['claude', new Set(['telegram:a'])]])) => observer.reconcileRecoveryWaits(demand, scenes),
    waitAt: () => observer.recoveryWaits.get('claude') };
}

async function terminal(f, pending, status = 'timeout', elapsed = 120000) {
  f.advance(elapsed); pending.row.status = status; await f.observer.tick(); return pending.result;
}

test('idle ordinary scene precedes busy Origin, including activity without tools', async t => {
  const f = fixture(t);
  f.add('origin', { state: 'busy', tools: [] });
  const idle = f.add('telegram:z');
  const p = await f.prepare();
  assert.equal(p.row.sessionGroup, idle.sessionGroup);
  assert.equal(p.row.targetBinding.runId, idle.runId);
  assert.equal(p.row.priority, 0); assert.equal(p.row.bypassState, true);
  assert.equal(p.row.ackDeadlineAt, f.now() / 1000 + 120);
});

test('Origin precedes other idle scenes and ordinary groups retain stable order', async t => {
  for (const origin of [true, false]) await t.test(String(origin), async t => {
    const f = fixture(t); f.add('telegram:z'); f.add('telegram:a'); if (origin) f.add('origin');
    const p = await f.prepare(); assert.equal(p.row.sessionGroup, origin ? 'origin' : 'telegram:a');
  });
});

for (const health of ['rate_limited', 'unavailable', 'recovering', 'down']) {
  test(`${health} waits for idle without inserting controls or changing health and association`, async t => {
    const f = fixture(t); f.setHealth(health);
    const scene = f.add('origin', { state: 'busy', tools: [{ id: 'foreground', name: 'Bash', startedAt: f.now() }] });
    const linked = { sessionGroup: scene.sessionGroup, runId: scene.runId };
    f.coordinator.associations.set('claude', linked);
    const before = f.bytes(), started = f.now();
    assert.equal((await (await f.prepare()).result).noTarget, true);
    f.advance(10000); assert.equal((await (await f.prepare()).result).noTarget, true);
    assert.equal(f.waitAt(), started); assert.equal(f.controls.length, 0);
    assert.equal(f.bytes(), before); assert.equal(f.coordinator.associations.get('claude'), linked);
    assert.equal(f.stops.length, 0);
    f.state(scene); const pending = await f.prepare();
    assert.equal(f.controls.length, 1); assert.equal(pending.row.targetBinding.runId, scene.runId);
    assert.equal((await terminal(f, pending, 'done', 1000)).recovered, true);
    assert.equal(f.health().health, 'ok'); assert.equal(f.waitAt(), undefined);
  });
}

test('activity becoming busy during binding is rechecked before insertion', async t => {
  const f = fixture(t), scene = f.add('origin');
  f.observer.buildTargetBinding = value => { f.state(scene, { state: 'busy' }); return { runId: value.runId }; };
  const p = await f.prepare(); assert.equal((await p.result).noTarget, true);
  assert.equal(f.controls.length, 0); assert.equal(f.waitAt(), f.now());
});

test('tools observed after insertion remain evidence after completion and retry uses a fresh heartbeat', async t => {
  const f = fixture(t), scene = f.add('origin');
  f.coordinator.associations.set('claude', { sessionGroup: scene.sessionGroup, runId: scene.runId });
  const first = await f.prepare(), sentAt = f.now();
  f.advance(1000); f.state(scene, { tools: [{ id: 'foreground', name: 'Bash', startedAt: f.now() }] });
  await f.observer.tick();
  f.advance(1000); f.state(scene); await f.observer.tick();
  const before = f.bytes(); first.row.status = 'timeout'; f.advance(118000); await f.observer.tick();
  assert.deepEqual(await first.result, { recovered: false, waiting: true });
  assert.equal(f.bytes(), before); assert.equal(f.stops.length, 0); assert.equal(f.waitAt(), sentAt);
  assert.equal(f.coordinator.associations.get('claude').runId, scene.runId);
  const second = await f.prepare(); assert.notEqual(second.row.id, first.row.id);
  assert.equal(first.row.status, 'timeout');
  assert.equal((await terminal(f, second, 'done', 1000)).recovered, true);
  assert.equal(f.coordinator.associations.has('claude'), false);
});

test('waiting after paste retains the earliest runtime waiting time', async t => {
  const f = fixture(t), scene = f.add('origin', { state: 'busy' });
  await (await f.prepare()).result; const started = f.waitAt();
  f.advance(60000); f.state(scene); const p = await f.prepare();
  f.state(scene, { tools: [{ id: 'foreground' }] }); await f.observer.tick();
  assert.equal((await terminal(f, p)).waiting, true); assert.equal(f.waitAt(), started);
});

test('only timeout with tools observed within the acknowledgement window defers a result', async t => {
  for (const kind of ['no-tools', 'late-tools', 'early-timeout', 'failed', 'cancelled']) {
    await t.test(kind, async t => {
      const f = fixture(t), scene = f.add('origin'), p = await f.prepare();
      if (kind !== 'no-tools') {
        f.advance(kind === 'late-tools' ? 120001 : 1000);
        f.state(scene, { tools: [{ id: 'foreground' }] }); await f.observer.tick();
      }
      p.row.status = ['failed', 'cancelled'].includes(kind) ? kind : 'timeout';
      if (kind !== 'early-timeout') f.advance(Math.max(0, p.probe.deadline - f.now()));
      await f.observer.tick(); assert.equal((await p.result).classification, 'other');
      assert.equal(f.health().health, 'unavailable'); assert.equal(f.stops.length, 1);
      assert.equal(f.waitAt(), undefined);
    });
  }
});

test('acknowledgement and error text take priority over the tools waiting marker', async t => {
  for (const kind of ['done', 'rate', 'auth', 'rate-and-auth']) await t.test(kind, async t => {
    const f = fixture(t), scene = f.add('origin'), p = await f.prepare();
    f.state(scene, { tools: [{ id: 'foreground' }] }); await f.observer.tick();
    f.setMatches({ rateLimit: { detected: kind.includes('rate') }, authFailure: { detected: kind.includes('auth') } });
    const answer = await terminal(f, p, kind === 'done' ? 'done' : 'timeout');
    assert.equal(answer.classification, kind === 'done' ? 'ok' : kind.includes('rate') ? 'rate_limited' : 'auth_error');
    assert.equal(f.stops.length, 0); assert.equal(f.waitAt(), undefined);
  });
});

test('thirty minute fallback keeps idle first and Origin first within busy candidates', async t => {
  for (const idle of [false, true]) await t.test(String(idle), async t => {
    const f = fixture(t); f.add('telegram:z', { state: 'busy' });
    const ordinary = f.add('telegram:a', { state: 'busy' }); f.add('origin', { state: 'busy' });
    await (await f.prepare()).result; f.advance(WAIT_MS - 1);
    await (await f.prepare()).result; assert.equal(f.controls.length, 0);
    f.advance(1); if (idle) f.state(ordinary);
    const p = await f.prepare(); assert.equal(p.row.sessionGroup, idle ? 'telegram:a' : 'origin');
    assert.equal(p.row.ackDeadlineAt, f.now() / 1000 + 120);
    f.state(f.scenes().find(s => s.runId === p.probe.scene.runId), { tools: [{ id: 'foreground' }] });
    await f.observer.tick(); assert.equal((await terminal(f, p)).classification, 'other');
    assert.equal(f.stops.length, 1); assert.equal(f.stops[0].runId, p.probe.scene.runId);
    assert.equal(f.waitAt(), undefined);
  });
});

test('forced busy fallback still classifies rate and authentication without stopping', async t => {
  for (const kind of ['rate', 'auth']) await t.test(kind, async t => {
    const f = fixture(t); f.add('origin', { tools: [{ id: 'foreground' }] });
    await (await f.prepare()).result; f.advance(WAIT_MS); const p = await f.prepare();
    f.setMatches(kind === 'rate' ? { rateLimit: { detected: true } } : { authFailure: { detected: true } });
    assert.equal((await terminal(f, p)).classification, kind === 'rate' ? 'rate_limited' : 'auth_error');
    assert.equal(f.stops.length, 0); assert.equal(f.waitAt(), undefined);
  });
});

test('crossing thirty minutes during an already sent probe does not retroactively force it', async t => {
  const f = fixture(t), scene = f.add('origin', { state: 'busy' });
  await (await f.prepare()).result; const started = f.waitAt();
  f.advance(WAIT_MS - 60000); f.state(scene); const p = await f.prepare();
  f.state(scene, { tools: [{ id: 'foreground' }] }); await f.observer.tick();
  assert.equal((await terminal(f, p)).waiting, true); assert.equal(f.waitAt(), started);
  assert.equal(f.stops.length, 0);
});

test('thirty minute fallback does not bypass cooldown, attempt backoff or negative cache', async t => {
  for (const gate of ['cooldown', 'backoff', 'cache']) await t.test(gate, async t => {
    const f = fixture(t); f.add('origin', { state: 'busy' });
    await (await f.prepare()).result; const started = f.waitAt(); f.advance(WAIT_MS);
    if (gate === 'cooldown') f.setHealth('rate_limited', { cooldownUntil: f.now() / 1000 + 60 });
    if (gate === 'backoff') f.setHealth('unavailable', { restartFailureCount: 1, lastRecoveryAt: f.now() / 1000 });
    if (gate === 'cache') f.coordinator.readNegativeCache = () => ({ version: 2, runtime: 'claude', recovered: false,
      health: 'unavailable', reason: f.health().reason, expiresAt: f.now() + 60000 });
    const before = f.bytes(); await (await f.prepare()).result;
    assert.equal(f.controls.length, 0); assert.equal(f.bytes(), before); assert.equal(f.waitAt(), started);
  });
});

test('stale identities before and after screen capture and stale C4 results preserve waiting and association', async t => {
  for (const kind of ['before', 'after', 'control']) await t.test(kind, async t => {
    const f = fixture(t), scene = f.add('origin', { state: 'busy' });
    await (await f.prepare()).result; const started = f.waitAt(); f.state(scene);
    const linked = { sessionGroup: scene.sessionGroup, runId: scene.runId };
    f.coordinator.associations.set('claude', linked);
    const p = await f.prepare(), before = f.bytes();
    const replace = () => f.setScenes([{ ...scene, runId: randomUUID() }]);
    if (kind === 'before') replace();
    if (kind === 'after') f.observer.readScreen = () => { replace(); return ''; };
    if (kind === 'control') p.row.last_error = 'STALE_TARGET';
    p.row.status = 'timeout'; f.advance(120000); await f.observer.tick();
    const answer = await p.result; assert.ok(answer.stale || answer.classification === 'stale');
    assert.equal(f.bytes(), before); assert.equal(f.waitAt(), started);
    assert.equal(f.coordinator.associations.get('claude'), linked); assert.equal(f.stops.length, 0);
  });
});

test('current structured failure takes priority over waiting and conflicting pane text', async t => {
  for (const error of ['rate_limit', 'authentication_failed']) await t.test(error, async t => {
    const f = fixture(t), scene = f.add('origin'), p = await f.prepare();
    const identity = { runtime: 'claude', session_id: scene.sessionId, claude_pid: 42 };
    f.state(scene, { tools: [{ id: 'foreground' }] }); await f.observer.tick();
    const result = await f.coordinator.consumeHook('claude', { schema_version: 1, event_id: randomUUID(),
      source: 'hook', runtime: 'claude', ...identity, prompt_id: 'prompt', event: 'stop_failure', error,
      received_at: f.now() }, { identity, sessionGroup: scene.sessionGroup });
    assert.equal(result.status, 'processed');
    f.setMatches(error === 'rate_limit' ? { authFailure: { detected: true } } : { rateLimit: { detected: true } });
    const answer = await terminal(f, p);
    assert.equal(answer.classification, error === 'rate_limit' ? 'rate_limited' : 'auth_error');
    assert.equal(f.health().source, 'hook'); assert.equal(f.waitAt(), undefined);
    assert.equal(f.stops.length, 0);
  });
});

test('lost demand starts a fresh wait when a later message arrives after thirty minutes', async t => {
  const f = fixture(t); f.add('origin', { state: 'busy' });
  await (await f.prepare()).result; const started = f.waitAt();
  await f.reconcile(new Map()); assert.equal(f.waitAt(), undefined);
  f.advance(WAIT_MS + 1000); await f.reconcile();
  assert.equal((await (await f.prepare()).result).noTarget, true);
  assert.equal(f.controls.length, 0); assert.equal(f.waitAt(), f.now()); assert.notEqual(f.waitAt(), started);
});

test('structured authentication failure during idle waiting stops further recovery attempts', async t => {
  const f = fixture(t), scene = f.add('origin', { state: 'busy' });
  await (await f.prepare()).result;
  const identity = { runtime: 'claude', session_id: scene.sessionId, claude_pid: 42 };
  const result = await f.coordinator.consumeHook('claude', { schema_version: 1, event_id: randomUUID(),
    source: 'hook', runtime: 'claude', ...identity, prompt_id: 'prompt', event: 'stop_failure',
    error: 'authentication_failed', received_at: f.now() }, { identity, sessionGroup: scene.sessionGroup });
  assert.equal(result.status, 'processed'); await f.reconcile();
  assert.equal(f.waitAt(), undefined); assert.equal(f.health().health, 'auth_failed');
  f.advance(WAIT_MS); await (await f.prepare()).result;
  assert.equal(f.controls.length, 0); assert.equal(f.stops.length, 0);
});

test('every tick clears waiting on lost demand, healthy state or no qualified ready scene', async t => {
  for (const reason of ['demand', 'ok', 'auth_failed', 'gone', 'starting', 'fence', 'global-fence', 'transition']) {
    await t.test(reason, async t => {
      const f = fixture(t), scene = f.add('origin', { state: 'busy' });
      await (await f.prepare()).result; assert.equal(f.waitAt(), f.now());
      // A future budget makes this a not-due tick; reconciliation must still run.
      f.setHealth(['ok', 'auth_failed'].includes(reason) ? reason : 'unavailable',
        { restartFailureCount: 1, lastRecoveryAt: f.now() / 1000 });
      if (reason === 'gone') f.setScenes([]);
      if (reason === 'starting') scene.ready = false;
      if (reason === 'fence') f.fences.add(scene.sessionGroup);
      if (reason === 'global-fence') f.fences.add('*');
      if (reason === 'transition') f.setTransition({ phase: 'gating' });
      await f.reconcile(reason === 'demand' ? new Map() : undefined);
      assert.equal(f.waitAt(), undefined); assert.equal(f.controls.length, 0);
    });
  }
});

test('no scene does not start waiting and another runtime cannot supply a target', async t => {
  const f = fixture(t); const other = f.add('origin', { state: 'idle' }); other.runtime = 'codex';
  assert.equal((await (await f.prepare()).result).noTarget, true);
  assert.equal(f.controls.length, 0); assert.equal(f.waitAt(), undefined);
});

test('single recovery and unordered hook verification ignore busy activity and retain baseline deadlines', async t => {
  for (const kind of ['single', 'hook']) await t.test(kind, async t => {
    const f = fixture(t), scene = f.add('origin', { tools: [{ id: 'foreground' }] });
    if (kind === 'single') f.setMode('single');
    const result = kind === 'hook' ? f.observer.requestVerification('claude') : f.observer.requestProbe('claude');
    await Promise.all([...f.observer.preparations]);
    const row = f.controls[0]; assert.ok(row); assert.equal(row.sessionGroup, kind === 'single' ? null : 'origin');
    assert.equal(row.targetBinding.runId, scene.runId);
    assert.equal(row.ackDeadlineAt, f.now() / 1000 + (kind === 'single' ? 120 : 300));
    row.status = 'timeout'; f.advance(kind === 'single' ? 120000 : 300000); await f.observer.tick();
    assert.equal((await result).classification, 'other'); assert.equal(f.stops.length, 1);
    assert.equal(f.waitAt(), undefined);
  });
});
