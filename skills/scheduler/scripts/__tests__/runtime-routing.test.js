import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendViaC4, RECEIVE_TIMEOUT_MS } from '../runtime.js';
const fixture = fileURLToPath(new URL('./fixtures/receive-result.mjs', import.meta.url));

for (const [label, options, route] of [
  ['saved group and reply', {sessionComponent:'telegram',sessionGroupName:'g-1',replyChannel:'telegram',replyEndpoint:'-1|msg:9'}, ['--channel','telegram','--endpoint','-1|msg:9','--session-group','g-1']],
  ['saved group without reply', {sessionComponent:'telegram',sessionGroupName:'g-1'}, ['--no-reply','--channel','telegram','--session-group','g-1']],
  ['old null pair with reply', {replyChannel:'lark',replyEndpoint:'chat-1'}, ['--channel','lark','--endpoint','chat-1']],
  ['old null pair without reply', {}, ['--no-reply']],
  ['whole component', {sessionComponent:'lark'}, ['--no-reply','--channel','lark']],
]) test(`four-way receive mapping: ${label}`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-argv-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const record = path.join(dir,'argv.json');
  const result = sendViaC4('literal $HOME `echo x`', {...options,priority:2,requireIdle:true}, {receivePath:fixture,execute(command,args,settings) {
    assert.equal(command,process.execPath); assert.equal(settings.timeout,45000);
    return execFileSync(command,args,{...settings,env:{...process.env,RECEIVE_FIXTURE_MODE:'success',RECEIVE_FIXTURE_RECORD:record}});
  }});
  assert.equal(result.category,'success');
  assert.deepEqual(JSON.parse(fs.readFileSync(record)),['--core-source','scheduler','--json',...route,'--block-queue-until-idle','--priority','2','--content','literal $HOME `echo x`']);
});

for (const [mode, category] of [
  ['INVALID_ARGS:[]','R'], ['SESSION_GROUP_INVALID:[]','R'], ['SESSION_GROUP_TOO_LONG:[]','R'],
  ['DB_BUSY:[]','T'], ['INTERNAL_ERROR:[]','T'], ['INTERNAL_ERROR:null','U'],
  ['UNHEALTHY_NOTIFY_FAILED:["conversations"]','C'], ['UNHEALTHY_NOTIFY_UNCERTAIN:["conversations"]','C'],
  ['invalid','U'], ['abnormal','U'], ['signal','U'],
]) test(`actual receive exit classification ${mode}`, () => {
  const result=sendViaC4('x',{}, {receivePath:fixture,execute(command,args,settings) {
    return execFileSync(command,args,{...settings,env:{...process.env,RECEIVE_FIXTURE_MODE:mode}});
  }});
  assert.equal(result.category,category);
  assert.notEqual(result.status,0);
  if(mode==='signal') assert.equal(result.signal,'SIGTERM');
});

test('timeout preserves termination evidence and returns only after child exit', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-timeout-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const exited=path.join(dir,'exited');
  const result=sendViaC4('x',{}, {receivePath:fixture,execute(command,args,settings) {
    assert.equal(settings.timeout,RECEIVE_TIMEOUT_MS);
    return execFileSync(command,args,{...settings,timeout:500,env:{...process.env,RECEIVE_FIXTURE_MODE:'timeout',RECEIVE_FIXTURE_EXITED:exited}});
  }});
  assert.equal(result.category,'U'); assert.equal(result.spawnCode,'ETIMEDOUT');
  assert.equal(fs.readFileSync(exited,'utf8'),'exited');
});
