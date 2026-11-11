import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import Database from '../../skills/comm-bridge/node_modules/better-sqlite3/lib/index.js';
import { isolatedTmux, tmuxClientEnv } from '../helpers/isolated-tmux.js';
import { CoreState } from '../../skills/dashboard/src/lib/core-state.js';
import { createCoreStateChangePublisher } from '../../skills/dashboard/src/lib/core-state-publisher.js';
import { SseHub } from '../../skills/dashboard/src/lib/sse.js';
import { handleCoreAction } from '../../skills/dashboard/src/lib/core-actions.js';
import { readSessionMode } from '../../cli/lib/config.js';
import { lookupRestartRequest } from '../../cli/lib/am-sock-client.js';

const root = process.env.ZYLOS_DIR;
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive:true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
const runDir = group => path.join(root,'activity-monitor/session-groups',group);
function sample(group, runId, sessionId, state='busy', extra={}) {
  write(path.join(runDir(group),'current-session.json'), {runId,sessionId,ts:Date.now(),startupControlIds:[]});
  write(path.join(runDir(group),'agent-status.json'), {runId,sessionId,state,active_tool_details:[{id:'tool',name:'Read',startedAt:1}],...extra});
}

test('real Core reader, targeted control CLI and Sock retain Origin boundaries', { timeout: 20000 }, async t => {
  const fixture=isolatedTmux(t,{prefix:'tm-', parentDir:process.env.TMPDIR});
  assert.equal(path.dirname(fixture.dir), fs.realpathSync(process.env.TMPDIR));
  assert.ok(Buffer.byteLength(fixture.socketPath)<100);
  console.log('dashboard boundary targets', JSON.stringify({HOME:process.env.HOME, ZYLOS_DIR:root,
    PM2_HOME:process.env.PM2_HOME, TMPDIR:process.env.TMPDIR, socket:fixture.socketPath,
    database:path.join(root,'comm-bridge/c4.db'), pm2:'not started'}));
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
  const changes=[]; const sseChunks=[]; const sse=new SseHub();
  const response=new EventEmitter(); response.writeHead=()=>{}; response.write=chunk=>{sseChunks.push(chunk);return true;}; response.end=()=>{};
  sse.addClient(response); t.after(()=>{response.emit('close');sse.closeAll();});
  let core; let fleetBroadcasts=0;
  const publish=createCoreStateChangePublisher({sse,buildStatePayload:()=>core.getState(),scheduleFleetStateBroadcast:()=>{fleetBroadcasts++;}});
  core=new CoreState({onChange:state=>{changes.push(state);publish();}});
  let current=await core.refresh();assert.equal(current.runId,'R1');assert.equal(current.state,'BUSY');assert.equal(current.running_tools[0].tool_name,'Read');
  assert(sseChunks.some(chunk=>chunk.includes('event: state_change')&&chunk.includes('"runId":"R1"')));assert.equal(fleetBroadcasts,1);
  assert.equal('identity' in current,false);assert.equal('status' in current,false);assert.equal('usage' in current,false);
  const firstCostKey=core.costKey;assert.ok(firstCostKey);const firstUpdatedAt=current.updated_at;
  await new Promise(resolve=>setTimeout(resolve,5));current=await core.refresh();assert.equal(changes.length,1);assert.notEqual(current.updated_at,firstUpdatedAt);
  sample('origin','R1','S1','busy',{last_check:Date.now(),inactive_seconds:1});await core.refresh();assert.equal(changes.length,1);
  sample('origin','R1','S1','idle',{last_check:Date.now(),inactive_seconds:0});await core.refresh();assert.equal(changes.length,2);assert.equal(changes.at(-1).state,'IDLE');
  sample('origin','R1','S1','busy',{last_check:Date.now(),inactive_seconds:0});await core.refresh();assert.equal(changes.length,3);
  write(path.join(root,'activity-monitor/agent-status.json'),{state:'WRONG_GLOBAL'});
  const target={sessionGroup:'origin',runId:'R1',sessionId:'S1'};
  const startedAt=Date.now();
  const pair=await handleCoreAction('chop-chop',target,{zylosDir:root});assert.equal(pair.ok,true,JSON.stringify(pair));
  assert(Date.now()-startedAt>=500);
  const db=new Database(path.join(root,'comm-bridge/c4.db'));t.after(()=>db.close());
  const rows=db.prepare('SELECT raw_content,session_group,target_binding,created_at FROM control_queue ORDER BY id').all();
  assert.deepEqual(rows.map(row=>row.raw_content),['[KEYSTROKE]Escape','continue']);
  for(const row of rows){assert.equal(row.session_group,'origin');const binding=JSON.parse(row.target_binding);assert.equal(binding.expectedRunId,'R1');assert.equal(binding.expectedSessionId,'S1');}
  const replaceTimer=setInterval(()=>{
    if(db.prepare('SELECT count(*) n FROM control_queue').get().n<3)return;
    clearInterval(replaceTimer);
    fixture.tmux('set-environment','-t','zylos-group-origin','ZYLOS_RUN_ID','R2');sample('origin','R2','S2');
  },5);
  t.after(()=>clearInterval(replaceTimer));
  const result=await handleCoreAction('chop-chop',target,{zylosDir:root});clearInterval(replaceTimer);assert.equal(result.steps[0].ok,true);assert.equal(result.steps[1].ok,false);assert.equal(result.targetChanged,true);
  assert.equal(db.prepare('SELECT count(*) n FROM control_queue').get().n,3);
  const rejected=await handleCoreAction('chop-chop',target,{zylosDir:root});assert.equal(rejected.steps.length,1);assert.equal(rejected.targetChanged,true);
  assert.equal(db.prepare('SELECT count(*) n FROM control_queue').get().n,3);
  assert.equal((await handleCoreAction('interrupt',{}, {zylosDir:root})).error,'TARGET_REQUIRED');
  assert.equal((await handleCoreAction('interrupt',{...target,sessionGroup:'other'}, {zylosDir:root})).error,'TARGET_SCOPE_MISMATCH');
  const beforeRunChange=changes.length;current=await core.refresh();assert.equal(current.runId,'R2');assert.equal(current.sessionId,'S2');assert.notEqual(core.costKey,firstCostKey);assert.equal(changes.length,beforeRunChange+1);
  fixture.tmux('set-environment','-u','-t','zylos-group-clone-console','ZYLOS_RUN_ID');
  await core.refresh();assert.equal(core.costKey,null);
  fixture.tmux('set-environment','-t','zylos-group-clone-console','ZYLOS_RUN_ID','RC');
  await core.refresh();assert.ok(core.costKey);
  const file=path.join(runDir('origin'),'agent-status.json');fs.utimesSync(file,new Date(0),new Date(0));
  assert.equal((await core.refresh()).reason,'stale');
  write(file,'{broken');const unreadable=await core.refresh();assert.equal(unreadable.reason,'unparseable');assert.equal(unreadable.sessionGroup,'origin');
  const secondCostKey=core.costKey;sample('origin','R2','S3');assert.equal((await core.refresh()).sessionId,'S3');assert.notEqual(core.costKey,secondCostKey);
  write(path.join(root,'.zylos/config.json'),'{broken');
  const retainedScope=await core.refresh();assert.equal(retainedScope.state,'UNKNOWN');assert.equal(retainedScope.sessionGroup,'origin');
  const coldFailure=await new CoreState().refresh();assert.equal(coldFailure.state,'UNKNOWN');assert.equal(coldFailure.sessionGroup,undefined);
  write(path.join(root,'.zylos/config.json'),{session_mode:'multi'});
  fixture.tmux('kill-session','-t','zylos-group-clone-console');
  write(path.join(root,'.zylos/config.json'),{});assert.deepEqual(readSessionMode(),{mode:null,keyPresent:false});
  const legacyState=await core.refresh();assert.equal(legacyState.runId,'R2');assert.equal(legacyState.sessionGroup,null);
  assert.equal((await core.currentTarget()).sessionGroup,null);

  const socketPath=path.join(root,'activity-monitor/am.sock');let requests=0;let reply=false;
  fs.rmSync(socketPath,{force:true});
  const missing=await handleCoreAction('restart-session',{runId:'R2',sessionId:'S3'},{zylosDir:root});assert.equal(missing.submission,'not_submitted');assert.equal(missing.completion,'unknown');
  const server=net.createServer(socket=>socket.once('data',data=>{requests++;const request=JSON.parse(data.toString());assert.equal(request.expectedRunId,'R2');if(reply)socket.end(JSON.stringify({...request,ok:true,result:'accepted'})+'\n');}));
  await new Promise(resolve=>server.listen(socketPath,resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const uncertain=await handleCoreAction('restart-session',{runId:'R2',sessionId:'S3'},{zylosDir:root});assert.equal(uncertain.submission,'unknown');assert.equal(uncertain.completion,'unknown');assert.equal(uncertain.error,'deadline_exceeded');
  reply=true;
  const restarted=await handleCoreAction('restart-session',{runId:'R2',sessionId:'S3'},{zylosDir:root});assert.equal(restarted.submission,'accepted');assert.equal(requests,2);
  assert.equal(await lookupRestartRequest(restarted.requestId,{deadlineAt:Date.now()+1000}),'unknown');assert.equal(requests,2);
});
