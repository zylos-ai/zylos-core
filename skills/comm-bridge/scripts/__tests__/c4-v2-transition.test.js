import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
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

async function modifiedStore(moduleName, before, after) {
  const moduleURL = new URL(`../${moduleName}`, import.meta.url);
  const absoluteImports = (source, base) => source.replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, base).href}'`);
  const source = readFileSync(moduleURL, 'utf8');
  assert.ok(source.includes(before), 'mutation anchor must exist');
  const mutated = absoluteImports(source.replace(before, after), moduleURL);
  const uri = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const storeURL = new URL('../c4-v2-store.js', import.meta.url);
  const storeSource = moduleName === 'c4-v2-store.js' ? mutated
    : absoluteImports(readFileSync(storeURL, 'utf8'), storeURL).replace(moduleURL.href, uri(mutated));
  return (await import(uri(storeSource))).createStore;
}
for (const order of ['created_at DESC', 'updated_at DESC,rowid DESC', 'updated_at DESC,created_at DESC,rowid ASC']) {
  test(`getLastCompletedModeTransition calibration rejects ordering mutant: ${order}`, async t => {
    const mutant = await modifiedStore('c4-store-transition.js', 'updated_at DESC,created_at DESC,rowid DESC', order);
    assert.throws(() => checkCompletedOrdering(t, mutant), assert.AssertionError);
  });
}

test('getLastCompletedModeTransition: injected driver busy maps to DB_BUSY, not null', async t => {
  const { db } = fixture(t);
  const mutant = await modifiedStore('c4-v2-store.js',
    "if (error.code?.startsWith('SQLITE_BUSY')) throw dataError('DB_BUSY', error.message, { cause: error });",
    "if (error.code?.startsWith('SQLITE_BUSY')) return null;");
  const nativePrepare = db.prepare;
  db.prepare = function(sql) {
    if (sql.includes("WHERE phase='complete'")) throw Object.assign(new Error('controlled driver busy'), { code: 'SQLITE_BUSY' });
    return nativePrepare.call(this, sql);
  };
  try {
    const acceptance = create => assert.throws(() => create(db).getLastCompletedModeTransition(), { code: 'DB_BUSY', persisted: [] });
    acceptance(createStore);
    assert.throws(() => acceptance(mutant), assert.AssertionError);
  } finally { db.prepare = nativePrepare; }
});

test('getLastCompletedModeTransition: NORMAL WAL reads committed row while writer holds, then new row after commit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'c4-last-completed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'db.sqlite');
  const seed = new Database(filename); guardDatabase(seed, owner);
  assert.equal(seed.pragma('journal_mode=WAL', { simple: true }), 'wal');
  completedRows(seed)('committed', 10, 20); seed.close();
  const source = `import Database from ${JSON.stringify(require.resolve('better-sqlite3'))};
    const db = new Database(process.argv[1]);
    db.exec("BEGIN IMMEDIATE; UPDATE mode_transitions SET reason='new-committed'");
    process.send({ mode: db.pragma('locking_mode', { simple: true }), journal: db.pragma('journal_mode', { simple: true }), inTransaction: db.inTransaction });
    process.on('message', () => { db.exec('COMMIT'); db.close(); process.exit(0); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const [locked] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`writer exited before barrier: ${stderr}`); })]);
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
    assert.equal(code, 0, stderr); assert.equal(signal, null);
    assert.deepEqual(store.getLastCompletedModeTransition(), { ...old, reason: 'new-committed' });
  } finally { reader.close(); }
});


// DM-62 / P01: library snapshots and static Router census. Directory/skeleton
// creation and real Router transport belong to P10/P04 integration, not this test.
function dm62Heads(reader) {
  return reader.prepare('SELECT session_group, head_id FROM group_heads ORDER BY session_group COLLATE BINARY')
    .all().map(row => ({ sessionGroup: row.session_group, headId: row.head_id }));
}
function assertDm62Heads(actual, expected) {
  assert.deepEqual(actual, expected, 'DM-62 conversion must include every group and its current head');
}
function assertDm62RouterCensus(sources) {
  // Include aliases/imports as well as calls: a newly imported D6 reader must
  // trigger review even when hidden behind a local name. Direct SQL is forbidden.
  const d6Readers = /\b(?:group_heads|listGroupHeads|listGroups|getLastActivity|getOriginSyncBacklog|absorbForTransition)\b/;
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, d6Readers, `DM-62 Router must not access D6: ${name}`);
  }
}
const dm62RouterSources = () => [
  ['c4-dispatcher.js', readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8')],
  ['message-router.js', readFileSync(new URL('../../../activity-monitor/scripts/message-router.js', import.meta.url), 'utf8')],
];
function dm62Fixture(t, create = createStore) {
  const dir = mkdtempSync(join(tmpdir(), 'c4-dm62-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'db.sqlite');
  const { db } = fixture(t, filename);
  const store = create(db, { validateComponent: () => true });
  const reader = new Database(filename, { readonly: true, fileMustExist: true });
  t.after(() => reader.close());
  const origin = store.insertConversation('in', 'system', null, 'origin');
  const whole = store.insertConversation('in', 'chat', null, 'whole');
  const subgroup = store.insertConversation('in', 'chat', 'room', 'subgroup', { groupName: 'room' });
  const beforeGate = dm62Heads(reader);
  assert.deepEqual(beforeGate, [
    { sessionGroup: 'chat', headId: whole.id },
    { sessionGroup: 'chat:room', headId: subgroup.id },
    { sessionGroup: 'origin', headId: origin.id },
  ]);
  const { runId } = store.beginModeTransition('single', 'multi');
  store.setDrainFence('*');
  const duringGate = store.insertConversation('in', 'chat', 'gated', 'during gate', { groupName: 'gated' });
  assert.equal(reader.prepare('SELECT phase FROM mode_transitions WHERE run_id=?').get(runId).phase, 'gating');
  const { cutoff } = store.absorbForTransition(runId);
  assert.equal(reader.prepare('SELECT phase FROM mode_transitions WHERE run_id=?').get(runId).phase, 'converting');
  assert.ok(dm62Heads(reader).some(row => row.headId === duringGate.id));
  return { db, reader, store, runId, cutoff, beforeGate };
}
function dm62Snapshot(db, reader, store) {
  const before = allTables(reader);
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const sql = [], prepare = db.prepare;
  db.prepare = function(statement) { sql.push(statement); return prepare.call(this, statement); };
  db.pragma('query_only=ON');
  let heads;
  try { heads = store.listGroupHeads(); }
  finally { db.pragma('query_only=OFF'); db.prepare = prepare; }
  assertDm62Heads(heads, dm62Heads(reader));
  assert.equal(sql.length, 1, 'DM-62 snapshot must use one statement');
  assert.match(sql[0], /^SELECT\b/i);
  assert.deepEqual(allTables(reader), before, 'DM-62 snapshot must not change any table');
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  return heads;
}
test('DM-62 full heads snapshots include gated and post-cutoff groups; delivery primitives never read D6', t => {
  const { db, reader, store, runId, cutoff, beforeGate } = dm62Fixture(t);
  const first = dm62Snapshot(db, reader, store);
  assert.equal(first.length, beforeGate.length + 1);
  // Keep the global gate active while a second connection writes a new group
  // and advances an existing head after the frozen absorption cutoff.
  const writer = new Database(db.name);
  try {
    const incoming = createStore(writer, { validateComponent: () => true });
    const late = incoming.insertConversation('in', 'chat', 'A', 'after cutoff', { groupName: 'A' });
    const advance = incoming.insertConversation('in', 'chat', 'room', 'advance', { groupName: 'room' });
    assert.ok(late.id > cutoff); assert.ok(advance.id > cutoff);
    const second = dm62Snapshot(db, reader, store);
    assert.equal(second.length, first.length + 1);
    assert.equal(second.find(row => row.sessionGroup === 'chat:room').headId, advance.id);
    assert.ok(!first.some(row => row.sessionGroup === 'chat:A'), 'earlier result remains a snapshot');
    assert.equal(first.find(row => row.sessionGroup === 'chat:room').headId, beforeGate.find(row => row.sessionGroup === 'chat:room').headId);
    assert.deepEqual(second.map(row => row.sessionGroup), ['chat', 'chat:A', 'chat:gated', 'chat:room', 'origin']);
    store.setModeTransitionPhase(runId, 'cutover');
    store.setModeTransitionPhase(runId, 'complete');
    const headsBeforeDelivery = dm62Heads(reader);
    const sql = [], prepare = db.prepare;
    db.prepare = function(statement) { sql.push(statement); return prepare.call(this, statement); };
    try {
      const next = store.getNextPending();
      assert.equal(next.id, late.id);
      assert.equal(store.claimConversation(next.id), true);
      assert.equal(store.markDelivered(next.id, { sessionId: 'dm62-isolated-session' }), true);
    } finally { db.prepare = prepare; }
    assert.ok(sql.length > 0);
    for (const statement of sql) assert.doesNotMatch(statement, /\bgroup_heads\b/i, 'DM-62 delivery must not read D6');
    assert.deepEqual(reader.prepare('SELECT status,session_id FROM conversations WHERE id=?').get(late.id),
      { status: 'delivered', session_id: 'dm62-isolated-session' });
    assert.deepEqual(dm62Heads(reader), headsBeforeDelivery);
  } finally { writer.close(); }
  assertDm62RouterCensus(dm62RouterSources());
});
test('DM-62 calibration: omission of one conversion group turns the same oracle red', async t => {
  const mutant = await modifiedStore('c4-store-transition.js',
    'FROM group_heads ORDER BY session_group COLLATE BINARY',
    "FROM group_heads WHERE session_group<>\\'chat:gated\\' ORDER BY session_group COLLATE BINARY");
  const { db, reader, store } = dm62Fixture(t, mutant);
  assert.throws(() => dm62Snapshot(db, reader, store), error => {
    assert.ok(error instanceof assert.AssertionError);
    assert.match(error.message, /DM-62 conversion must include every group/);
    t.diagnostic(`EXPECTED RED: ${error.message.split('\n')[0]}`);
    return true;
  });
});
for (const access of ['listGroupHeads()', "db.prepare('SELECT * FROM group_heads').all()", 'getLastActivity(group)']) {
  test(`DM-62 calibration: Router access ${access} turns the same census red`, t => {
    const sources = dm62RouterSources();
    assertDm62RouterCensus(sources);
    sources[0][1] += `\n${access};\n`;
    assert.throws(() => assertDm62RouterCensus(sources), error => {
      assert.ok(error instanceof assert.AssertionError);
      assert.match(error.message, /DM-62 Router must not access D6/);
      t.diagnostic(`EXPECTED RED: DM-62 Router must not access D6 (${access})`);
      return true;
    });
  });
}
