import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModeSwitchCoordinator } from '../mode-switch.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

// Coverage: the production database facade, including cleanup and completion
// writes. Run when coordinator/store facade wiring changes; skip unrelated
// runtime changes. The official runner owns HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and
// removes its private database on teardown. All scene/runtime/conversion/restart
// adapters are injected; no tmux socket, PM2 process or network is opened.
test('public database facade completes legacy drain and preserves future deadlines', async t => {
  const root = fs.realpathSync(path.dirname(process.env.HOME));
  assert.match(path.basename(root), /^zylos-tests-/);
  assert.equal(process.env.ZYLOS_DIR, path.join(process.env.HOME, 'zylos'));
  assert.equal(process.env.PM2_HOME, path.join(process.env.HOME, '.pm2'));
  assert.equal(process.env.TMPDIR, path.join(root, 'tmp'));
  assert.notEqual(process.env.HOME, os.userInfo().homedir);
  const db = await import('../../../comm-bridge/scripts/c4-db.js');
  t.after(() => db.close());
  const sqlite = db.getDb();
  assert.equal(sqlite.name, path.join(process.env.ZYLOS_DIR, 'comm-bridge', 'c4.db'));
  console.log(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, database: sqlite.name,
    runtimeAdapters: 'injected; no tmux/PM2/network' }));
  let mode = 'single';
  const events = [];
  const owner = new ModeSwitchCoordinator({ db,
    readMode: () => ({ mode, keyPresent: true }), readConfiguration: () => ({ mode }),
    readRequests: () => [], legacyPresent: () => false, observe: () => [],
    lifecycle: { advanceReclaim: async () => {} }, convert: async () => {},
    writeMode: value => { mode = value; }, restart: { advance: async () => ({ confirmed: true }) },
    diagnostic: event => events.push(event) });
  const insert = sqlite.prepare(`INSERT INTO control_queue(content,raw_content,status,created_at,updated_at,ack_deadline_at)
    VALUES('exit','exit','running',1,1,?)`);
  const legacy = Number(insert.run(null).lastInsertRowid);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const future = Number(insert.run(deadline).lastInsertRowid);
  assert.equal((await owner.handle({ target: 'multi' })).result, 'accepted');
  await owner.advance();
  assert.equal(db.getControlById(legacy).status, 'timeout');
  assert.equal(db.getControlById(legacy).last_error, 'SESSION_ENDED');
  assert.equal(db.getControlById(future).status, 'running');
  assert.equal(db.getModeTransition().phase, 'gating');
  assert.ok(db.getDrainFence('*'));
  assert.equal(mode, 'single');
  assert.equal(events.filter(event => event.event === 'transition_legacy_controls_expired').length, 1);
  db.expireControlById(future);
  for (let i = 0; i < 3; i++) await owner.advance();
  assert.equal(mode, 'multi');
  assert.equal(db.getModeTransition(), null);
  assert.equal(db.getDrainFence('*'), null);
  assert.equal(db.getLastCompletedModeTransition().phase, 'complete');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM control_queue WHERE session_group='origin' AND status='pending'").get().count, 1);
});

// Coverage: real coordinator/store/router gating and activation after completion.
// Run for legacy control cleanup or transition fence changes; skip unrelated
// runtime/conversion changes. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME
// and short TMPDIR. SQLite is private/in-memory; runtime adapters, conversion,
// restart and scene observations are injected. No tmux socket, PM2 or network
// is opened. Fixture teardown stops router work and closes the database.
for (const deadline of [null, 1800001000]) test(`router activation after legacy drain with ${deadline === null ? 'no' : 'future'} deadline`, async t => {
  const f = routerFixture(t); let mode = 'single';
  f.dependencies.readConfig = () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } });
  f.deps.readSessionMode = () => ({ mode, keyPresent: true });
  const id = Number(f.sqlite.prepare(`INSERT INTO control_queue(content,raw_content,status,created_at,updated_at,ack_deadline_at)
    VALUES('exit','exit','running',1700000000,1700000000,?)`).run(deadline).lastInsertRowid);
  const owner = new ModeSwitchCoordinator({ db: f.db, now: f.now,
    readMode: () => ({ mode, keyPresent: true }), readConfiguration: () => ({ mode }),
    readRequests: () => [], legacyPresent: () => false, observe: () => [],
    lifecycle: { advanceReclaim: async () => {} }, convert: async () => {},
    writeMode: value => { mode = value; }, restart: { advance: async () => {
      await f.router.stop(); await f.create().initialize(); return { confirmed: true };
    } } });
  assert.equal((await owner.handle({ target: 'multi' })).result, 'accepted');
  f.db.setDrainFence('*');
  await f.create().initialize(); await f.rounds(2); f.advance(5000); await f.rounds(2);
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 0);
  assert.ok(f.events.some(event => event.event === 'start_skipped_fenced'), JSON.stringify(f.events.slice(-10)));
  for (let i = 0; i < 3; i++) await owner.advance();
  await f.rounds(2); f.advance(5000); await f.rounds(5);
  if (deadline === null) {
    assert.equal(mode, 'multi'); assert.equal(f.db.getModeTransition(), null); assert.equal(f.db.getDrainFence('*'), null);
    assert.equal(f.db.getControlById(id).status, 'timeout');
    assert.equal(f.calls.filter(call => call[0] === 'launch' && call[1].sessionGroup === 'origin').length, 1);
    assert.equal(f.scene.get('origin').ready, true);
  } else {
    assert.equal(mode, 'single'); assert.equal(f.db.getModeTransition().phase, 'gating'); assert.ok(f.db.getDrainFence('*'));
    assert.equal(f.db.getControlById(id).status, 'running');
    assert.equal(f.calls.filter(call => call[0] === 'launch').length, 0);
  }
});
