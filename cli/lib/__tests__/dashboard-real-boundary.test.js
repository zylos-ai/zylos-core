import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from '../../../skills/comm-bridge/node_modules/better-sqlite3/lib/index.js';
import { isolatedTmux, tmuxClientEnv } from '../../../test/helpers/isolated-tmux.js';
import { CoreState } from '../../../skills/dashboard/src/lib/core-state.js';
import { handleCoreAction } from '../../../skills/dashboard/src/lib/core-actions.js';
import { createConsoleStatusReader } from '../../../skills/web-console/scripts/session-status.js';
import { readSessionMode } from '../config.js';
import { readSessionState } from '../session-state-reader.js';
import { lookupRestartRequest } from '../am-sock-client.js';

const root = process.env.ZYLOS_DIR;
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
const runDir = group => path.join(root,'activity-monitor/session-groups',group);
function sample(group, runId, sessionId, state='busy') {
  write(path.join(runDir(group),'current-session.json'), {runId,sessionId,ts:Date.now(),startupControlIds:[]});
  write(path.join(runDir(group),'agent-status.json'), {runId,sessionId,state,active_tool_details:[{id:'tool',name:'Read',startedAt:Date.now()}]});
}

test('real Core reader, targeted control CLI and Sock retain Origin boundaries', async t => {
  const fixture=isolatedTmux(t,{prefix:'dashboard-boundary-'});
  const prior = {PATH:process.env.PATH,TMUX:process.env.TMUX,TMUX_TMPDIR:process.env.TMUX_TMPDIR};
  const env=tmuxClientEnv(fixture); Object.assign(process.env,{PATH:env.PATH,TMUX:env.TMUX,TMUX_TMPDIR:env.TMUX_TMPDIR});
  t.after(()=>{for(const [key,value] of Object.entries(prior))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  fs.mkdirSync(path.join(root,'.claude/skills'),{recursive:true});
  fs.symlinkSync(path.resolve('skills/comm-bridge'),path.join(root,'.claude/skills/comm-bridge'));
  write(path.join(root,'.zylos/config.json'),{session_mode:'multi'});
  for(const [group,run,session] of [['origin','R1','S1'],['clone-console','RC','SC']]) {
    fixture.tmux('-f','/dev/null','new-session','-d','-s',`zylos-group-${group}`,'-e',`ZYLOS_RUN_ID=${run}`,'-e',`ZYLOS_SESSION_GROUP=${group}`,'-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}','sleep','120');
    sample(group,run,session);
  }
  const changes=[];const core=new CoreState({onChange:state=>changes.push(state)});
  let current=await core.refresh();assert.equal(current.runId,'R1');assert.equal(current.state,'BUSY');assert.equal(current.running_tools[0].tool_name,'Read');
  assert.equal('identity' in current,false);assert.equal('status' in current,false);assert.equal('usage' in current,false);
  const firstCostKey=core.costKey;assert.ok(firstCostKey);await core.refresh();assert.equal(changes.length,1);
  const consoleStatus=createConsoleStatusReader({readSessionMode,readSessionState,getChannelNamespace:()=>({namespace:'clone-console'})});
  assert.equal((await consoleStatus()).runId,'RC');
  write(path.join(root,'activity-monitor/agent-status.json'),{state:'WRONG_GLOBAL'});
  const target={sessionGroup:'origin',runId:'R1',sessionId:'S1'};
  const startedAt=Date.now();
  const pair=await handleCoreAction('chop-chop',target,{zylosDir:root});assert.equal(pair.ok,true,JSON.stringify(pair));
  assert(Date.now()-startedAt>=500);
  const db=new Database(path.join(root,'comm-bridge/c4.db'));t.after(()=>db.close());
  const rows=db.prepare('SELECT raw_content,session_group,target_binding,created_at FROM control_queue ORDER BY id').all();
  assert.deepEqual(rows.map(row=>row.raw_content),['[KEYSTROKE]Escape','continue']);
  for(const row of rows){assert.equal(row.session_group,'origin');const binding=JSON.parse(row.target_binding);assert.equal(binding.expectedRunId,'R1');assert.equal(binding.expectedSessionId,'S1');}
  const replaceTimer=setTimeout(()=>{fixture.tmux('set-environment','-t','zylos-group-origin','ZYLOS_RUN_ID','R2');sample('origin','R2','S2');},100);
  const result=await handleCoreAction('chop-chop',target,{zylosDir:root});clearTimeout(replaceTimer);assert.equal(result.steps[0].ok,true);assert.equal(result.steps[1].ok,false);assert.equal(result.targetChanged,true);
  assert.equal(db.prepare('SELECT count(*) n FROM control_queue').get().n,3);
  const rejected=await handleCoreAction('chop-chop',target,{zylosDir:root});assert.equal(rejected.steps.length,1);assert.equal(rejected.targetChanged,true);
  assert.equal(db.prepare('SELECT count(*) n FROM control_queue').get().n,3);
  assert.equal((await handleCoreAction('interrupt',{}, {zylosDir:root})).error,'TARGET_REQUIRED');
  assert.equal((await handleCoreAction('interrupt',{...target,sessionGroup:'other'}, {zylosDir:root})).error,'TARGET_SCOPE_MISMATCH');
  current=await core.refresh();assert.equal(current.runId,'R2');assert.equal(current.sessionId,'S2');assert.notEqual(core.costKey,firstCostKey);
  fixture.tmux('set-environment','-u','-t','zylos-group-clone-console','ZYLOS_RUN_ID');
  await core.refresh();assert.equal(core.costKey,null);
  fixture.tmux('set-environment','-t','zylos-group-clone-console','ZYLOS_RUN_ID','RC');
  await core.refresh();assert.ok(core.costKey);
  const file=path.join(runDir('origin'),'agent-status.json');fs.utimesSync(file,new Date(0),new Date(0));
  assert.equal((await core.refresh()).reason,'stale');
  write(file,'{broken');assert.equal((await core.refresh()).reason,'unparseable');
  const secondCostKey=core.costKey;sample('origin','R2','S3');assert.equal((await core.refresh()).sessionId,'S3');assert.notEqual(core.costKey,secondCostKey);
  assert.equal((await consoleStatus()).runId,'RC');
  db.prepare('INSERT INTO channel_namespaces(namespace,component_name) VALUES(?,?)').run('clone-console','web-console');
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const consoleChild=spawn(process.execPath,['skills/web-console/scripts/server.js'],{env:{...process.env,WEB_CONSOLE_PORT:String(port),WEB_CONSOLE_BIND:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  let output='';consoleChild.stdout.on('data',b=>output+=b);consoleChild.stderr.on('data',b=>output+=b);
  t.after(async()=>{consoleChild.kill('SIGTERM');if(consoleChild.exitCode===null)await once(consoleChild,'exit');});
  const base=`http://127.0.0.1:${port}`;let online=false;
  for(let n=0;n<100;n++){if(consoleChild.exitCode!==null)throw Error(output);try{online=(await fetch(base+'/api/health')).ok;}catch{}if(online)break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert(online,output);
  assert.equal((await (await fetch(base+'/api/status')).json()).runId,'RC');
  const consoleFile=path.join(runDir('clone-console'),'agent-status.json');fs.utimesSync(consoleFile,new Date(0),new Date(0));
  assert.equal((await (await fetch(base+'/api/status')).json()).reason,'stale');
  write(consoleFile,'{broken');assert.equal((await (await fetch(base+'/api/status')).json()).reason,'unparseable');
  fixture.tmux('kill-session','-t','zylos-group-clone-console');assert.equal((await (await fetch(base+'/api/status')).json()).state,'not_running');
  write(path.join(root,'.zylos/config.json'),{session_mode:'single'});assert.equal((await consoleStatus()).runId,'R2');
  assert.equal((await (await fetch(base+'/api/status')).json()).runId,'R2');

  const socketPath=path.join(root,'activity-monitor/am.sock');let requests=0;
  const server=net.createServer(socket=>socket.once('data',data=>{requests++;const request=JSON.parse(data.toString());assert.equal(request.expectedRunId,'R2');socket.end(JSON.stringify({...request,ok:true,result:'accepted'})+'\n');}));
  await new Promise(resolve=>server.listen(socketPath,resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const restarted=await handleCoreAction('restart-session',{runId:'R2',sessionId:'S3'},{zylosDir:root});assert.equal(restarted.submission,'accepted');assert.equal(requests,1);
  assert.equal(await lookupRestartRequest(restarted.requestId,{deadlineAt:Date.now()+1000}),'unknown');assert.equal(requests,1);
});
