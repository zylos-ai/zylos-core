import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendViaC4, RECEIVE_TIMEOUT_MS } from '../runtime.js';
import { realReceive } from './fixtures/real-receive.js';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
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
  assert.equal(row.core_source, 'scheduler'); assert.equal(row.task_name, null);
  assert.equal(result.receipt.id,row.id); assert.equal(result.receipt.sessionGroup,row.session_group);

});

// Real scheduler transport -> receive CLI -> SQLite provenance boundary. Run for
// scheduler metadata/receive/schema changes; skip unrelated UI. The helper binds
// a private tmux socket, temporary HOME/ZYLOS_DIR and SQLite, and reaps its child.
test('scheduler metadata crosses real receive and survives database reopen', t => {
  const real = realReceive(t);
  const filename = real.db.pragma('database_list').find(row => row.name === 'main').file;
  assert.equal(filename, path.join(real.root, 'comm-bridge', 'c4.db'));
  assert.notEqual(real.root, process.env.HOME);
  assert.ok(process.env.PM2_HOME.startsWith(process.env.HOME + path.sep));
  assert.ok(process.env.TMPDIR.length < 80);
  const taskName = 'Daily report $(literal) "name"';
  const result = real.send('body has no scheduler marker', { replyChannel: 'telegram', replyEndpoint: 'target', taskName });
  assert.equal(result.category, 'success', result.stdout + result.stderr);
  const argv = real.calls[0].args;
  assert.equal(argv[argv.indexOf('--core-source') + 1], 'scheduler');
  assert.equal(argv[argv.indexOf('--task-name') + 1], taskName);
  // The real receive process already closed its writer; read persisted values
  // using a new connection rather than the helper's existing read connection.
  const reopened = new Database(filename, { readonly: true });
  t.after(() => reopened.close());
  const row = reopened.prepare('SELECT core_source,task_name,content FROM conversations WHERE id=?').get(result.receipt.id);
  assert.equal(row.core_source, 'scheduler'); assert.equal(row.task_name, taskName);
  assert.equal(row.content, 'body has no scheduler marker');
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

for (const noticeExit of [undefined, 7])
 test(`real terminal receive persists owner notification without channel send exit ${noticeExit ?? 'missing'}`, t => {
  const real=realReceive(t,{health:'unavailable',noticeExit});
  const result=real.send('x',{replyChannel:'telegram',replyEndpoint:'target'});
  assert.equal(result.category,'success',result.stdout+result.stderr);
  assert.equal(result.receipt.action, 'failed');
  assert.equal(real.rows().filter(row=>row.direction==='in').length,1);
  assert.equal(real.rows().filter(row=>row.direction==='out').length,0);
  const notification = real.db.prepare('SELECT reason,state FROM failure_receipts WHERE conversation_id=?').get(result.receipt.id);
  assert.equal(notification.reason, 'runtime_unavailable'); assert.equal(notification.state, 'pending');
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
