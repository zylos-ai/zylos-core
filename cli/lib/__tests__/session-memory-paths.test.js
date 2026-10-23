import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installParserFixture } from '../../../test/helpers/p02-parser-fixture.js';
installParserFixture(['origin','lark:x','lark:y']);
const p=await import('../session-memory-paths.js');
const run='12345678-1234-1234-1234-123456789abc';
test('W4-W6 paths isolate run and scope without creating directories',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'p02-memory-')); const env={ZYLOS_DIR:root};
 try {
  assert.equal(p.handoffPath(null,env),`${root}/memory/handoff.md`);
  assert.equal(p.handoffPath('lark:x',env),`${root}/memory/session-groups/lark:x/handoff.md`);
  assert.equal(p.rulesPath('lark:x',env),`${root}/memory/session-groups/lark:x/rules.md`);
  const prefix=`${root}/memory/mode-switch/${run}`;
  assert.equal(p.modeSwitchDir(run,env),prefix);
  assert.equal(p.modeSwitchPreviousDir(run,'_global',env),`${prefix}/previous/_global`);
  assert.equal(p.modeSwitchDonePath(run,'lark:x',env),`${prefix}/previous/lark:x/.done`);
  assert.equal(p.modeSwitchUngroupedPath(run,env),`${prefix}/ungrouped.md`);
  assert.equal(p.modeSwitchGroupPath(run,'lark:x',env),`${prefix}/lark:x.md`);
  assert.notEqual(p.modeSwitchGroupPath(run,'lark:x',env),p.modeSwitchGroupPath(run,'lark:y',env));
  assert.notEqual(p.modeSwitchDir(run,env),p.modeSwitchDir('abcdefab-1234-1234-1234-123456789abc',env));
  for(const bad of ['',null,'../x','run']) assert.throws(()=>p.modeSwitchDir(bad,env),{code:'MODE_SWITCH_RUN_INVALID'});
  for(const bad of ['',null,'../x','_global']) assert.throws(()=>p.rulesPath(bad,env),{code:'SESSION_GROUP_INVALID'});
  assert.throws(()=>p.modeSwitchPreviousDir(run,'../x',env),{code:'SESSION_GROUP_INVALID'});
  assert.deepEqual(fs.readdirSync(root),[]);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
