import { fixture as storeFixture, startHeldWriter } from './c4-v2-test-helpers.js';
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
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
function fixture(t, filename = ':memory:') {
  const { db, store } = storeFixture(t, {}, filename);
  const state = () => ({ transitions: db.prepare('SELECT * FROM mode_transitions ORDER BY rowid').all(), messages: db.prepare('SELECT * FROM conversations ORDER BY id').all(), checkpoints: db.prepare('SELECT * FROM checkpoints ORDER BY id').all(), fences: db.prepare('SELECT * FROM drain_fences ORDER BY session_group').all() });
  return { db, store, state };
}
function converting(store) {
  const { runId } = store.beginModeTransition('single', 'multi', { kind: 'first_migration' }); store.setDrainFence('*'); store.absorbForTransition(runId); return runId;
}
for (const [source, target] of [['multi', 'single'], ['single', 'single'], ['multi', 'multi']]) test(`first migration rejects ${source} to ${target} before writing`, t => {
  const { db, store, state } = fixture(t);
  store.insertConversation('in', 'foo', 'e', 'pending');
  const before = state(), changes = db.prepare('SELECT total_changes() AS n').get().n;
  assert.throws(() => store.beginModeTransition(source, target, { kind: 'first_migration' }),
    { code: source === target ? 'TRANSITION_SAME_MODE' : 'TRANSITION_PRECONDITION', persisted: [] });
  assert.deepEqual(state(), before); assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
});
for (const phase of ['gating', 'converting']) test(`absorption rejects a persisted reverse first migration in ${phase} without writes`, t => {
  const { db, store, state } = fixture(t);
  const message = store.insertConversation('in', 'foo', 'e', 'pending');
  const { runId } = store.beginModeTransition('single', 'multi', { kind: 'first_migration' }); store.setDrainFence('*');
  // Persist a malformed historical record directly, without using a reverse writer.
  db.prepare("UPDATE mode_transitions SET source_mode='multi',target_mode='single',phase=?,cutoff=?,coverage_snapshot=?,absorbed_ids=? WHERE run_id=?")
    .run(phase, phase === 'gating' ? null : message.id, phase === 'gating' ? null : '{}', phase === 'gating' ? null : '[]', runId);
  const before = state(), changes = db.prepare('SELECT total_changes() AS n').get().n;
  assert.throws(() => store.absorbForTransition(runId), { code: 'TRANSITION_PRECONDITION', persisted: [] });
  assert.deepEqual(state(), before); assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
});
test('absorption includes legacy empty scope, snapshots original coverage, and is replay stable', t => {
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
test('SQL abort after status writes rolls back and all progress columns', t => {
  const { db, store, state } = fixture(t); store.insertConversation('in', 'foo', 'e', 'pending');
  const { runId } = store.beginModeTransition('single', 'multi', { kind: 'first_migration' }); store.setDrainFence('*');
  const before = state();
  db.exec("CREATE TRIGGER reject_absorb BEFORE UPDATE ON mode_transitions WHEN NEW.phase='converting' BEGIN SELECT RAISE(ABORT,'reject progress'); END");
  assert.throws(() => store.absorbForTransition(runId), { code: 'DB_WRITE_FAILED' }); assert.deepEqual(state(), before);
});
for (const moment of ['before', 'after']) test(`process death ${moment} commit leaves one atomic absorption outcome`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'c4-transition-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'db.sqlite'); const { db, store, state } = fixture(t, filename);
  const row = store.insertConversation('in', 'foo', 'e', 'pending'); const { runId } = store.beginModeTransition('single', 'multi', { kind: 'first_migration' }); store.setDrainFence('*');
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
for (const obstacle of ['extra-fence', 'running', 'missing-global']) test(`absorption rejects ${obstacle} without any data change`, t => {
  const { store, state } = fixture(t); const row = store.insertConversation('in', 'foo', 'e', 'pending');
  if (obstacle === 'running') store.claimConversation(row.id);
  const { runId } = store.beginModeTransition('single', 'multi', { kind: 'first_migration' });
  if (obstacle !== 'missing-global') store.setDrainFence('*');
  if (obstacle === 'extra-fence') store.setDrainFence('foo', { reason: 'ttl', runId: 'old' });
  const before = state(); assert.throws(() => store.absorbForTransition(runId), { code: 'TRANSITION_PRECONDITION' }); assert.deepEqual(state(), before);
});
test('begin enforces one open transition and all forbidden phase edges reject', t => {
  const { db, store, state } = fixture(t);
  assert.throws(() => store.beginModeTransition('single', 'single'), { code: 'TRANSITION_SAME_MODE' });
  const { runId } = store.beginModeTransition('single', 'multi', { kind: 'first_migration' }); const initial = state();
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
test('cutover never writes a global checkpoint, including historical multi-source conversion rows', t => {
  const { db, store } = fixture(t);
  const message = store.insertConversation('in', 'foo', 'e', 'pending');
  const runId = randomUUID();
  db.prepare("INSERT INTO mode_transitions(run_id,source_mode,target_mode,kind,phase,cutoff,coverage_snapshot,absorbed_ids,created_at,updated_at) VALUES(?,'multi','single','switch','converting',?,'{}',?,1,1)").run(runId, message.id, JSON.stringify([message.id]));
  db.prepare("UPDATE conversations SET status='switch_absorbed' WHERE id=?").run(message.id);
  const before = db.prepare('SELECT * FROM checkpoints').all();
  store.setModeTransitionPhase(runId, 'cutover');
  store.setModeTransitionPhase(runId, 'cutover', { reason: 'retry' });
  assert.deepEqual(db.prepare('SELECT * FROM checkpoints').all(), before);
});
for (const obstacle of ['extra-fence', 'manual-global', 'phase-write-fails', 'none']) test(`complete and fence removal are atomic with ${obstacle}`, t => {
  const { db, store, state } = fixture(t); store.insertConversation('in', 'foo', 'e', 'pending'); const runId = converting(store); store.setModeTransitionPhase(runId, 'cutover');
  if (obstacle === 'extra-fence') store.setDrainFence('foo', { reason: 'ttl', runId: 'old' });
  if (obstacle === 'manual-global') db.prepare("UPDATE drain_fences SET reason='manual_restart',run_id='other' WHERE session_group='*'").run();
  if (obstacle === 'phase-write-fails') db.exec("CREATE TRIGGER reject_complete BEFORE UPDATE ON mode_transitions WHEN NEW.phase='complete' BEGIN SELECT RAISE(ABORT,'reject complete'); END");
  const before = state();
  if (obstacle === 'none') { store.setModeTransitionPhase(runId, 'complete'); assert.equal(store.getDrainFence('*'), null); assert.equal(store.getModeTransition({ runId }).phase, 'complete'); }
  else { assert.throws(() => store.setModeTransitionPhase(runId, 'complete'), { code: obstacle === 'phase-write-fails' ? 'DB_WRITE_FAILED' : 'TRANSITION_PRECONDITION' }); assert.deepEqual(state(), before); }
});
// Snapshot every table independently; total_changes also detects writes later undone.
function allTables(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}
function assertLastCompleted(db, store, expectedId) {
  const raw = expectedId === null ? null : db.prepare('SELECT * FROM mode_transitions WHERE run_id=?').get(expectedId);
  const expected = raw && { ...raw, coverage_snapshot: JSON.parse(raw.coverage_snapshot), absorbed_ids: JSON.parse(raw.absorbed_ids) };
  const before = allTables(db), changes = db.prepare('SELECT total_changes() AS n').get().n;
  db.pragma('query_only=ON');
  try { assert.deepEqual(store.getLastCompletedModeTransition(), expected); }
  finally { db.pragma('query_only=OFF'); }
  assert.deepEqual(allTables(db), before);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
}
function completedRows(db) {
  const insert = db.prepare(`INSERT INTO mode_transitions
    (run_id,source_mode,target_mode,phase,created_at,updated_at,cutoff,coverage_snapshot,absorbed_ids,reason)
    VALUES(?,'single','multi',?,?,?,17,'{"*":3}','[4,8,17]',?)`);
  return (id, created, updated, phase = 'complete') => insert.run(id, phase, created, updated, `reason-${id}`);
}
function checkCompletedOrdering(t, create = createStore) {
  const { db } = fixture(t); const store = create(db), insert = completedRows(db);
  assertLastCompleted(db, store, null);
  insert('open', 900, 900, 'gating');
  for (const phase of ['gating', 'converting', 'cutover']) {
    db.prepare('UPDATE mode_transitions SET phase=?').run(phase);
    assertLastCompleted(db, store, null);
  }
  insert('updated-winner', 10, 100);
  insert('created-later', 20, 90);
  assertLastCompleted(db, store, 'updated-winner');
  insert('created-tie-winner', 30, 100);
  insert('lower-created-later-rowid', 25, 100);
  assertLastCompleted(db, store, 'created-tie-winner');
  insert('rowid-tie-winner', 30, 100);
  assertLastCompleted(db, store, 'rowid-tie-winner');
}
test('getLastCompletedModeTransition: empty/open null, updated_at/created_at/rowid descending, full row and no writes', t => {
  checkCompletedOrdering(t);
});

test('getLastCompletedModeTransition: injected driver busy maps to DB_BUSY, not null', async t => {
  const { db } = fixture(t);
  const nativePrepare = db.prepare;
  db.prepare = function(sql) {
    if (sql.includes("WHERE phase='complete'")) throw Object.assign(new Error('controlled driver busy'), { code: 'SQLITE_BUSY' });
    return nativePrepare.call(this, sql);
  };
  try {
    const acceptance = create => assert.throws(() => create(db).getLastCompletedModeTransition(), { code: 'DB_BUSY', persisted: [] });
    acceptance(createStore);
  } finally { db.prepare = nativePrepare; }
});

test('getLastCompletedModeTransition: NORMAL WAL reads committed row while writer holds, then new row after commit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'c4-last-completed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'db.sqlite');
  const seed = new Database(filename); guardDatabase(seed, owner);
  assert.equal(seed.pragma('journal_mode=WAL', { simple: true }), 'wal');
  completedRows(seed)('committed', 10, 20); seed.close();
  const writer = startHeldWriter(filename, "UPDATE mode_transitions SET reason='new-committed'");
  const { child, exited } = writer;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const [locked] = await writer.held;
  assert.deepEqual(locked, { mode: 'normal', journal: 'wal', inTransaction: true });
  const reader = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const store = createStore(reader);
    const before = allTables(reader), changes = reader.prepare('SELECT total_changes() AS n').get().n;
    const old = store.getLastCompletedModeTransition();
    assert.equal(old.reason, 'reason-committed');
    assert.deepEqual(old.coverage_snapshot, { '*': 3 }); assert.deepEqual(old.absorbed_ids, [4, 8, 17]);
    assert.deepEqual(allTables(reader), before);
    assert.equal(reader.prepare('SELECT total_changes() AS n').get().n, changes);
    child.send('commit'); const [code, signal] = await exited;
    assert.equal(code, 0, writer.stderr()); assert.equal(signal, null);
    assert.deepEqual(store.getLastCompletedModeTransition(), { ...old, reason: 'new-committed' });
  } finally { reader.close(); }
});


// library snapshots and static Router census. Directory/skeleton
// creation and real Router transport belong to integration, not this test.
function transitionHeads(reader) {
  return reader.prepare('SELECT session_group, head_id FROM group_heads ORDER BY session_group COLLATE BINARY')
    .all().map(row => ({ sessionGroup: row.session_group, headId: row.head_id }));
}
function assertTransitionHeads(actual, expected) {
  assert.deepEqual(actual, expected, ' conversion must include every group and its current head');
}
function assertTransitionRouterCensus(sources) {
  // Include aliases/imports as well as calls: a newly imported D6 reader must
  // trigger review even when hidden behind a local name. Direct SQL is forbidden.
  const d6Readers = /\b(?:group_heads|listGroupHeads|listGroups|getLastActivity|getOriginSyncBacklog|absorbForTransition)\b/;
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, d6Readers, ` Router must not access D6: ${name}`);
  }
}
const transitionRouterSources = () => [
  ['c4-dispatcher.js', readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8')],
  ...readdirSync(new URL('../router/', import.meta.url)).filter(name => name.endsWith('.js')).map(name =>
    [`router/${name}`, readFileSync(new URL(`../router/${name}`, import.meta.url), 'utf8')]),
  ['message-router.js', readFileSync(new URL('../../../activity-monitor/scripts/message-router.js', import.meta.url), 'utf8')],
];
function transitionFixture(t, create = createStore) {
  const dir = mkdtempSync(join(tmpdir(), 'c4-transition-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'db.sqlite');
  const { db } = fixture(t, filename);
  const store = create(db, { validateComponent: () => true });
  const reader = new Database(filename, { readonly: true, fileMustExist: true });
  t.after(() => reader.close());
  const origin = store.insertConversation('in', 'system', null, 'origin');
  const whole = store.insertConversation('in', 'chat', null, 'whole');
  const subgroup = store.insertConversation('in', 'chat', 'room', 'subgroup', { groupName: 'room' });
  const beforeGate = transitionHeads(reader);
  assert.deepEqual(beforeGate, [
    { sessionGroup: 'chat', headId: whole.id },
    { sessionGroup: 'chat:room', headId: subgroup.id },
    { sessionGroup: 'origin', headId: origin.id },
  ]);
  const { runId } = store.beginModeTransition('single', 'multi', { kind: 'first_migration' });
  store.setDrainFence('*');
  const duringGate = store.insertConversation('in', 'chat', 'gated', 'during gate', { groupName: 'gated' });
  assert.equal(reader.prepare('SELECT phase FROM mode_transitions WHERE run_id=?').get(runId).phase, 'gating');
  const { cutoff } = store.absorbForTransition(runId);
  assert.equal(reader.prepare('SELECT phase FROM mode_transitions WHERE run_id=?').get(runId).phase, 'converting');
  assert.ok(transitionHeads(reader).some(row => row.headId === duringGate.id));
  return { db, reader, store, runId, cutoff, beforeGate };
}
function transitionSnapshot(db, reader, store) {
  const before = allTables(reader);
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const sql = [], prepare = db.prepare;
  db.prepare = function(statement) { sql.push(statement); return prepare.call(this, statement); };
  db.pragma('query_only=ON');
  let heads;
  try { heads = store.listGroupHeads(); }
  finally { db.pragma('query_only=OFF'); db.prepare = prepare; }
  assertTransitionHeads(heads, transitionHeads(reader));
  assert.equal(sql.length, 1, ' snapshot must use one statement');
  assert.match(sql[0], /^SELECT\b/i);
  assert.deepEqual(allTables(reader), before, ' snapshot must not change any table');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  return heads;
}
test('full heads snapshots include gated and post-cutoff groups; delivery primitives never read', t => {
  const { db, reader, store, runId, cutoff, beforeGate } = transitionFixture(t);
  const first = transitionSnapshot(db, reader, store);
  assert.equal(first.length, beforeGate.length + 1);
  // Keep the global gate active while a second connection writes a new group
  // and advances an existing head after the frozen absorption cutoff.
  const writer = new Database(db.name);
  try {
    const incoming = createStore(writer, { validateComponent: () => true });
    const late = incoming.insertConversation('in', 'chat', 'A', 'after cutoff', { groupName: 'A' });
    const advance = incoming.insertConversation('in', 'chat', 'room', 'advance', { groupName: 'room' });
    assert.ok(late.id > cutoff); assert.ok(advance.id > cutoff);
    const second = transitionSnapshot(db, reader, store);
    assert.equal(second.length, first.length + 1);
    assert.equal(second.find(row => row.sessionGroup === 'chat:room').headId, advance.id);
    assert.ok(!first.some(row => row.sessionGroup === 'chat:A'), 'earlier result remains a snapshot');
    assert.equal(first.find(row => row.sessionGroup === 'chat:room').headId, beforeGate.find(row => row.sessionGroup === 'chat:room').headId);
    assert.deepEqual(second.map(row => row.sessionGroup), ['chat', 'chat:A', 'chat:gated', 'chat:room', 'origin']);
    store.setModeTransitionPhase(runId, 'cutover');
    store.setModeTransitionPhase(runId, 'complete');
    const headsBeforeDelivery = transitionHeads(reader);
    const sql = [], prepare = db.prepare;
    db.prepare = function(statement) { sql.push(statement); return prepare.call(this, statement); };
    try {
      const next = store.getNextPending();
      assert.equal(next.id, late.id);
      assert.equal(store.claimConversation(next.id), true);
      assert.equal(store.markDelivered(next.id, { sessionId: 'transition-isolated-session' }), true);
    } finally { db.prepare = prepare; }
    assert.ok(sql.length > 0);
    for (const statement of sql) assert.doesNotMatch(statement, /\bgroup_heads\b/i, ' delivery must not read D6');
    assert.deepEqual(reader.prepare('SELECT status,session_id FROM conversations WHERE id=?').get(late.id),
      { status: 'delivered', session_id: 'transition-isolated-session' });
    assert.deepEqual(transitionHeads(reader), headsBeforeDelivery);
  } finally { writer.close(); }
  assertTransitionRouterCensus(transitionRouterSources());
});
