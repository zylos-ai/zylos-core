import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as schema from '../c4-schema.js';
import { guardDatabase } from '../sqlite-schema.js';
const cli = fileURLToPath(new URL('../c4-control.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-control-json-'));
  fs.mkdirSync(path.join(root,'comm-bridge'));
  const db = new Database(path.join(root,'comm-bridge/c4.db'));
  guardDatabase(db,schema);
  t.after(()=>{db.close(); fs.rmSync(root,{recursive:true,force:true});});
  const env = {PATH:process.env.PATH,HOME:root,ZYLOS_DIR:root,TMUX_TMPDIR:root};
  function run(args,status=0) {
    const r=spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:20000});
    assert.equal(r.status,status,r.stderr);
    assert.equal(r.stderr,'');
    assert.equal(r.stdout.trim().split('\n').length,1);
    return JSON.parse(r.stdout);
  }
  return {root,db,run};
}
test('ordinary enqueue JSON reports committed id and exact superseded count',t=>{
  const {db,run}=fixture(t);
  const args=['enqueue','--content','same content','--no-ack-suffix','--json'];
  const first=run(args),second=run(args);
  assert.deepEqual(first,{ok:true,data:{id:1,supersededCount:0}});
  assert.deepEqual(second,{ok:true,data:{id:2,supersededCount:1}});
  assert.deepEqual(db.prepare('SELECT id,status,target_binding FROM control_queue ORDER BY id').all(),[
    {id:1,status:'superseded',target_binding:null},{id:2,status:'pending',target_binding:null}]);
});
test('JSON argument and scope refusals preserve all existing rows',t=>{
  const {db,run}=fixture(t);
  run(['enqueue','--content','same content','--no-ack-suffix','--json']);
  const before=db.prepare('SELECT * FROM control_queue').all();
  for (const [extra,code] of [
    [['--priority','-1'],'INVALID_ARGS'],
    [['--json'],'INVALID_ARGS'],
    [['--unexpected'],'INVALID_ARGS'],
    [['--group','*'],'SESSION_GROUP_INVALID'],
    [['--group','origin'],'ACK_DEADLINE_REQUIRED'],
    [['--expected-runtime','codex'],'INVALID_ARGS'],
  ]) {
    const result=run(['enqueue','--content','same content','--json',...extra],1);
    assert.equal(result.ok,false); assert.equal(result.error.code,code);
    assert.deepEqual(result.error.persisted,[]);
    assert.deepEqual(db.prepare('SELECT * FROM control_queue').all(),before);
  }
});
test('strict F1 import failure is a single JSON error without a write',t=>{
  const {root,db,run}=fixture(t);
  fs.mkdirSync(path.join(root,'.zylos'));
  fs.writeFileSync(path.join(root,'.zylos/config.json'),'{invalid');
  const result=run(['enqueue','--content','x','--json'],1);
  assert.equal(result.ok,false);assert.equal(result.error.code,'CONFIG_UNREADABLE');
  assert.deepEqual(result.error.persisted,[]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM control_queue').get().n,0);
});
