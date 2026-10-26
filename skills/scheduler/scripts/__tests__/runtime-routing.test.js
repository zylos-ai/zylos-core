import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendViaC4, RECEIVE_TIMEOUT_MS } from '../runtime.js';
import { realReceive } from './fixtures/real-receive.js';
const fixture = fileURLToPath(new URL('./fixtures/receive-result.mjs', import.meta.url));

for (const [label, options, route] of [
  ['saved group and reply', {sessionComponent:'telegram',sessionGroupName:'g-1',replyChannel:'telegram',replyEndpoint:'-1|msg:9'}, ['--channel','telegram','--endpoint','-1|msg:9','--session-group','g-1']],
  ['saved group without reply', {sessionComponent:'telegram',sessionGroupName:'g-1'}, ['--no-reply','--channel','telegram','--session-group','g-1']],
  ['old null pair with reply', {replyChannel:'lark',replyEndpoint:'chat-1'}, ['--channel','lark','--endpoint','chat-1']],
  ['old null pair without reply', {}, ['--no-reply']],
  ['whole component', {sessionComponent:'lark'}, ['--no-reply','--channel','lark']],
]) test(`four-way receive mapping: ${label}`, t => {
  const real = realReceive(t);
  const result = real.send('literal $HOME `echo x`', {...options,priority:2,requireIdle:true});
  assert.equal(result.category,'success', result.stdout + result.stderr);
  assert.equal(real.calls[0].command,process.execPath);
  assert.equal(real.calls[0].settings.timeout,45000);
  assert.deepEqual(real.calls[0].args,['--core-source','scheduler','--json',...route,'--block-queue-until-idle','--priority','2','--content','literal $HOME `echo x`']);
  const [row] = real.rows(); assert.equal(real.rows().length,1);
  assert.equal(row.content,'literal $HOME `echo x`');
  assert.equal(row.channel,options.sessionComponent || options.replyChannel || 'system');
  assert.equal(row.endpoint_id,options.replyEndpoint || null);
  assert.equal(row.session_group, options.sessionComponent ? options.sessionComponent + (options.sessionGroupName ? ':'+options.sessionGroupName : '') : options.replyChannel || 'origin');
  assert.equal(row.priority,2); assert.equal(row.require_idle,1);
  assert.equal(result.receipt.id,row.id); assert.equal(result.receipt.sessionGroup,row.session_group);

});

for (const [label, options, code] of [
  ['missing component', {sessionComponent:'not-installed'}, 'INVALID_ARGS'],
  ['invalid group', {sessionComponent:'telegram',sessionGroupName:'bad group'}, 'SESSION_GROUP_INVALID'],
  ['too-long group', {sessionComponent:'telegram',sessionGroupName:'g'.repeat(96)}, 'SESSION_GROUP_TOO_LONG'],
]) test(`real receive rejection: ${label}`, t => {
  const real=realReceive(t); const result=real.send('x',options);
  assert.equal(result.category,'R'); assert.equal(result.status,1);
  assert.equal(result.receipt.error.code,code); assert.deepEqual(result.receipt.error.persisted,[]);
  assert.deepEqual(real.rows(),[]);
});

for (const [noticeExit,code] of [[undefined,'UNHEALTHY_NOTIFY_FAILED'],[7,'UNHEALTHY_NOTIFY_UNCERTAIN']])
 test(`real committed receipt: ${code}`, t => {
  const real=realReceive(t,{health:'unavailable',noticeExit});
  const result=real.send('x',{replyChannel:'telegram',replyEndpoint:'target'});
  assert.equal(result.category,'C',result.stdout+result.stderr);
  assert.equal(result.receipt.error.code,code); assert.deepEqual(result.receipt.error.persisted,['D1']);
  assert.equal(real.rows().filter(row=>row.direction==='in').length,1);
});

for (const [mode, category] of [
  ['DB_BUSY:[]','T'], ['INTERNAL_ERROR:[]','T'], ['INTERNAL_ERROR:null','U'],
  ['invalid','U'], ['abnormal','U'], ['signal','U'],
]) test(`synthetic uncertain/retryable receive classification ${mode}`, () => {
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
