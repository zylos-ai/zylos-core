import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture } from './c4-v2-test-helpers.js';
const databaseModule = import.meta.resolve('better-sqlite3');
const storeModule = new URL('../c4-v2-store.js', import.meta.url).href;

function worker(filename, code) {
  return spawn(process.execPath, ['--input-type=module', '-e', `
    import Database from ${JSON.stringify(databaseModule)};
    import { createStore } from ${JSON.stringify(storeModule)};
    import { writeSync } from 'node:fs';
    const db = new Database(${JSON.stringify(filename)}, {timeout:5000});
    const s = createStore(db, {validateComponent:()=>true});
    ${code}
  `], { stdio: ['pipe','pipe','pipe'] });
}
function marker(child, expected) {
  return new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.stderr.on('data', b => { errors += b; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`worker timed out: ${output} ${errors}`)); }, 10000);
    child.stdout.on('data', b => { output += b; if (output.includes(expected)) { clearTimeout(timer); resolve(output); } });
    child.on('exit', code => { clearTimeout(timer); if (!output.includes(expected)) reject(new Error(`worker exited ${code}: ${output} ${errors}`)); });
  });
}
test('IF-09 DM-13: concurrent first namespace allocation never replaces a binding', async t => {
  const { db, filename } = fixture(t, {}, true);
  const children = ['Foo','Foo','foo'].map(name => worker(filename, `writeSync(1,'READY\\n'); process.stdin.once('data',()=>{writeSync(1, JSON.stringify(s.ensureChannelNamespace(${JSON.stringify(name)}))+'\\n'); db.close();});`));
  t.after(() => children.forEach(child => child.kill('SIGKILL')));
  await Promise.all(children.map(child => marker(child, 'READY')));
  const exited = children.map(child => once(child, 'exit'));
  children.forEach(child => child.stdin.end('go'));
  assert.deepEqual(await Promise.all(exited), [[0,null],[0,null],[0,null]]);
  const rows = db.prepare('SELECT * FROM channel_namespaces ORDER BY component_name').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.component_name), ['Foo','foo']);
  assert.deepEqual(rows.map(r => r.namespace).sort(), ['foo','foo-2']);
});
for (const phase of ['before', 'after']) test(`DM-11 crash ${phase} COMMIT preserves whole message transaction`, async t => {
  const { db, filename } = fixture(t, {}, true);
  const child = worker(filename, `
    const exec = db.exec.bind(db);
    db.exec = sql => {
      if (sql === 'COMMIT') {
        ${phase === 'after' ? 'exec(sql);' : ''}
        writeSync(1,'BARRIER\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      }
      return exec(sql);
    };
    s.insertConversation('in','foo','endpoint','payload');
  `);
  t.after(() => child.kill('SIGKILL'));
  await marker(child, 'BARRIER');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const expected = phase === 'before' ? 0 : 1;
  for (const table of ['conversations','channel_namespaces','group_heads']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, expected);
  if (expected) assert.equal(db.prepare('SELECT head_id FROM group_heads').get().head_id, db.prepare('SELECT id FROM conversations').get().id);
});
test('DM-14: group case is preserved independently in messages, heads, checkpoints and cursors', t => {
  const { db, store: s } = fixture(t);
  const groups = ['AbC','abc',undefined,'x'];
  for (const local of groups) {
    const row = s.insertConversation('in','ns',null,'content',{groupName:local});
    s.claimConversation(row.id); s.markDelivered(row.id,{sessionId:'sid'});
    const cp = s.createCheckpoint(row.session_group,row.id,'summary');
    s.advanceOriginSyncCursor(row.session_group,{syncedId:row.id,checkpointId:cp.id});
    assert.equal(s.getCoverageEnd(row.session_group),row.id);
  }
  for (const table of ['group_heads','origin_sync_cursors']) assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,4);
  assert.deepEqual(db.prepare('SELECT session_group FROM group_heads ORDER BY session_group').all().map(r=>r.session_group), ['ns','ns:AbC','ns:abc','ns:x']);
});
test('DM-15: maintained heads equal independent message aggregation across 20 groups', t => {
  const { db, store: s } = fixture(t);
  for (let i=0;i<1000;i++) s.insertConversation('in','ns',null,`${i}`,{groupName:`g${i%20}`});
  const expected = db.prepare("SELECT session_group,MAX(id) head_id FROM conversations WHERE session_group<>'' GROUP BY session_group ORDER BY session_group").all();
  assert.deepEqual(db.prepare('SELECT * FROM group_heads ORDER BY session_group').all(), expected);
  db.prepare("UPDATE group_heads SET head_id=1 WHERE session_group='ns:g0'").run();
  assert.notDeepEqual(db.prepare('SELECT * FROM group_heads ORDER BY session_group').all(), expected);
});
