import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { seedHistoricalAbsorption } from '../skills/comm-bridge/scripts/__tests__/fixtures/historical-absorption.js';
import { deliveryFixture } from '../skills/comm-bridge/scripts/__tests__/helpers/session-delivery-fixture.js';
import { routerFixture } from '../skills/comm-bridge/scripts/__tests__/helpers/router-fixture.js';
import { ModeSwitchCoordinator } from '../skills/activity-monitor/scripts/mode-switch.js';

const clock = 1800000000000;
const modeReader = mode => ({ mode, keyPresent: mode !== null });
function cutover(store, readMode, writeMode, legacyPresent = () => false) {
  return new ModeSwitchCoordinator({ db: store, now: () => clock,
    readMode, readConfiguration: () => ({}), readRequests: () => [],
    legacyPresent, observe: () => [], writeMode,
    restart: { advance: () => ({ confirmed: true }) } });
}
function queue(db, content, status = 'pending') {
  return Number(db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','fixture',?,?,'')")
    .run(content, status).lastInsertRowid);
}
async function deliverOrigin(t, storage, expectedIds) {
  const delivery = deliveryFixture(t, { storage });
  for (const expected of expectedIds) {
    const selected = storage.store.getNextPending({ sessionGroups: ['origin'], sessionMode: 'multi' });
    assert.equal(selected.id, expected);
    assert.equal(storage.store.claimConversation(selected.id, { sessionMode: 'multi' }), true);
    assert.equal((await delivery.delivery.deliverConversation(selected)).delivered, true);
  }
  assert.equal(storage.store.getNextPending({ sessionGroups: ['origin'], sessionMode: 'multi' }), null);
  assert.equal(delivery.calls.filter(([operation, group]) => operation === 'paste' && group === 'origin').length, expectedIds.length);
}

// Run for migration admission, router startup, re-attribution, or scoped delivery.
// The Node runner isolates HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR. This case
// uses an in-memory database and injected runtime/dispatcher I/O, with no tmux
// socket or external service. Stop the router before fixture teardown.
test('upgrade waits for the baseline and then delivers queued legacy input under Origin in order', async t => {
  let mode = null, baselinePresent = true, legacyTicks = 0;
  const readMode = () => modeReader(mode);
  const storage = routerFixture(t);
  storage.deps.readSessionMode = readMode;
  storage.dependencies.readConfig = () => ({ state: 'ok',
    config: { runtime: 'claude', ...(mode === null ? {} : { session_mode: mode }) } });
  const { store, sqlite: db } = storage;
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assert.equal(db.pragma('table_info(mode_transitions)').some(column => column.name === 'kind'), false);
  const origin = store.insertConversation('in', 'dashboard', 'origin', 'already assigned to Origin');
  assert.equal(origin.session_group, 'origin');
  const ids = [queue(db, 'first'), queue(db, 'second')];
  const expectedOriginIds = [origin.id, ...ids];
  const originHead = db.prepare("SELECT head_id FROM group_heads WHERE session_group='origin'").pluck();
  assert.equal(originHead.get(), origin.id);
  const oldDelivery = queue(db, 'already delivered', 'delivered');
  const other = store.insertConversation('in', 'fixture', 'other', 'other group', { groupName: 'room' });
  db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE status='pending'").run(clock / 1000);
  storage.deps.findLegacySessions = () => ['baseline'];
  storage.deps.advanceLegacy = () => { legacyTicks++; };
  const router = storage.create();
  await router.initialize();
  for (let round = 0; round < 3; round++) {
    storage.advance(10000);
    await storage.rounds();
    assert.equal(storage.calls.some(([operation]) => operation === 'launch'), false,
      'pending Origin input must not launch a session while the baseline is present');
  }
  await router.stop();
  assert.equal(legacyTicks, 3);
  const owner = cutover(store, readMode, target => { mode = target; }, () => baselinePresent);
  await owner.automatic();
  assert.equal(store.getModeTransition(), null);
  assert.equal(db.prepare("SELECT count(*) FROM conversations WHERE status='pending'").pluck().get(), 4);
  baselinePresent = false;
  await owner.automatic();
  const { run_id: runId } = store.getModeTransition();
  await owner.advance();
  assert.equal(store.getModeTransition().phase, 'cutover');
  assert.equal(store.claimConversation(ids[0]), false);
  await owner.advance();
  assert.equal(mode, 'multi');
  assert.equal(store.getModeTransition({ runId }).phase, 'complete');
  assert.equal(store.getDrainFence('*'), null);
  assert.equal(originHead.get(), ids.at(-1));
  assert.equal(db.prepare('SELECT session_group FROM conversations WHERE id=?').pluck().get(oldDelivery), '');
  assert.equal(db.prepare('SELECT session_group FROM conversations WHERE id=?').pluck().get(other.id), other.session_group);
  assert.equal(db.prepare('SELECT count(*) FROM control_queue').pluck().get(), 0);
  const delivered = [], delivery = deliveryFixture(t, { storage });
  storage.deps.deliverConversation = async row => {
    assert.equal((await delivery.delivery.deliverConversation(row)).delivered, true);
    if (row.session_group === 'origin') delivered.push(row.id);
  };
  await storage.create().initialize();
  for (let round = 0; round < 12 && delivered.length < expectedOriginIds.length; round++) {
    storage.advance(1000);
    await storage.rounds();
  }
  assert.deepEqual(delivered, expectedOriginIds);
  assert.equal(storage.calls.filter(([op, input]) => op === 'launch' && input.sessionGroup === 'origin').length, 1);
});

// Run for old-row recovery, transaction atomicity, or cutover delivery. Private
// file database and bounded worker only. The worker uses the runner's private
// environment and a SQLite trigger to kill its own process before the commit.
test('interrupted historical conversion requeues only its own still-absorbed messages once', { timeout: 15000 }, async t => {
  const storage = fixture(t, {}, true);
  const { store, db, filename } = storage;
  assert.ok(fs.realpathSync(filename).startsWith(fs.realpathSync(process.env.TMPDIR) + '/'));
  const earlier = queue(db, 'older completed run');
  const previous = store.beginModeTransition('single', 'multi').runId;
  seedHistoricalAbsorption(db, previous, [earlier], { complete: true });
  const own = queue(db, 'interrupted run'), failed = queue(db, 'already resolved');
  const active = store.beginModeTransition('single', 'multi').runId;
  store.setDrainFence('*');
  seedHistoricalAbsorption(db, active, [own, failed]);
  db.prepare("UPDATE conversations SET status='failed' WHERE id=?").run(failed);
  const status = id => db.prepare('SELECT status FROM conversations WHERE id=?').pluck().get(id);
  const worker = new URL('./fixtures/mode-switch-transaction-worker.js', import.meta.url);
  const crashed = spawnSync(process.execPath, [worker.pathname, filename, active], { encoding: 'utf8', timeout: 5000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  assert.equal(store.getModeTransition().phase, 'converting');
  assert.equal(status(own), 'switch_absorbed');
  let mode = 'single';
  const owner = () => cutover(store, () => modeReader(mode), target => { mode = target; });
  await owner().advance();
  assert.equal(store.getModeTransition().phase, 'cutover');
  assert.equal(status(own), 'pending');
  await owner().advance();
  assert.equal(store.getModeTransition(), null);
  assert.equal(status(earlier), 'switch_absorbed');
  assert.equal(status(failed), 'failed');
  assert.equal(store.getAbsorbedConversations(previous)[0].id, earlier);
  await deliverOrigin(t, storage, [own]);
  await owner().advance();
  assert.equal(status(own), 'delivered');
});
