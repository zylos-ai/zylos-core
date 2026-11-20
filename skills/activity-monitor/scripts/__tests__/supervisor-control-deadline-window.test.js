import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { SupervisorHealthObserver } from '../supervisor-health-observer.js';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { fixture as c4Fixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';

// One clock for the supervisor and the C4 store. It starts 1 ms before a whole second and advances one second per
// read, so the reading a supervisor derives a deadline from and any later store reading are in different seconds.
const START_SECONDS = 1_800_000_000;
function secondStepClock() {
  let reads = 0;
  return () => START_SECONDS * 1000 + 999 + 1000 * reads++;
}

// The real lifecycle writes through the real control store on a private in-memory C4 database. Only reads that
// decide whether a site writes are fixed here; control insertion, fences and transitions are the store's own.
function harness(t) {
  const now = secondStepClock();
  const { db: database, store } = c4Fixture(t, { now });
  const scene = { sessionGroup: 'a', runId: 'run-a', sessionId: 'session-a', runtime: 'claude', present: true, ready: true,
    createdAt: 0, processRunning: true, state: 'idle', idleSince: 0, runDir: '/isolated/a', launchConfig: { runtime: 'claude', mode: 'default' } };
  const db = {
    ...store,
    getLastActivity: () => ({ ts: 0 }),
    getUnsummarizedRange: () => ({ count: 16, firstAt: null }), // above the default Sync threshold of 15
    getOriginSyncBacklog: () => ({ total: 0, groups: [] }),
    listSlotOccupancy: () => [{ sessionGroup: 'a', runId: 'run-a', state: 'running', heldUntil: null, createdAt: 0 }],
    listPendingSessionGroups: () => [{ sessionGroup: 'waiting' }],
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'override', model: 'm', effort: 'high' }),
  };
  const lifecycle = new SupervisorLifecycle({
    db,
    observeGroup: () => ({ ...scene }),
    readSyncMarker: () => ({ held: false, stale: false }),
    bindTarget: current => ({ expectedRunId: current.runId, tmuxTarget: { serverGeneration: 'gen', sessionId: '$1', paneId: '%1' } }),
    requests: { read: () => [] },
    diagnostic: () => {},
    prompts: { PRE_RECLAIM_CHECK_PROMPT: 'check', PRE_RECLAIM_SYNC_PROMPT: 'prepare', PRE_RECLAIM_ORIGIN_SYNC_PROMPT: 'prepare origin',
      UPGRADE_RESTART_CHECK_PROMPT: 'upgrade check', GROUP_SYNC_PROMPT: 'group sync', CONFIG_RECLAIM_PROMPT: () => 'config' },
  }, { now });
  const context = { configuration: { mode: 'multi', capacity: 1 }, scenes: [{ ...scene }], fences: [], restartRequests: [], transition: null };
  const rows = () => database.prepare('SELECT raw_content, session_group, created_at, ack_deadline_at FROM control_queue ORDER BY id').all();
  return { lifecycle, scene, context, rows };
}

const SITES = [
  ['release preparation', [300, 900], ['check', 'prepare'], h => h.lifecycle.prepareRelease(h.scene, h.context, { controlIds: [] })],
  ['TTL preparation', [300, 900], ['check', 'prepare'], h => h.lifecycle.checkTtl(h.scene, h.context)],
  ['eviction check', 60, ['check'], h => h.lifecycle.checkEviction([h.scene], h.context)],
  ['configuration restart', 300, ['config'], h => h.lifecycle.reconcileConfiguration(h.context)],
  ['group Sync', 300, ['group sync'], h => h.lifecycle.syncScope(h.scene, 'group', { count: 60, nonempty: true, firstAt: null, firstConversationId: 1 }, h.context)],
  ['multi-session upgrade check', 60, ['upgrade check'], h => h.lifecycle.prepareUpgrade(h.scene, h.context)],
];

for (const [name, seconds, contents, write] of SITES) {
  const window = Array.isArray(seconds) ? `${seconds.join(' and ')} second windows` : `${seconds} second window`;
  test(`the supervisor ${name} keeps exactly its ${window} when the write crosses a whole second`, async t => {
    const h = harness(t);
    await write(h);
    const rows = h.rows();
    assert.deepEqual(rows.map(row => [row.raw_content, row.session_group]), contents.map(content => [content, 'a']));
    // Reclaim checks get five minutes; the following memory Sync gets fifteen.
    // Match each window to its prompt, retaining the whole-second boundary check.
    for (const [index, row] of rows.entries()) {
      assert.equal(row.ack_deadline_at - row.created_at, Array.isArray(seconds) ? seconds[index] : seconds, JSON.stringify(row));
    }
  });
}

test('the supervisor recovery heartbeat keeps exactly its 120 second window when the write crosses a whole second', async t => {
  const now = secondStepClock();
  const { db: database, store } = c4Fixture(t, { now });
  // Runtime health state lives in a private directory under the test TMPDIR.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-window-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scenes = [{ sessionGroup: 'a', runtime: 'claude', runId: 'run-a', ready: true, present: true, sessionId: 'session-a' }];
  const coordinator = new RuntimeHealthCoordinator({ zylosDir: root, now, resolveTargetRuntime: () => 'claude', listScenes: () => scenes });
  const observer = new SupervisorHealthObserver({ coordinator, now, listScenes: () => scenes,
    readIdentity: group => scenes.find(scene => scene.sessionGroup === group), readState: () => ({ state: 'idle', tools: [], sessionId: 'session-a' }),
    readScreen: () => '', matchScreen: () => ({}), insertControl: store.insertControl, getControlById: store.getControlById,
    buildTargetBinding: scene => ({ expectedRunId: scene.runId, tmuxTarget: { serverGeneration: 'gen', sessionId: '$1', paneId: '%1' } }),
    stop: async () => false, getModeTransition: store.getModeTransition, getDrainFence: store.getDrainFence, manualPending: () => false,
    resolveToolRule: () => ({ watchdog: { enabled: false } }), nudge: async () => ({ ok: false }), checkAuth: () => ({ status: 'failure' }),
    diagnostic: () => {}, log: () => {} });
  coordinator.probeInFlight = runtime => observer.probeInFlight(runtime);
  const health = coordinator.store('claude').read(); health.health = 'rate_limited'; health.reason = ''; coordinator.store('claude').write(health);
  observer.requestProbe('claude');
  for (let i = 0; i < 30 && database.prepare('SELECT COUNT(*) AS n FROM control_queue').get().n === 0; i++) await new Promise(resolve => setImmediate(resolve));
  const rows = database.prepare('SELECT raw_content, session_group, created_at, ack_deadline_at FROM control_queue').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].raw_content, /^Heartbeat check\. \[phase=recovery\]$/);
  assert.equal(rows[0].ack_deadline_at - rows[0].created_at, 120, JSON.stringify(rows[0]));
});
