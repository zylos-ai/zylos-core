import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './c4-v2-test-helpers.js';
import {isolatedTmux,tmuxClientEnv} from '../../../../test/helpers/isolated-tmux.js';
import {getSessionAdapter} from '../../../../cli/lib/runtime/index.js';
import {createSessionReader} from '../../../../cli/lib/session-state-reader-async.js';
import {readReadyIdentity} from '../../../../cli/lib/runtime/session-target.js';
import {listGroupTmuxSessions} from '../../../../cli/lib/session-group-paths.js';
import {createRouter} from '../router/scheduler.js';
import {desiredClaudeHooks} from '../../../../cli/lib/sync-runtime-hooks.js';
import {ensureCodexHooksTrusted} from '../../../../cli/lib/codex-hooks.js';
const evidence='/Users/howard/zylos/workspace/zylo83-ready-evidence-21243';
const bins={claude:'/Users/howard/.local/bin/claude',codex:'/Users/howard/.nvm/versions/node/v24.14.0/bin/codex'};
export async function measure(t,runtime){
 let router;
 const tm=isolatedTmux(t,{prefix:'ready-21243-',beforeCleanup:()=>router?.stop()});
 const root=path.join(tm.dir,'zylos');fs.mkdirSync(root);
 const previous={...process.env};
 const env=tmuxClientEnv(tm,{PATH:process.env.PATH,HOME:tm.dir,ZYLOS_DIR:root,ZYLOS_PACKAGE_ROOT:process.cwd(),LANG:'en_US.UTF-8',TERM:'xterm-256color'});
 for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,env);
 t.after(()=>{for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,previous);});
 for(const dir of ['.zylos','.claude','comm-bridge','memory'])fs.mkdirSync(path.join(root,dir));
 fs.writeFileSync(path.join(root,'.zylos/config.json'),JSON.stringify({runtime,session_mode:'multi'}));
 fs.writeFileSync(path.join(root,'.zylos/runtime-env.manifest'),'inherit TMUX\ninherit ZYLOS_PACKAGE_ROOT\n');
 fs.symlinkSync(path.join(process.cwd(),'skills'),path.join(root,'.claude/skills'));
 fs.mkdirSync(path.join(tm.dir,'.claude'));
 fs.writeFileSync(path.join(root,'memory/identity.md'),'Isolated startup timing test. Do not call tools or send external messages. Wait quietly.');
 const record={runtime,utc:new Date().toISOString(),condition:'fresh isolated HOME, no copied host credentials',root,launch_ms:null,ready_from_launch_ms:null,ready_from_return_ms:null};
 const version=spawnSync(bins[runtime],['--version'],{env,encoding:'utf8',timeout:10000});record.version=version.stdout?.trim();
 const auth=spawnSync(bins[runtime],runtime==='claude'?['auth','status']:['login','status'],{env,cwd:root,encoding:'utf8',timeout:10000});record.auth={status:auth.status,stdout:auth.stdout,stderr:auth.stderr};
 if(runtime==='claude')fs.writeFileSync(path.join(tm.dir,'.claude/settings.json'),JSON.stringify({hooks:desiredClaudeHooks({zylosDir:root})}));
 else try{record.hookTrust=ensureCodexHooksTrusted({zylosDir:root,projectDir:root,homeDir:tm.dir,codexBin:bins.codex});}catch(e){record.hookTrustError=e.message;}
 const f=fixture(t,{readConfig:()=>({state:'ok',config:{runtime,session_mode:'multi'}})},path.join(root,'comm-bridge/c4.db'));
 const db={...f.store,getControlById:id=>f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),expireTimedOutControls:()=>0,cleanupControlQueue:()=>0};
 db.setDrainFence('origin',{reason:'upgrade',runId:'measure-fence'});const row=db.insertConversation('in','measure','endpoint','Isolated timing marker');
 const tmux={binary:tm.binary,socketPath:tm.socketPath,configFile:'/dev/null'};
 const reader=createSessionReader({env,connectionOptions:tmux});const events=[];let start,returned;
 const deps={db,readSessionMode:()=>({mode:'multi',keyPresent:true}),...reader,readCurrentSession:readReadyIdentity,listGroupTmuxSessions:()=>listGroupTmuxSessions(tmux),readRuntimeHealth:()=>({health:'ok',publicHealth:'ok'}),
 getSessionAdapter:r=>{const adapter=getSessionAdapter(r,{root,tmux,env,runtimeExecutable:()=>bins[r]});const launch=adapter.launch.bind(adapter);adapter.launch=async input=>{record.runId=input.runId;start=performance.now();try{return await launch(input);}catch(e){record.launchError={code:e.code,message:e.message};throw e;}finally{returned=performance.now();record.launch_ms=returned-start;}};return adapter;},
 submit:async()=>{throw Error('unexpected restricted health');},deliverControl:async()=>{},deliverConversation:async()=>{},handleExpired:async()=>{},prepareSingle:async()=>{},findLegacySessions:async()=>[],advanceLegacy:async()=>{},diagnostic:(event,fields)=>events.push({event,...fields}),alert:()=>{}};
 router=createRouter(deps,{poolSize:1,readyTimeoutMs:60000});await router.initialize();
 const limit=performance.now()+20000;
 while(performance.now()<limit){router.tick();await router.idle();const live=await reader.readLiveIdentity('measure');if(live.ready&&live.runId===record.runId){record.ready_from_launch_ms=performance.now()-start;record.ready_from_return_ms=performance.now()-returned;record.identity=live;break;}if(record.launchError)break;await new Promise(r=>setTimeout(r,200));}
 try{record.pane=tm.tmux('capture-pane','-p','-t','zylos-group-measure');}catch(e){record.paneError=e.message;}
 record.events=events;record.ledger=f.db.prepare('SELECT id,status,retry_count FROM conversations WHERE id=?').get(row.id);
 record.result=record.ready_from_launch_ms===null?'NO_READY':'READY_OBSERVED';
 fs.writeFileSync(path.join(evidence,`${runtime}-probe.json`),JSON.stringify(record,null,2));t.diagnostic(JSON.stringify({runtime,result:record.result,launch_ms:record.launch_ms,ready_from_launch_ms:record.ready_from_launch_ms}));
}
