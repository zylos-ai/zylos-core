import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { HealthStore } from '../health-store.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { groupRunDir } from '../../../../cli/lib/session-group-paths.js';

// Actual assembly, loop, stores, activity reader and status publication. Only
// external observations, database and timers are replaced; consumeHealthEvents
// is omitted, so these counts cover the assembly's own reads rather than hook
// ingestion or a complete running supervisor process. The official runner
// isolates HOME/ZYLOS_DIR; all fixture files live in an owned temporary tree.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-round-reads-'));
  let now = 1792000000000;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = ['claude', 'claude', 'claude', 'codex', 'codex'].map((runtime, index) => {
    const sessionGroup = index === 0 ? 'origin' : `telegram:group-${index}`;
    const runDir = path.join(root, `run-${index}`);
    fs.mkdirSync(runDir);
    const scene = { sessionGroup, runtime, runDir, runId: `run-${index}`, sessionId: `session-${index}`,
      present: true, ready: true, processRunning: true, createdAt: now - 1000,
      launchConfig: { runtime, mode: 'default' } };
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify({ v: 1, ts: now - 100,
      run_id: scene.runId, session_id: scene.sessionId, runtime, event: 'pre_tool',
      tool_use_id: `tool-${index}`, tool: 'Read' }) + '\n');
    return scene;
  });
  for (const runtime of ['claude', 'codex']) {
    const store = new HealthStore({ zylosDir: root, runtime, now: () => now });
    store.write(store.read());
  }
  const db = {
    getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
    getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    listSlotOccupancy: () => [], pruneSlots: () => ({ deletedHeld: 0, deletedOrphans: [] }),
    listPendingContinuations: () => [], listRunEndings: () => [], getLastCompletedModeTransition: () => null,
    listPendingSessionGroups: () => [], getControlById: () => null,
    getLastActivity: () => now / 1000,
    getUnsummarizedRange: () => ({ count: 0, firstAt: null }),
    getOriginSyncBacklog: () => ({ total: 0, groups: [] }),
    resolveSessionLaunchConfig: ({ sessionGroup }) => current.find(scene => scene.sessionGroup === sessionGroup).launchConfig,
  };
  const scenes = {
    observe: async () => current, listRuns: async () => current,
    readIdentity: async group => current.find(scene => scene.sessionGroup === group) ?? { present: false },
    observeGroup: async group => current.find(scene => scene.sessionGroup === group) ?? { present: false },
    readRun: async () => null,
  };
  const errors = [];
  const supervisor = createSupervisor({ db, scenes, zylosDir: root, env: { ZYLOS_DIR: root },
    now: () => now, log: row => { if (row.error) errors.push(row); },
    readMode: () => ({ mode: 'multi' }),
    readConfiguration: async () => ({ mode: 'multi', runtime: 'claude', capacity: 4 }),
    resolveTargetRuntime: async () => 'claude',
    prepareReferenceReorg: () => false,
    prompts: { REFERENCE_REORG_PROMPT: 'Unused fixture proposal' },
    requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
    checkAuth: async () => { throw new Error('Unexpected auth check'); },
    alert: async () => { throw new Error('Unexpected alert'); },
    loopOptions: { schedule: () => 1, cancel: () => {} },
  });
  t.after(() => supervisor.stop());
  return { root, current, errors, supervisor, db, now: () => now, advance: ms => { now += ms; } };
}

test('assembled multi-group round bounds health-file reads per runtime', async t => {
  // Publication, tool health and runtime checks share cached authority. Reads
  // must remain bounded by runtime count as multiple groups are observed.
  const { root, current, errors, supervisor } = fixture(t);
  const files = new Map(['claude', 'codex'].map(runtime => [supervisor.health.store(runtime).file, runtime]));
  const reads = { claude: 0, codex: 0 };
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    const runtime = files.get(String(file));
    if (runtime) reads[runtime]++;
    return Reflect.apply(original, this, [file, ...args]);
  });
  await supervisor.loop.runRound();
  await supervisor.drainHealthWrites();
  assert.deepEqual(errors, []);
  for (const scene of current) {
    const status = JSON.parse(fs.readFileSync(path.join(scene.runDir, 'agent-status.json'), 'utf8'));
    assert.equal(status.runtime, scene.runtime);
    assert.equal(status.health, 'ok');
    assert.equal(status.active_tools, 1);
  }
  t.diagnostic(`health-file reads in five-group real round: ${JSON.stringify(reads)}`);
  assert.deepEqual(reads, { claude: 1, codex: 1 });

  reads.claude = 0; reads.codex = 0;
  await supervisor.loop.runRound();
  await supervisor.drainHealthWrites();
  assert.deepEqual(errors, []);
  assert.ok(reads.claude <= 1 && reads.codex <= 1, `warm round: ${JSON.stringify(reads)}`);

  // A second writer's atomic replacement must become visible in the next
  // actual round, without reintroducing a read for each observed group.
  const external = new HealthStore({ zylosDir: root, runtime: 'codex' });
  const state = external.read();
  state.health = 'unavailable'; state.reason = 'temporarily_unavailable';
  external.write(state);
  reads.claude = 0; reads.codex = 0;
  await supervisor.loop.runRound();
  await supervisor.drainHealthWrites();
  assert.deepEqual(errors, []);
  assert.equal(reads.codex, 1);
  assert.ok(reads.claude <= 1);
  for (const scene of current.filter(scene => scene.runtime === 'codex')) {
    const status = JSON.parse(fs.readFileSync(path.join(scene.runDir, 'agent-status.json'), 'utf8'));
    assert.equal(status.health, 'unavailable');
  }
});

test('real round maintenance prunes deleted group history and protects queued and live groups', async t => {
  const { root, current, errors, supervisor, db, now, advance } = fixture(t);
  const deleted = 'chat:deleted', pending = 'chat:pending', continuation = 'chat:continuation';
  const live = current[1].sessionGroup;
  const env = { ZYLOS_DIR: root };
  const deletedRunDir = groupRunDir(deleted, env);
  fs.mkdirSync(deletedRunDir, { recursive: true });
  fs.mkdirSync(groupRunDir(live, env), { recursive: true });
  db.listPendingSessionGroups = () => [{ sessionGroup: pending }];
  db.listPendingContinuations = () => [{ sessionGroup: continuation }];
  const store = supervisor.health.store('claude');
  const state = store.read();
  const evidence = {
    last_processed: { received_at: now(), event_id: 'recent-terminal-hook' },
    last_notice_outcome: { event_id: 'recent-terminal-hook', status: 'sent', observed_at: now() },
  };
  for (const group of [deleted, live, pending, continuation]) state.groups[group] = structuredClone(evidence);
  store.write(state);

  await supervisor.loop.runRound();
  await Promise.all([...supervisor.observer.preparations]);
  await supervisor.drainHealthWrites();
  for (const group of [deleted, live, pending, continuation]) {
    assert.deepEqual(store.read().groups[group], evidence, `${group} retained before deletion`);
  }
  // Simulate the owned run-directory removal phase of group deletion. Its
  // recent markers cannot expire in this interval; only missing-path cleanup
  // can remove them. Queued groups deliberately have no run directory.
  fs.rmSync(deletedRunDir, { recursive: true });
  advance(60000);
  await supervisor.loop.runRound();
  await Promise.all([...supervisor.observer.preparations]);
  await supervisor.drainHealthWrites();
  const after = store.read();
  assert.equal(Object.hasOwn(after.groups, deleted), false);
  for (const group of [live, pending, continuation]) assert.deepEqual(after.groups[group], evidence);
  assert.deepEqual(errors, []);
});
