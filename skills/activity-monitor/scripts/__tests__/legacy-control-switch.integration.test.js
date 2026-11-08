import test from 'node:test';
import assert from 'node:assert/strict';
import { ModeSwitchCoordinator } from '../mode-switch.js';
import { routerFixture } from '../../../comm-bridge/scripts/__tests__/helpers/router-fixture.js';

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
