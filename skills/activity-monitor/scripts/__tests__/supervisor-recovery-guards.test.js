import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { NO_RESPONSE_SILENCE_MS } from '../supervisor-health-observer.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Composition boundary: real Supervisor, nudge helper, event reader and request
// store; scene adapter and C4 writes are injected. Private fixture paths stay
// below the official runner's isolated HOME/ZYLOS_DIR/TMPDIR. No sockets,
// database, runtime process, tmux, PM2 or network are opened. Run when recovery
// admission or post-binding validation changes; unrelated UI can skip.
function fixture(t, { group = 'telegram:a' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-guards-'));
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  let clock = 1792000000000, transition = null;
  const fences = new Set(), controls = [], stops = [], cleanup = [], errors = [];
  const scene = { sessionGroup: group, runtime: 'claude', runId: 'guard-run', sessionId: 'guard-session',
    present: true, ready: true, processRunning: true, runDir, createdAt: clock };
  const requests = new RestartRequestStore({ file: path.join(root, 'requests.json') });
  let binding = async value => ({ runtime: value.runtime, runId: value.runId, sessionId: value.sessionId });
  let binds = 0;
  const scenes = {
    observe: async () => [scene], readIdentity: async () => ({ ...scene }),
    observeGroup: async () => ({ ...scene }), readRun: async () => ({ ...scene }), listRuns: async () => [scene],
    readScreen: async () => '', stop: async value => { stops.push(value); },
    bindTarget: async value => { binds++; return binding(value); },
  };
  const db = {
    getModeTransition: () => transition, getDrainFence: group => fences.has(group) ? { reason: 'test' } : null,
    getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
    listDrainFences: () => [], listPendingSessionGroups: () => [], listPendingContinuations: () => [],
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
    insertControl: (content, options) => { const row = { id: controls.length + 1, content, ...options }; controls.push(row); return row; },
    getControlById: id => controls[id - 1],
  };
  const supervisor = createSupervisor({ db, scenes, requestStore: requests, zylosDir: root, env: { ZYLOS_DIR: root },
    now: () => clock, readMode: () => ({ mode: 'multi' }),
    readConfiguration: async () => ({ mode: 'multi', runtime: 'claude', capacity: 2 }),
    resolveTargetRuntime: async () => 'claude', checkAuth: async () => ({ status: 'uncertain' }),
    matchScreen: async () => ({}), resolveToolRule: () => null, log: error => errors.push(error),
    loopOptions: { schedule: () => 1, cancel: () => {} },
  });
  const health = supervisor.health.store('claude'), state = health.read();
  state.health = 'ok'; health.write(state);
  const append = (event, fields = {}) => fs.appendFileSync(path.join(runDir, 'events.jsonl'), `${JSON.stringify({
    v: 1, ts: clock, runtime: scene.runtime, run_id: scene.runId, session_id: scene.sessionId, event, ...fields,
  })}\n`);
  append('session_start'); append('prompt');
  supervisor.observer.notifyDelivered({ sessionGroup: group, runtime: scene.runtime, runId: scene.runId, pastedAt: clock });
  clock += NO_RESPONSE_SILENCE_MS;
  t.after(async () => {
    for (const release of cleanup) release();
    await supervisor.stop(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { supervisor, scene, controls, stops, errors,
    binds: () => binds, fence: group => fences.add(group), transition: () => { transition = { phase: 'draining' }; },
    freshWork: () => { clock++; append('pre_tool', { tool: 'Read', tool_use_id: 'fresh-work' }); },
    manual: () => requests.write([{ requestId: 'guard-manual', reason: 'manual_restart', acceptedAt: clock,
      mode: 'multi', sessionGroup: group, expectedRunId: scene.runId, runIds: [scene.runId] }]),
    blockBinding() {
      const entered = deferred(), release = deferred();
      cleanup.push(release.resolve);
      t.signal.addEventListener('abort', release.resolve, { once: true });
      binding = async value => { entered.resolve(); await release.promise; return { runtime: value.runtime, runId: value.runId, sessionId: value.sessionId }; };
      return { entered: entered.promise, release: release.resolve };
    },
  };
}

for (const scope of ['*', 'telegram:a']) {
  test(`recovery admission rejects an existing ${scope === '*' ? 'global' : 'group'} fence before target binding`, { timeout: 5000 }, async t => {
    const f = fixture(t); f.fence(scope);
    const result = await f.supervisor.observer.nudge(f.scene, async () => true);
    assert.equal(result.ok, false); assert.equal(f.controls.length, 0);
    assert.equal(f.binds(), 0, 'closed admission must not start target-binding I/O');
  });
}

