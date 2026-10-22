import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function fixture(t, filename = ':memory:') {
  const db = new Database(filename); t.after(() => { if (db.open) db.close(); }); guardDatabase(db, owner);
  const store = createStore(db, { validateComponent: () => true });
  const state = () => ({ transitions: db.prepare('SELECT * FROM mode_transitions ORDER BY rowid').all(), messages: db.prepare('SELECT * FROM conversations ORDER BY id').all(), checkpoints: db.prepare('SELECT * FROM checkpoints ORDER BY id').all(), fences: db.prepare('SELECT * FROM drain_fences ORDER BY session_group').all() });
  return { db, store, state };
}
function converting(store, source = 'single') {
  const { runId } = store.beginModeTransition(source, source === 'single' ? 'multi' : 'single'); store.setDrainFence('*'); store.absorbForTransition(runId); return runId;
}
test('DM-28 absorption includes legacy empty scope, snapshots original coverage, and is replay stable', t => {
  const { db, store } = fixture(t);
  const a = store.insertConversation('out', 'foo', 'e', 'covered'); store.createCheckpoint('*', a.id, 'global');
  const b = store.insertConversation('in', 'foo', 'e', 'pending');
  const c = store.insertConversation('in', 'bar', 'e', 'pending');
  const legacy = Number(db.prepare("INSERT INTO conversations(direction,channel,content,status,session_group) VALUES('in','old','legacy','pending','')").run().lastInsertRowid);
  const runId = converting(store); const first = store.absorbForTransition(runId);
  assert.deepEqual(first, { cutoff: legacy, coverageSnapshot: { '*': a.id }, absorbedIds: [b.id, c.id, legacy] });
  assert.deepEqual(db.prepare("SELECT id FROM conversations WHERE status='switch_absorbed' ORDER BY id").all().map(x => x.id), first.absorbedIds);
  const later = store.insertConversation('in', 'new', 'e', 'later');
  assert.deepEqual(store.absorbForTransition(runId), first); assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(later.id).status, 'pending');
});
test('DM-28 SQL abort after status writes rolls back D1 and all D9 progress columns', t => {
  const { db, store, state } = fixture(t); store.insertConversation('in', 'foo', 'e', 'pending');
  const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*');
  const before = state();
  db.exec("CREATE TRIGGER reject_absorb BEFORE UPDATE ON mode_transitions WHEN NEW.phase='converting' BEGIN SELECT RAISE(ABORT,'reject progress'); END");
  assert.throws(() => store.absorbForTransition(runId), { code: 'DB_WRITE_FAILED' }); assert.deepEqual(state(), before);
});
for (const moment of ['before', 'after']) test(`DM-28 process death ${moment} commit leaves one atomic absorption outcome`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'c4-transition-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'db.sqlite'); const { db, store, state } = fixture(t, filename);
  const row = store.insertConversation('in', 'foo', 'e', 'pending'); const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*');
  const before = state();
  const code = `import Database from ${JSON.stringify(require.resolve('better-sqlite3'))};
import {createStore} from ${JSON.stringify(new URL('../c4-v2-store.js', import.meta.url).href)};
const db=new Database(${JSON.stringify(filename)});
${moment === 'before' ? `db.function('kill_here',()=>process.kill(process.pid,'SIGKILL')); db.exec("CREATE TEMP TRIGGER crash_before_progress BEFORE UPDATE ON mode_transitions BEGIN SELECT kill_here(); END");` : ''}
createStore(db).absorbForTransition(${JSON.stringify(runId)});
process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  if (moment === 'before') assert.deepEqual(state(), before);
  else { assert.equal(store.getModeTransition({ runId }).phase, 'converting'); assert.deepEqual(store.getModeTransition({ runId }).absorbed_ids, [row.id]); assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(row.id).status, 'switch_absorbed'); }
});
for (const obstacle of ['extra-fence', 'running', 'missing-global']) test(`DM-29 absorption rejects ${obstacle} without any data change`, t => {
  const { store, state } = fixture(t); const row = store.insertConversation('in', 'foo', 'e', 'pending');
  if (obstacle === 'running') store.claimConversation(row.id);
  const { runId } = store.beginModeTransition('single', 'multi');
  if (obstacle !== 'missing-global') store.setDrainFence('*');
  if (obstacle === 'extra-fence') store.setDrainFence('foo', { reason: 'ttl', runId: 'old' });
  const before = state(); assert.throws(() => store.absorbForTransition(runId), { code: 'TRANSITION_PRECONDITION' }); assert.deepEqual(state(), before);
});
test('DM-30 begin enforces one open transition and all forbidden phase edges reject', t => {
  const { db, store, state } = fixture(t);
  assert.throws(() => store.beginModeTransition('single', 'single'), { code: 'TRANSITION_SAME_MODE' });
  const { runId } = store.beginModeTransition('single', 'multi'); const initial = state();
  assert.throws(() => store.beginModeTransition('multi', 'single'), { code: 'TRANSITION_OPEN' }); assert.deepEqual(state(), initial);
  assert.throws(() => db.prepare("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('other','single','multi','gating',1,1)").run(), /UNIQUE/);
  for (const phase of ['converting', 'cutover', 'complete', 'invalid']) { assert.throws(() => store.setModeTransitionPhase(runId, phase), { code: 'PHASE_TRANSITION_INVALID' }); assert.deepEqual(state(), initial); }
  store.setDrainFence('*'); store.absorbForTransition(runId);
  for (const phase of ['gating', 'complete']) assert.throws(() => store.setModeTransitionPhase(runId, phase), { code: 'PHASE_TRANSITION_INVALID' });
  store.setModeTransitionPhase(runId, 'cutover');
  for (const phase of ['gating', 'converting']) assert.throws(() => store.setModeTransitionPhase(runId, phase), { code: 'PHASE_TRANSITION_INVALID' });
  store.setModeTransitionPhase(runId, 'complete');
  for (const phase of ['gating', 'converting', 'cutover']) assert.throws(() => store.setModeTransitionPhase(runId, phase), { code: 'PHASE_TRANSITION_INVALID' });
});
test('DM-31 multi cutover writes exactly one empty content boundary and retries do not duplicate', t => {
  const { db, store } = fixture(t);
  const a = store.insertConversation('out', 'foo', 'e', 'a'); store.createCheckpoint('foo', a.id, 'summary');
  const b = store.insertConversation('in', 'foo', 'e', 'pending'); const runId = converting(store, 'multi');
  assert.deepEqual(store.getModeTransition({ runId }).coverage_snapshot, { foo: a.id });
  store.setModeTransitionPhase(runId, 'cutover'); store.setModeTransitionPhase(runId, 'cutover', { reason: 'retry' });
  const rows = db.prepare("SELECT * FROM checkpoints WHERE session_group='*' AND end_conversation_id IS NOT NULL").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].end_conversation_id, b.id); assert.equal(rows[0].summary, ''); assert.equal(rows[0].no_content, 0);
  assert.equal(store.getModeTransition({ runId }).phase, 'cutover');
});
test('DM-31 cutover boundary validation or post-checkpoint SQL failure rolls back both tables', t => {
  const { db, store, state } = fixture(t); const row = store.insertConversation('in', 'foo', 'e', 'pending'); const runId = converting(store, 'multi');
  db.prepare("UPDATE conversations SET status='pending' WHERE id=?").run(row.id);
  const gap = state(); assert.throws(() => store.setModeTransitionPhase(runId, 'cutover'), { code: 'CHECKPOINT_GAP' }); assert.deepEqual(state(), gap);
  db.prepare("UPDATE conversations SET status='switch_absorbed' WHERE id=?").run(row.id);
  const before = state(); db.exec("CREATE TRIGGER reject_cutover BEFORE UPDATE ON mode_transitions WHEN NEW.phase='cutover' BEGIN SELECT RAISE(ABORT,'reject cutover'); END");
  assert.throws(() => store.setModeTransitionPhase(runId, 'cutover'), { code: 'DB_WRITE_FAILED' }); assert.deepEqual(state(), before);
});
for (const obstacle of ['extra-fence', 'manual-global', 'phase-write-fails', 'none']) test(`DM-32 complete and fence removal are atomic with ${obstacle}`, t => {
  const { db, store, state } = fixture(t); store.insertConversation('in', 'foo', 'e', 'pending'); const runId = converting(store); store.setModeTransitionPhase(runId, 'cutover');
  if (obstacle === 'extra-fence') store.setDrainFence('foo', { reason: 'ttl', runId: 'old' });
  if (obstacle === 'manual-global') db.prepare("UPDATE drain_fences SET reason='manual_restart',run_id='other' WHERE session_group='*'").run();
  if (obstacle === 'phase-write-fails') db.exec("CREATE TRIGGER reject_complete BEFORE UPDATE ON mode_transitions WHEN NEW.phase='complete' BEGIN SELECT RAISE(ABORT,'reject complete'); END");
  const before = state();
  if (obstacle === 'none') { store.setModeTransitionPhase(runId, 'complete'); assert.equal(store.getDrainFence('*'), null); assert.equal(store.getModeTransition({ runId }).phase, 'complete'); }
  else { assert.throws(() => store.setModeTransitionPhase(runId, 'complete'), { code: obstacle === 'phase-write-fails' ? 'DB_WRITE_FAILED' : 'TRANSITION_PRECONDITION' }); assert.deepEqual(state(), before); }
});
test('calibration: atomicity assertion detects split transaction mutant', async t => {
  const { readFileSync } = await import('node:fs');
  const absolutize = (source, base) => source.replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, base).href}'`);
  const transitionURL = new URL('../c4-store-transition.js', import.meta.url);
  const source = readFileSync(transitionURL, 'utf8');
  const needle = '      run(c, "UPDATE mode_transitions SET cutoff=';
  assert.ok(source.includes(needle), 'mutation anchor must exist');
  // Intentionally commit D1 first: rollback of the later D9 failure can no
  // longer undo absorption. Dynamic modules keep the live source untouched.
  const badSource = source.replace(needle, '      c.exec("COMMIT; BEGIN IMMEDIATE");\n' + needle);
  const mutant = 'data:text/javascript;base64,' + Buffer.from(absolutize(badSource, transitionURL)).toString('base64');
  const storeURL = new URL('../c4-v2-store.js', import.meta.url);
  const storeSource = absolutize(readFileSync(storeURL, 'utf8'), storeURL).replace(transitionURL.href, mutant);
  const { createStore: mutatedCreateStore } = await import('data:text/javascript;base64,' + Buffer.from(storeSource).toString('base64'));
  for (const create of [createStore, mutatedCreateStore]) {
    const { db, state } = fixture(t); const store = create(db, { validateComponent: () => true });
    store.insertConversation('in', 'foo', 'e', 'pending'); const { runId } = store.beginModeTransition('single', 'multi'); store.setDrainFence('*'); const before = state();
    db.exec("CREATE TRIGGER reject_absorb BEFORE UPDATE ON mode_transitions WHEN NEW.phase='converting' BEGIN SELECT RAISE(ABORT,'reject progress'); END");
    assert.throws(() => store.absorbForTransition(runId), { code: 'DB_WRITE_FAILED' });
    const acceptance = () => assert.deepEqual(state(), before);
    if (create === createStore) acceptance(); else assert.throws(acceptance, assert.AssertionError);
  }
});
