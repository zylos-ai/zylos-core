import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture as storeFixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { startSupervisor } from '../skills/activity-monitor/scripts/supervisor-main.js';
import { createModeSwitchConverter } from '../skills/activity-monitor/scripts/mode-switch-convert.js';
import { ModeSwitchCoordinator } from '../skills/activity-monitor/scripts/mode-switch.js';
import { HANDOFF_FOLLOWUP_PROMPT } from '../skills/activity-monitor/scripts/origin-prompts.js';
import { validateStateDocument } from '../skills/zylos-memory/scripts/state-format.js';
import { readSessionModeStatus } from '../cli/lib/session-mode-status.js';

// Integration boundary: private SQLite/socket and real supervisor/converter/status;
// run for first-migration conversion diagnostics or status recovery changes, and
// skip for native-switch-only changes. The runner and fixture isolate paths;
// finally stops the supervisor before closing SQLite and removing its root.
test('first migration supervisor reason/events and readonly status agree through block, recovery and stopped supervisor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-switch-visible-')); const cleanup = [];
  const { db, store } = storeFixture({ after: fn => cleanup.push(fn) }, {}, path.join(root, 'c4.db'));
  let mode = 'single', keyPresent = false, failExport = true, service;
  const readMode = () => ({ mode, keyPresent });
  const converter = createModeSwitchConverter({ db: store, zylosDir: root });
  const status = () => readSessionModeStatus({ db: store, zylosDir: root, readMode, readPm2: async () => 'stopped' });
  try {
    service = await startSupervisor({ env: { ...process.env, HOME: root, ZYLOS_DIR: root }, db: { ...store, getDb: () => db },
      readMode, readConfig: () => ({ runtime: 'claude', ...(keyPresent ? { session_mode: mode } : {}) }), legacyPresent: () => false,
      scenes: { observe: async () => [], observeGroup: async () => ({ present: false }), readIdentity: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null },
      legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} }, loopOptions: { schedule: () => 1, cancel() {} },
      readSyncMarker: () => ({ held: false, stale: false }),
      convertModeTransition: row => { if (failExport) throw Object.assign(new Error('export fixture failure'), { step: 'export', code: 'EIO' }); return converter(row); },
      writeMode: target => { mode = target; keyPresent = true; }, restartDispatcherConfirmation: { advance: () => ({ confirmed: true }) },
      sendAlert: () => { throw new Error('external notification forbidden'); }, log() {},
    });
    const reply = await service.supervisor.admission.handle({ version: 1, type: 'mode_switch', requestId: 'visible', target: 'multi' });
    assert.equal(reply.result, 'accepted');
    assert.equal(store.getModeTransition().kind, 'first_migration');
    for (let n = 0; n < 3; n++) await service.supervisor.loop.tick();
    const blocked = await status();
    assert.equal(blocked.supervisor, 'reachable'); assert.equal(blocked.globalGate.present, true);
    assert.equal(blocked.blocked.reason, 'conversion_failed:export:EIO'); assert.ok(Number.isFinite(blocked.blocked.since));
    assert.equal(blocked.lastEvents.filter(event => event.event === 'transition_convert_failed').length, 1);
    await service.stop(); service = null;
    const stopped = await status();
    for (const key of ['transition', 'globalGate', 'blocked', 'lastEvents', 'lastCompleted']) assert.deepEqual(stopped[key], blocked[key]);
    assert.equal(stopped.supervisor, 'unreachable');
    // Resume the real coordinator after the service has stopped to exercise its
    // durable authority recovery without starting another external process.
    const { ModeSwitchCoordinator } = await import('../skills/activity-monitor/scripts/mode-switch.js');
    failExport = false;
    const owner = new ModeSwitchCoordinator({ db: store, zylosDir: root, readMode,
      convert: converter, writeMode: target => { mode = target; keyPresent = true; }, restart: { advance: () => ({ confirmed: true }) },
    });
    await owner.advance(); await owner.advance();
    const done = await status(); assert.equal(done.transition, null); assert.equal(done.blocked, null);
    assert.equal(done.lastCompleted.runId, reply.runId); assert.equal(done.globalGate.present, false); assert.equal(done.sessionMode, 'multi');
  } finally { await service?.stop(); for (const fn of cleanup.reverse()) fn(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Integration boundary: real coordinator, converter, schema-guarded private file
// C4 store, and physical config/memory files; no replacement storage methods.
// Run for automatic first-migration phases, Origin role-control preservation or
// converter/cutover changes. Skip unrelated transport/runtime work. Scenes are
// bounded empty observations and dispatcher confirmation is injected: this case
// does not prove real tmux, PM2 restart, or external delivery. The official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; teardown closes SQLite before removing
// the fixture root. No supervisor services or background workers are started.
test('automatic first migration converts real memory and expires only stale execution controls at cutover', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-migration-full-')), cleanup = [];
  t.after(() => { for (const fn of cleanup.reverse()) fn(); fs.rmSync(root, { recursive: true, force: true }); });
  const configFile = path.join(root, '.zylos', 'config.json'); fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, '{"runtime":"claude"}\n');
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const readMode = () => { const config = readConfig(); return { mode: config.session_mode ?? null, keyPresent: Object.hasOwn(config, 'session_mode') }; };
  const { db, store } = storeFixture({ after: fn => cleanup.push(fn) }, {
    now: () => 1800000000000, readConfig: () => ({ state: 'ok', config: readConfig() }),
  }, path.join(root, 'c4.db'));
  const memory = path.join(root, 'memory'); fs.mkdirSync(memory);
  const source = { 'state.md': '# Global state\nunfinished global work\n', 'inbox.md': '# Global inbox\nretained fact\n', 'handoff.md': '# Earlier handoff\nread completely\n' };
  for (const [name, content] of Object.entries(source)) fs.writeFileSync(path.join(memory, name), content);
  const ordinary = store.insertConversation('in', 'fixture', 'chat', 'ordinary pending for migration', { groupName: 'team' });
  const origin = store.insertConversation('in', 'system', 'owner', 'origin pending for migration');
  assert.equal(ordinary.session_group, 'fixture:team'); assert.equal(origin.session_group, 'origin');
  const insert = db.prepare("INSERT INTO control_queue(raw_content,content,status,created_at,updated_at,session_group,target_binding) VALUES(?,?,'pending',1,1,?,?)");
  const add = (content, group, binding = null) => Number(insert.run(content, content, group, binding).lastInsertRowid);
  const roleId = add('retained Origin role', 'origin');
  const pinnedId = add('stale Origin execution', 'origin', JSON.stringify({ expectedRunId: 'legacy-run', tmuxTarget: { serverGeneration: 'legacy-generation', sessionId: '$1', paneId: '%1' } }));
  const ordinaryId = add('ordinary execution', ordinary.session_group), machineId = add('machine execution', null);
  const beforeControls = db.prepare('SELECT * FROM control_queue ORDER BY id').all();
  let restartCount = 0;
  const events = [], converter = createModeSwitchConverter({ db: store, zylosDir: root });
  const coordinator = new ModeSwitchCoordinator({ db: store, readMode, readConfiguration: readConfig,
    readRequests: () => [], legacyPresent: () => false, observe: () => [],
    convert: converter, now: () => 1800000000000,
    writeMode: target => fs.writeFileSync(configFile, JSON.stringify({ ...readConfig(), session_mode: target }) + '\n'),
    restart: { advance: () => { restartCount++; return { confirmed: true }; } }, diagnostic: event => events.push(event),
  });
  assert.deepEqual(readMode(), { mode: null, keyPresent: false });
  await coordinator.automatic();
  const runId = store.getModeTransition().run_id;
  assert.equal(store.getModeTransition().kind, 'first_migration'); assert.equal(store.getModeTransition().phase, 'gating');
  assert.equal(store.getDrainFence('*'), null);
  await coordinator.advance();
  const absorbed = store.getModeTransition();
  assert.equal(absorbed.phase, 'converting'); assert.ok(Number.isSafeInteger(absorbed.cutoff));
  assert.deepEqual(absorbed.absorbed_ids, [ordinary.id, origin.id]);
  assert.deepEqual(store.getAbsorbedConversations(runId).map(row => row.id), [ordinary.id, origin.id]);
  assert.deepEqual(db.prepare('SELECT status FROM conversations ORDER BY id').all(), [{ status: 'switch_absorbed' }, { status: 'switch_absorbed' }]);
  await coordinator.advance();
  const cutover = store.getModeTransition({ runId });
  assert.equal(cutover.phase, 'cutover'); assert.equal(store.getModeTransition().phase, 'cutover');
  assert.deepEqual(readMode(), { mode: null, keyPresent: false });
  assert.deepEqual(db.prepare('SELECT * FROM control_queue ORDER BY id').all(), beforeControls, 'cutover phase must commit before control invalidation');
  assert.equal(restartCount, 0);
  const archive = path.join(memory, 'mode-switch', runId, 'previous', '_global');
  for (const [name, content] of Object.entries(source)) {
    assert.equal(fs.existsSync(path.join(memory, name)), false);
    assert.equal(fs.readFileSync(path.join(archive, name), 'utf8'), content);
  }
  assert.equal(fs.readFileSync(path.join(archive, '.done'), 'utf8'), '');
  for (const [scope, text] of [['origin','origin pending for migration'], ['fixture:team','ordinary pending for migration']]) {
    const state = fs.readFileSync(path.join(memory, 'session-groups', scope, 'state.md'), 'utf8');
    assert.equal(validateStateDocument(state, { scope }), true); assert.ok(state.includes(text));
  }
  const handoff = fs.readFileSync(path.join(memory, 'session-groups', 'origin', 'handoff.md'), 'utf8');
  assert.ok(handoff.includes(runId)); assert.ok(handoff.includes('Total absorbed: 2')); assert.ok(handoff.includes(path.join(archive, 'handoff.md')));
  await coordinator.advance();
  assert.equal(store.getModeTransition(), null); assert.equal(store.getModeTransition({ runId }).phase, 'complete');
  assert.equal(store.getDrainFence('*'), null); assert.deepEqual(readMode(), { mode: 'multi', keyPresent: true }); assert.equal(restartCount, 1);
  const controls = db.prepare('SELECT * FROM control_queue ORDER BY id').all();
  assert.deepEqual(controls.find(row => row.id === roleId), beforeControls.find(row => row.id === roleId));
  for (const id of [pinnedId, ordinaryId, machineId]) {
    assert.equal(controls.find(row => row.id === id).status, 'timeout'); assert.equal(controls.find(row => row.id === id).last_error, 'SESSION_ENDED');
  }
  const followups = controls.filter(row => row.raw_content === HANDOFF_FOLLOWUP_PROMPT);
  assert.equal(followups.length, 1); assert.equal(followups[0].session_group, 'origin'); assert.equal(followups[0].priority, 2);
  assert.equal(followups[0].target_binding, null); assert.equal(followups[0].status, 'pending');
  assert.equal(events.filter(event => event.event === 'absorb').length, 1); assert.equal(events.filter(event => event.event === 'transition_complete').length, 1);
});
