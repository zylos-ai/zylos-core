import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const p=await import('../session-memory-paths.js');
test('handoff and rules paths resolve scope without creating directories',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-runtime-memory-')); const env={ZYLOS_DIR:root};
 try {
  assert.equal(p.handoffPath(null,env),`${root}/memory/handoff.md`);
  assert.equal(p.handoffPath('lark:x',env),`${root}/memory/session-groups/lark:x/handoff.md`);
  assert.equal(p.rulesPath('lark:x',env),`${root}/memory/session-groups/lark:x/rules.md`);
  for(const bad of ['',null,'../x','_global']) assert.throws(()=>p.rulesPath(bad,env),{code:'SESSION_GROUP_INVALID'});
  assert.deepEqual(fs.readdirSync(root),[]);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
