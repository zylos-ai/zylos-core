import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';

const environment = createTestEnvironment();
const c4 = await import('../../../comm-bridge/scripts/c4-db.js');
const { RuntimeHealthCoordinator } = await import('../runtime-health.js');
const { SupervisorHealthObserver } = await import('../supervisor-health-observer.js');
after(() => { c4.close(); environment.cleanup(); });

// Integration boundary: real C4 insert/read, private SQLite, observer, health
// coordinator and durable HealthStore. Run for recovery control return shape,
// idle eligibility, acknowledgement polling or retry-budget changes; skip unrelated runtime I/O.
// The official runner supplies private paths; this file creates another private
// HOME/ZYLOS_DIR/PM2_HOME before importing modules that capture those paths, so
// config writes and control-row cleanup never touch the runner's shared root.
// Identity, screen, clock and transport are injected: no runtime, tmux, PM2,
// network, account or notification is contacted. Teardown stops the observer,
// closes the file-owned database and removes health files; file teardown removes
// its config/database root and restores the runner's original environment.
function fixture(t, runtime = 'codex') {
  const zylosDir = process.env.ZYLOS_DIR;
  assert.equal(zylosDir, path.join(os.homedir(), 'zylos'));
  assert.match(path.basename(path.dirname(os.homedir())), /^zylos-tests-/);
  const configDir = path.join(zylosDir, '.zylos');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ runtime: 'codex', session_mode: 'multi' }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-health-'));
  const sqlite = c4.getDb();
  sqlite.exec('DELETE FROM control_queue');
  let clock = 1_800_000_000_000, queued = 0;
  const errors = [];
  const scene = { sessionGroup: 'telegram:recovery', runtime, runId: randomUUID(),
    sessionId: 'private-session', present: true, ready: true };
  const coordinator = new RuntimeHealthCoordinator({ zylosDir: root, now: () => clock,
    resolveTargetRuntime: () => runtime, listScenes: () => [scene] });
  const health = coordinator.store(runtime), state = health.read();
  state.health = 'rate_limited'; state.rateLimitActive = true;
  state.scheduling.cooldownUntil = Math.floor(clock / 1000);
  health.write(state);
  const markQueued = coordinator.markProbeQueued.bind(coordinator);
  coordinator.markProbeQueued = runtime => { queued++; return markQueued(runtime); };
  const observer = new SupervisorHealthObserver({ coordinator, now: () => clock,
    listScenes: () => [scene], readIdentity: () => scene,
    readState: () => ({ state: 'idle', tools: [] }), readScreen: () => '', matchScreen: () => ({}),
    insertControl: c4.insertControl, getControlById: c4.getControlById,
    buildTargetBinding: () => ({ expectedRunId: scene.runId,
      tmuxTarget: { serverGeneration: 'private-generation', sessionId: '$1', paneId: '%1' } }),
    stop: () => false, log: error => errors.push(error) });
  coordinator.probeInFlight = runtime => observer.probeInFlight(runtime);
  t.after(async () => { await observer.shutdown(); c4.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const drive = async () => { observer.driveDemand(runtime); await Promise.all([...observer.preparations]); await observer.tick(); };
  return { observer, health, sqlite, errors, drive, scene, queued: () => queued, now: () => clock,
    advance: ms => { clock += ms; }, rows: () => sqlite.prepare('SELECT * FROM control_queue ORDER BY id').all() };
}

test('real control rows remain single-flight and their acknowledgement restores durable health', async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) { await f.drive(); f.advance(1000); }
  assert.equal(f.rows().length, 1);
  const row = f.rows()[0];
  assert.equal(row.raw_content, 'Heartbeat check. [phase=recovery]');
  assert.equal(row.status, 'pending');
  assert.equal(f.observer.probeInFlight('codex'), true);
  assert.equal(f.observer.probes.get('codex').controlId, row.id);
  assert.equal(f.queued(), 1);
  assert.equal(f.health.read().scheduling.lastRecoveryAt, Math.floor((f.now() - 5000) / 1000));
  assert.deepEqual(f.errors, []);
  assert.equal(c4.ackControl(row.id).status, 'done');
  await f.observer.tick();
  assert.equal(f.observer.probeInFlight('codex'), false);
  assert.equal(f.health.read().health, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(f.health.file, 'utf8')).health, 'ok');
  for (let i = 0; i < 5; i++) { f.advance(1000); await f.drive(); }
  assert.equal(f.rows().length, 1);
  assert.equal(f.queued(), 1);
});

