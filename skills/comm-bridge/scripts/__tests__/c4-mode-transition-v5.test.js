import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

// Concurrent test files share the runner's environment. Bind configuration to
// this file's own paths before loading any module that captures them.
const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-transition-config-'));
const privateEnvironment = {
  HOME: path.join(privateRoot, 'home'),
  ZYLOS_DIR: path.join(privateRoot, 'instance'),
  PM2_HOME: path.join(privateRoot, 'pm2'),
  TMPDIR: path.join(privateRoot, 'tmp'),
  TMUX_TMPDIR: path.join(privateRoot, 'tmp'),
};
const previousEnvironment = Object.fromEntries(Object.keys(privateEnvironment).map(key => [key, process.env[key]]));
for (const [key, value] of Object.entries(privateEnvironment)) {
  fs.mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
after(() => {
  fs.rmSync(privateRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const { CONFIG_FILE } = await import('../../../../cli/lib/config.js');
const owner = await import('../c4-schema.js');
const { seedV1, snapshot } = await import('./helpers/c4-v2-fixtures.js');
const { migrateToV2 } = await import('../c4-migrations-v2.js');
const { migrateToV3 } = await import('../c4-migrations-v3.js');
const { migrateToV4 } = await import('../c4-migrations-v4.js');
const { migrateDatabase, guardDatabase } = await import('../sqlite-schema.js');
const { fixture } = await import('./c4-v2-test-helpers.js');
const { createStore } = await import('../c4-v2-store.js');
assert.equal(CONFIG_FILE, path.join(privateEnvironment.ZYLOS_DIR, '.zylos', 'config.json'));
console.log('Transition configuration isolation:', JSON.stringify({ ...privateEnvironment, CONFIG_FILE }));

// Official runner + separate Unix user; synthetic DBs only, no services.
function v4(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  seedV1(db, { extensions: true });
  migrateToV2(db); migrateToV3(db); migrateToV4(db); db.pragma('user_version=4');
  return db;
}
function migrate(db, overrides = {}) { return migrateDatabase(db, { ...owner, ...overrides }, { allowExtraTables: true, allowExtraColumns: true }); }
function config(t, value) {
  const before = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE) : null;
  fs.mkdirSync(new URL('.', `file://${CONFIG_FILE}`), { recursive: true });
  if (value === undefined) fs.rmSync(CONFIG_FILE, { force: true });
  else fs.writeFileSync(CONFIG_FILE, value);
  t.after(() => before === null ? fs.rmSync(CONFIG_FILE, { force: true }) : fs.writeFileSync(CONFIG_FILE, before));
}
function insert(db, id, source, phase, cutoff) {
  db.prepare(`INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,cutoff,coverage_snapshot,absorbed_ids,reason,created_at,updated_at)
    VALUES(?,?,?,?,?,'{"*":3}','[4,5]','preserved',10,20)`)
    .run(id, source, source === 'single' ? 'multi' : 'single', phase, cutoff);
}
for (const [label, value, expected] of [['no key', '{}', 'first_migration'], ['key', '{"session_mode":"multi"}', 'switch'], ['missing file', undefined, 'first_migration']]) {
  test(`v4 backfill reads configuration for ambiguous open rows: ${label}`, t => {
    config(t, value); const db = v4(t);
    insert(db, 'gating', 'single', 'gating', null);
    const old = db.prepare('SELECT * FROM mode_transitions').get();
    migrate(db);
    const { kind, ...retained } = db.prepare('SELECT * FROM mode_transitions').get();
    assert.equal(kind, expected); assert.deepEqual(retained, old);
    assert.equal(db.pragma('user_version', { simple: true }), 5);
  });
}
for (const [source, phase, cutoff, expected] of [
  ['single','converting',9,'first_migration'],
  ['multi','cutover',9,'switch'],
  ['single','complete',null,'switch'],
]) test(`v4 ${source}/${phase}/${cutoff} backfills ${expected} without reading invalid configuration`, t => {
  config(t, '{broken'); const db = v4(t); insert(db, 'old', source, phase, cutoff);
  const before = db.prepare('SELECT * FROM mode_transitions').get(); migrate(db);
  const { kind, ...row } = db.prepare('SELECT * FROM mode_transitions').get();
  assert.equal(kind, expected); assert.deepEqual(row, before);
});
for (const invalid of ['{broken', '{"session_mode":"both"}']) test(`unreadable configuration rolls back ambiguous backfill: ${invalid}`, t => {
  config(t, invalid); const db = v4(t); insert(db, 'old', 'single', 'gating', null);
  const before = snapshot(db); assert.throws(() => migrate(db)); assert.deepEqual(snapshot(db), before);
});
test('copy failure rolls back all DDL, rows and version, preserving deployment objects', t => {
  const db = v4(t); insert(db, 'old', 'single', 'complete', 9);
  insert(db, 'second', 'multi', 'complete', 10);
  let failCopy = false, copied = 0;
  db.function('copy_guard', () => {
    copied++;
    if (failCopy && copied === 2) throw new Error('injected copy failure');
    return 1;
  });
  db.exec(`ALTER TABLE mode_transitions ADD COLUMN local_tag TEXT DEFAULT 'kept' CHECK(local_tag<>'' AND copy_guard());
    ALTER TABLE mode_transitions ADD COLUMN local_upper TEXT GENERATED ALWAYS AS (upper(local_tag)) VIRTUAL;
    CREATE INDEX local_transition_index ON mode_transitions(local_tag);
    CREATE TRIGGER local_transition_trigger AFTER UPDATE ON mode_transitions BEGIN SELECT 1; END`);
  const before = snapshot(db);
  failCopy = true; copied = 0;
  assert.throws(() => migrate(db), /injected copy failure/);
  assert.equal(copied, 2, 'the second copied row aborts after the first row was inserted');
  failCopy = false;
  assert.deepEqual(snapshot(db), before);
  migrate(db);
  assert.equal(db.prepare('SELECT local_tag,local_upper FROM mode_transitions').get().local_upper, 'KEPT');
  for (const name of ['local_transition_index','local_transition_trigger']) assert.ok(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name));
});
test('foreign references and ambiguous phase checks fail closed', t => {
  for (const foreign of [true, false]) {
    const db = v4(t);
    if (foreign) db.exec('CREATE TABLE local_link(id TEXT REFERENCES mode_transitions(run_id))');
    else {
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='mode_transitions'").get().sql;
      db.exec('DROP TABLE mode_transitions'); db.exec(sql.replace("CHECK (phase IN ('gating','converting','cutover','complete'))", 'CHECK(length(phase)>0)'));
    }
    const before = snapshot(db); assert.throws(() => migrate(db)); assert.deepEqual(snapshot(db), before);
  }
});
for (const start of [0,1]) test(`${start}->5 preserves v1 extensions`, t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  if (start) { seedV1(db, { extensions: true }); migrate(db); }
  else guardDatabase(db, owner);
  assert.equal(owner.inspectSchema(db, { allowExtraTables: true, allowExtraColumns: true }).version, 5);
  if (start) assert.equal(db.prepare('SELECT note FROM user_notes').get().note, 'retained');
});
test('completed filters identify conversions by cutoff, independent of backfilled kind', t => {
  config(t, '{broken'); const db = v4(t);
  insert(db, 'legacy-multi', 'single', 'complete', 9);
  insert(db, 'legacy-single', 'multi', 'complete', 10);
  db.prepare("UPDATE mode_transitions SET updated_at=21 WHERE run_id='legacy-single'").run();
  migrate(db); const store = createStore(db);
  const { runId } = store.beginModeTransition('single','multi'); store.setDrainFence('*');
  store.setModeTransitionPhase(runId,'cutover'); store.setModeTransitionPhase(runId,'complete');
  assert.equal(store.getLastCompletedModeTransition().run_id, runId);
  assert.equal(store.getLastCompletedModeTransition({ memoryConversion: true }).run_id, 'legacy-single');
  assert.equal(store.getLastCompletedModeTransition({ memoryConversion: true, targetMode: 'multi' }).run_id, 'legacy-multi');
  for (const options of [{ targetMode:'both' },{ memoryConversion:1 },{ deadlineAt:1 },null,[]]) assert.throws(() => store.getLastCompletedModeTransition(options), { code:'INVALID_ARGS' });
});
test('gating cancellation restores normal endings, leaves active group fences and does not invent crash records', t => {
  let now = 100;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  store.recordRunEnd('b', { runId:'before', reason:'ttl' });
  const { runId } = store.beginModeTransition('multi','single'); store.setDrainFence('*');
  store.setDrainFence('still-draining', { reason:'mode_switch', runId:'late' });
  for (const [group,reason] of [['a','mode_switch'],['d','upgrade'],['origin','upgrade'],['f','ttl'],['auth','auth'],['model','model_config'],['manual','manual_restart'],['crash','unexpected']]) {
    store.recordRunEnd(group, { runId:group, reason }); assert.equal(store.listRunEndings([group])[0].continuationPending, 0);
  }
  const untouched = ['conversations','control_queue','checkpoints','origin_sync_cursors'].map(name => db.prepare(`SELECT * FROM ${name}`).all());
  const result = store.setModeTransitionPhase(runId,'cancelled'); assert.equal(result.resumedGroups, 7);
  assert.equal(store.getModeTransition(), null); assert.equal(store.getDrainFence('*'), null);
  assert.ok(store.getDrainFence('still-draining'));
  assert.equal(db.prepare("SELECT 1 FROM run_endings WHERE session_group='absent-crash'").get(), undefined);
  for (const group of ['f','b']) assert.equal(store.listRunEndings([group])[0].continuationPending,0);
  assert.deepEqual(['conversations','control_queue','checkpoints','origin_sync_cursors'].map(name => db.prepare(`SELECT * FROM ${name}`).all()), untouched);
  now++; store.recordRunEnd('still-draining', { runId:'late',reason:'mode_switch',clearFence:true });
  assert.equal(store.listRunEndings(['still-draining'])[0].continuationPending,1);
  for (const phase of ['gating','cutover','complete','cancelled']) assert.throws(() => store.setModeTransitionPhase(runId,phase));
  assert.equal(store.getLastCompletedModeTransition(), null);
  assert.ok(store.beginModeTransition('single','multi').runId);
});
test('cancellation excludes origin manual restarts from continuation markers and counts', t => {
  const { db, store } = fixture(t);
  const { runId } = store.beginModeTransition('multi', 'single');
  store.setDrainFence('*');
  for (const group of ['origin', 'ordinary']) {
    store.recordRunEnd(group, { runId: `${group}-manual`, reason: 'manual_restart' });
    assert.equal(store.listRunEndings([group])[0].continuationPending, 0);
  }
  const result = store.setModeTransitionPhase(runId, 'cancelled');
  assert.equal(store.listRunEndings(['origin'])[0].continuationPending, 0);
  assert.equal(store.listRunEndings(['ordinary'])[0].continuationPending, 1);
  assert.equal(result.resumedGroups, 1);
  assert.equal(db.prepare('SELECT SUM(continuation_pending) AS count FROM run_endings').get().count, 1);
});
test('cancellation before the global gate is written restores markers and preserves other tables', t => {
  let now = 100;
  const { db, store } = fixture(t, { now: () => now * 1000 });
  const { runId } = store.beginModeTransition('multi', 'single');
  store.insertConversation('in', 'demo', 'room', 'pending input');
  store.insertControl('pending operation', { sessionGroup: 'origin', appendAckSuffix: false });
  store.setDrainFence('still-draining', { reason: 'mode_switch', runId: 'old-run' });
  store.recordRunEnd('a', { runId: 'a-run', reason: 'upgrade' });
  store.recordRunEnd('cold', { runId: 'cold-run', reason: 'ttl' });
  assert.equal(store.getDrainFence('*'), null);
  const unchanged = () => Object.fromEntries(['drain_fences', 'conversations', 'control_queue', 'checkpoints']
    .map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  const before = unchanged();
  const transitionBefore = store.getModeTransition({ runId });
  const endingsBefore = store.listRunEndings(['a', 'cold']);
  now++;
  const { resumedGroups, ...transition } = store.setModeTransitionPhase(runId, 'cancelled');
  assert.equal(resumedGroups, 1);
  assert.deepEqual(transition, { ...transitionBefore, phase: 'cancelled', updated_at: now });
  assert.deepEqual(store.listRunEndings(['a', 'cold']), endingsBefore.map(row =>
    row.sessionGroup === 'a' ? { ...row, continuationPending: 1 } : row));
  assert.deepEqual(unchanged(), before);
  assert.equal(store.getModeTransition(), null);
  assert.ok(store.beginModeTransition('multi', 'single').runId);
});
for (const obstacle of ['converting','cutover','first_migration','manual-fence','write-failure']) test(`cancel rejects ${obstacle} atomically`, t => {
  const { db, store } = fixture(t);
  const { runId } = store.beginModeTransition('multi','single', { kind:obstacle==='first_migration' ? 'first_migration':'switch' });
  store.setDrainFence('*');
  store.recordRunEnd('a',{runId:'a',reason:'upgrade'});
  if (['converting','cutover'].includes(obstacle)) db.prepare('UPDATE mode_transitions SET phase=?').run(obstacle);
  if (obstacle === 'manual-fence') db.exec("UPDATE drain_fences SET reason='manual_restart',run_id='manual'");
  if (obstacle === 'write-failure') db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON mode_transitions WHEN NEW.phase='cancelled' BEGIN SELECT RAISE(ABORT,'injected cancel failure'); END");
  const before = snapshot(db);
  assert.throws(() => store.setModeTransitionPhase(runId,'cancelled'), { code:obstacle==='write-failure'?'DB_WRITE_FAILED':'TRANSITION_PRECONDITION' });
  assert.deepEqual(snapshot(db), before);
});
test('kind validation, same-mode rejection and native absorption refusal are zero-write', t => {
  const { db, store } = fixture(t);
  for (const kind of ['switch','first_migration']) assert.throws(() => store.beginModeTransition('single','single',{kind}), {code:'TRANSITION_SAME_MODE'});
  for (const kind of ['other',null,1]) assert.throws(() => store.beginModeTransition('single','multi',{kind}),{code:'INVALID_ARGS'});
  const { runId }=store.beginModeTransition('single','multi');
  store.setDrainFence('*');
  const before=snapshot(db); assert.throws(()=>store.absorbForTransition(runId),{code:'TRANSITION_PRECONDITION'}); assert.deepEqual(snapshot(db),before);
  assert.throws(()=>db.exec("UPDATE mode_transitions SET kind='other'"),/CHECK/);
  assert.throws(()=>db.exec("UPDATE mode_transitions SET target_mode=source_mode"),/CHECK/);
});

for (const open of [false,true]) test(`cancelled history ${open?'with gating blocks':'alone permits'} all deletion entries and control/binding readers`, async t => {
  const target = { runId:'live', runtime:'claude', sessionGroup:'origin', currentSession:{runId:'live',sessionId:'s'}, tmuxTarget:{serverGeneration:'g',sessionId:'$1',paneId:'%1'} };
  const { db,store }=fixture(t,{ resolveTarget:()=>target });
  const {runId}=store.beginModeTransition('multi','single'); store.setDrainFence('*'); store.setModeTransitionPhase(runId,'cancelled');
  store.registerChannelNamespace('dashboard','dashboard');
  const draftKey=JSON.stringify(['draft','dashboard','draft']);
  const draftOptions={operationId:'draft-op',actor:'owner',targetKey:draftKey,cutoffId:0};
  store.beginDraftDeletion('draft',draftOptions);
  store.beginGroupDeletion('demo',{operationId:'group-op',actor:'owner',cutoffId:0});
  if(open) db.exec("INSERT INTO mode_transitions(run_id,source_mode,target_mode,phase,created_at,updated_at) VALUES('open','single','multi','gating',1,1)");
  const actions=[
    ()=>store.beginDraftDeletion('another',{...draftOptions,operationId:'new-op',targetKey:JSON.stringify(['draft','dashboard','another'])}),
    ()=>store.finalizeDraftDeletion('draft',{operationId:'draft-op'}),
    ()=>store.beginGroupDeletion('other',{operationId:'other-op',actor:'owner',cutoffId:0}),
    ()=>store.finalizeGroupDeletion('demo',{operationId:'group-op'}),
  ];
  for(const action of actions) { if(open) assert.throws(action,{code:'TRANSITION_OPEN'}); else action(); }
  const binding=()=>store.buildTargetBinding({sessionGroup:'origin',expectedRunId:'live'});
  if(open) await assert.rejects(binding,{code:'TRANSITION_OPEN'}); else assert.ok(await binding());
  store.recordRunEnd('origin',{runId:'ended',reason:'upgrade'});
  assert.equal(store.listRunEndings(['origin'])[0].continuationPending,open?0:1);
  assert.equal(store.getModeTransition()?.run_id??null,open?'open':null);
  const {readSessionModeStatus}=await import('../../../../cli/lib/session-mode-status.js');
  const status=await readSessionModeStatus({db:store,readMode:()=>({mode:'single'}),probeSupervisor:()=>false,readPm2:()=> 'daemon_not_running',readEvents:()=>[]});
  assert.equal(status.transition?.runId??null,open?'open':null);
  // Cancelled history does not block legacy, unkeyed NULL-control admission.
  const single=createStore(db,{readConfig:()=>({state:'ok',config:{}})});
  const control=()=>single.insertControl('machine',{appendAckSuffix:false});
  if(open) assert.throws(control,{code:'CONTROL_TARGET_REQUIRED'}); else assert.ok(control());
});
