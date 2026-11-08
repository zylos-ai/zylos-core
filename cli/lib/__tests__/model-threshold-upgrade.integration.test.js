import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeUpgradeFinalization } from '../self-upgrade.js';
import { startSupervisor } from '../../../skills/activity-monitor/scripts/supervisor-main.js';
import { handleAction } from '../../../skills/dashboard/src/lib/actions.js';
import { getActionsMeta } from '../../../skills/dashboard/src/lib/actions.js';
import { sceneRotationThreshold } from '../../../skills/activity-monitor/scripts/supervisor-lifecycle.js';
import { readThresholdPolicy, sessionThreshold } from '../../../skills/dashboard/src/lib/session-threshold.js';

// Covers real upgrade-finalization config writes, metadata and monitor resolution.
// Run when model threshold migration or consumers change; unrelated UI styling
// may skip. HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and tmux socket are private.
// Service/restart/DB edges are injected; the private Supervisor socket is closed
// in finally, and the isolated root is removed by the test lifecycle.
test('old configuration upgrade exposes the same model threshold in settings, monitor and fleet', async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mu-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['.zylos','.claude','.codex','memory'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const file=path.join(root,'.zylos/config.json');
  fs.writeFileSync(file,JSON.stringify({runtime:'claude',new_session_threshold:62,codex_new_session_threshold:75}));
  fs.writeFileSync(path.join(root,'.claude/settings.json'),JSON.stringify({model:'opus'}));
  fs.writeFileSync(path.join(root,'.codex/config.toml'),'model = "private-codex"\n');
  console.log('Threshold upgrade isolation:',JSON.stringify({root,configFile:file,HOME:process.env.HOME,ZYLOS_DIR:process.env.ZYLOS_DIR,PM2_HOME:process.env.PM2_HOME,TMPDIR:process.env.TMPDIR,TMUX:process.env.TMUX}));
  assert.ok(root.startsWith(fs.realpathSync(process.env.TMPDIR)+path.sep));
  const ctx={zylosDir:root,from:'old',to:'new',tempDir:null,servicesWereRunning:[],steps:[],mergeConflicts:[],mergedFiles:[],journal:{phase:'compensation_closed'},transactionDir:path.join(root,'transaction')};
  ctx.maintenance={transaction:()=>ctx.journal,classifyCutoff:()=> 'closed',update(_dir,j,changes){Object.assign(j,changes);},stop(){},canRecognizeProcesses:()=>true};
  const result=await completeUpgradeFinalization(ctx,{
    ensureMemoryMigration(){},rotateSession(){},verifyPublicationForServices(){},protectedSuccess(){},
    startServices:()=>({status:'done'}),verifyServices:()=>({status:'done'}),
    dashboardOwner:{verifyDashboard:()=>({state:'degraded',errors:[]})},
    readModeStatus:()=>({sessionMode:'single',transition:null}),readMode:()=>({mode:'single',keyPresent:true}),readTransition:()=>null,
    restart:()=>({ok:true,data:{result:'exit_enqueued'}}),audit:()=>[],
  });
  assert.equal(result.success,true);
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(config.model_rotation_thresholds.claude.opus,62);
  assert.equal(config.model_rotation_thresholds.codex['private-codex'],75);
  const policy=readThresholdPolicy(root);
  for(const [runtime,model,usage] of [
    ['claude','opus',{model:{id:'claude-opus-4-6'},context_window:{context_window_size:200000}}],
    ['codex','private-codex',{model:'private-codex',contextUsage:{used:0,ceiling:258400}}],
  ]){
    const meta=getActionsMeta({...config,zylosDir:root,runtime},null);
    const actual=runtime==='claude'?usage.model.id:usage.model;
    const launchConfig={runtime,mode:'default'};
    const threshold=sceneRotationThreshold({runtime,model:actual,contextWindow:runtime==='claude'?200000:258400,launchConfig},{rotationPolicy:config,defaultModels:policy.defaultModels,codexModels:policy.codexModels});
    assert.equal(meta.model_thresholds[model],threshold);
    assert.equal(sessionThreshold(policy,{runtime,usage,launchConfig}),threshold);
    console.log('Upgraded model agreement:',JSON.stringify({runtime,model,settings:meta.model_thresholds[model],monitor:threshold,fleet:sessionThreshold(policy,{runtime,usage,launchConfig})}));
  }
  const controls=[];
  const scene={sessionGroup:null,present:true,ready:true,runId:'private-run',sessionId:'private-session',runtime:'claude',model:'claude-opus-4-6',contextWindow:200000,usagePercent:60,launchConfig:{runtime:'claude',mode:'default'}};
  const db={getModeTransition:()=>null,listDrainFences:()=>[],getDrainFence:()=>null,
    getOriginNeed:()=>({controls:{count:0},inbound:{oldestAt:null}}),
    insertControl:(content,options)=>{controls.push({content,...options});return{id:controls.length};}};
  const service=await startSupervisor({env:{...process.env,ZYLOS_DIR:root},db,
    readConfig:()=>JSON.parse(fs.readFileSync(file,'utf8')),readMode:()=>({mode:'single',keyPresent:true}),
    scenes:{observe:async()=>[],observeGroup:async()=>scene,readIdentity:async()=>scene,listRuns:async()=>[],readRun:async()=>null,
      bindTarget:()=>({expectedRunId:scene.runId})},
    legacyStatus:{tick(){},close(){}},machineTasks:{tick(){},stop(){}},readSyncMarker:()=>({held:false,stale:false}),
    loopOptions:{schedule:()=>1,cancel(){}},log(){},sendAlert(){throw Error('External send forbidden');},
  });
  try{
    const processId=process.pid;
    const before=await service.supervisor.loop.deps.readConfiguration();
    await service.supervisor.lifecycle.checkRotation(scene,{configuration:before,scenes:[scene],fences:[],restartRequests:[],transition:null});
    assert.equal(controls.length,0,'60% must stay below the migrated 62% threshold');
    assert.equal((await handleAction('set-threshold',{runtime:'claude',model:'opus',value:55},{runtime:'claude',zylosDir:root})).ok,true);
    const after=await service.supervisor.loop.deps.readConfiguration();
    await service.supervisor.lifecycle.checkRotation(scene,{configuration:after,scenes:[scene],fences:[],restartRequests:[],transition:null});
    assert.equal(controls.length,1,'the next decision in the same Supervisor must use 55%');
    assert.equal(process.pid,processId);
    const nextConfig=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(getActionsMeta({...nextConfig,zylosDir:root,runtime:'claude'},null).model_thresholds.opus,55);
    console.log('Immediate threshold update:',JSON.stringify({pid:processId,before:sceneRotationThreshold(scene,before),after:sceneRotationThreshold(scene,after),controls:controls.length,restarts:0}));
  }finally{await service.stop();}
});
