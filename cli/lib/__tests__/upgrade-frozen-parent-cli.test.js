import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {frozenFinalizer,frozenComponent} from './frozen-upgrade-entry.js';

const tailModule=new URL('../self-upgrade.js',import.meta.url).href;
const restartModule=new URL('../request-runtime-restart.js',import.meta.url).href;

for(const version of ['0.9.0','0.9.1']) for(const failure of [null,'migration','publication','thresholds','ensure','verify']) {
  test(`frozen ${version} schema1 backup-only parent drives ordinary target ${failure || 'success'}`,async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'frozen-ordinary-finalizer-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const stateFile=path.join(root,'state.json'),target=path.join(root,'target.mjs'),callsFile=path.join(root,'calls.json');
    fs.writeFileSync(stateFile,JSON.stringify({schemaVersion:1,from:version,to:'target',tempDir:root,backupOnly:true}));
    fs.writeFileSync(target,`
      import fs from 'node:fs';
      import {runSelfUpgradeFinalize} from ${JSON.stringify(tailModule)};
      const state=JSON.parse(fs.readFileSync(process.argv[2])),calls=[],failure=${JSON.stringify(failure)};
      const action=name=>{calls.push(name);if(name===failure)throw Object.assign(Error('injected '+name),{code:'FIXTURE_FAILURE'});};
      const forbidden=()=>{throw Error('ordinary finalizer used protected transaction');};
      const result=await runSelfUpgradeFinalize(state,{
        zylosDir:${JSON.stringify(root)},budget:{check(){},remaining:()=>120000,deadlineAt:Date.now()+120000},
        maintenance:new Proxy({},{get:()=>forbidden}),
        syncSkills:()=>({step:5,status:'done'}),installDependencies:()=>({step:6,status:'done'}),
        prepareRuntimeClis:()=>{},migrateDatabases:()=>action('migration'),
        prepareRuntime:()=>({warnings:[],replacements:[]}),stage:()=>({items:{hooks:{targets:[]}}}),
        publishOrdinary:()=>{action('publication');return {ok:true};},
        dataReady:forbidden,commitCutoff:forbidden,protectedSuccess:forbidden,
        updateConfig:()=>action('thresholds'),ensureMemoryMigration:()=>action('ensure'),rotateSession:()=>{},
        commitBaselines:()=>({status:'done'}),startServices:()=>{action('start');return {status:'done'};},
        verifyServices:()=>{action('verify');return {status:'done'};},
        dashboardOwner:{copyDashboardDb:forbidden,applyDashboardRegistration:()=>({state:'done'}),
          applyDashboardRoute:()=>({state:'done'}),verifyDashboard:()=>({state:'ready',errors:[]})},
        readModeStatus:()=>({sessionMode:null,transition:null}),readMode:()=>({mode:null,keyPresent:false}),readTransition:()=>null,
        restart:()=>({ok:true,data:{result:'exit_enqueued'}}),audit:()=>[],
      });
      fs.writeFileSync(${JSON.stringify(callsFile)},JSON.stringify(calls));
      process.stdout.write(JSON.stringify(result));
    `);
    const run=await frozenFinalizer(root,version,{finalizer:target});
    const result=run({preInstallProtection:false,backupOnly:true}),calls=JSON.parse(fs.readFileSync(callsFile));
    assert.equal(result.success,!failure,JSON.stringify(result));
    assert.equal(result.preInstallProtection,false);
    if(!failure)assert.equal(result.dashboardCopy?.state,'skipped');
    assert.equal(fs.existsSync(path.join(root,'.backup')),false);
    assert.equal(fs.existsSync(path.join(root,'.zylos/upgrade')),false);
    if(failure){
      assert.match(result.error,new RegExp('injected '+failure));
      assert.doesNotMatch(result.next||'',/resume-finalize/);
      assert.match(result.next||'',/CLI/);
      if(failure!=='verify')assert.equal(calls.includes('start'),false);
    } else assert.deepEqual(calls,['migration','publication','thresholds','ensure','start','verify']);
  });
}

for(const version of ['0.9.0','0.9.1'])for(const json of [false,true])for(const regression of [false,...(json?[true]:[])]) {
  test(`frozen ${version} ${json?'JSON':'text'} parent ${regression?'detects duplicate-restart regression':'consumes target tail with one restart'}`,async t=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'frozen-parent-cli-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const log=path.join(root,'restart-calls');
    const control=path.join(root,'.claude/skills/comm-bridge/scripts/c4-control.js');
    fs.mkdirSync(path.dirname(control),{recursive:true});
    fs.writeFileSync(control,`require('node:fs').appendFileSync(${JSON.stringify(log)},'parent\\n');`);
    const childScript=`
      import fs from 'node:fs';
      import {completeUpgradeFinalization} from ${JSON.stringify(tailModule)};
      import {requestRuntimeRestart} from ${JSON.stringify(restartModule)};
      const root=${JSON.stringify(root)},calls=${JSON.stringify(log)};
      fs.mkdirSync(root+'/memory',{recursive:true});
      const ctx={zylosDir:root,from:'old',to:'target',steps:[],mergeConflicts:[],mergedFiles:[],servicesWereRunning:[]};
      ctx.budget={deadlineAt:Date.now()+120000,check(){},remaining:()=>120000};
      const result=await completeUpgradeFinalization(ctx,{
        updateConfig(){},ensureMemoryMigration(){},rotateSession(){},commitBaselines:()=>({status:'done'}),
        startServices:()=>({status:'done'}),verifyServices:()=>({status:'done'}),
        dashboardOwner:{verifyDashboard:()=>({state:'degraded',errors:[]})},
        readModeStatus:()=>{throw Error('P10 unavailable');},readMode:()=>({mode:null,keyPresent:false}),readTransition:()=>null,
        restart:options=>requestRuntimeRestart({...options,enqueueExit:()=>{fs.appendFileSync(calls,'target\\n');return 'fixture-enqueued';}}),
        audit:()=>[],
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const output=[],calls=[];
    let targetResult;
    const entry=await frozenComponent(root,version,{
      acquireLock:()=>({success:true}),releaseLock:()=>calls.push('unlock'),cleanupTemp:()=>calls.push('cleanup'),
      checkForCoreUpdates:()=>({success:true,hasUpdate:true,current:'old',latest:'target'}),
      downloadCoreToTemp:()=>({success:true,tempDir:root}),readChangelog:()=>'',
      runSelfUpgrade:()=>{
        calls.push('target');
        const child=spawnSync(process.execPath,['--input-type=module','-e',childScript],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:root}});
        assert.equal(child.status,0,child.stderr);
        targetResult=JSON.parse(child.stdout);
        assert.equal(targetResult.success,true,child.stdout);
        assert.equal(targetResult.completion.sessionRestart,'single_exit_enqueued');
        assert.equal(Object.hasOwn(targetResult,'instructionFilesRebuilt'),false);
        return regression?{...targetResult,instructionFilesRebuilt:true}:targetResult;
      },
    });
    const priorArgv=process.argv,priorConsole=globalThis.console;
    try {
      process.argv=['node','zylos','--self','--yes',...(json?['--json']:[])];
      globalThis.console={...priorConsole,log:value=>output.push(value),error:value=>output.push(value)};
      await entry.upgradeComponent(process.argv.slice(2));
    } finally {process.argv=priorArgv;globalThis.console=priorConsole;}
    assert.deepEqual(calls,['target','cleanup','unlock']);
    const restarts=fs.readFileSync(log,'utf8').trim().split('\n');
    assert.deepEqual(restarts,regression?['target','parent']:['target']);
    if(json)assert.equal(JSON.parse(output.at(-1)).success,true);
    else assert.match(output.join('\n'),/upgraded/);
  });
}
