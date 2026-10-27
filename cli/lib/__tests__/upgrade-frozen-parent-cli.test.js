import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';

const tailModule=new URL('../self-upgrade.js',import.meta.url).href;
const restartModule=new URL('../request-runtime-restart.js',import.meta.url).href;

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
      const result=await completeUpgradeFinalization(ctx,{
        budget:{deadlineAt:Date.now()+120000,check(){},remaining:()=>120000},
        updateConfig(){},ensureMemoryMigration(){},rotateSession(){},commitBaselines:()=>({status:'done'}),
        startServices:()=>({status:'done'}),verifyServices:()=>({status:'done'}),
        dashboardOwner:{verifyDashboard:()=>({state:'degraded',errors:[]})},
        readModeStatus:()=>{throw Error('P10 unavailable');},readMode:()=>({mode:null,keyPresent:false}),readTransition:()=>null,
        restart:options=>requestRuntimeRestart({...options,enqueueExit:()=>{fs.appendFileSync(calls,'target\\n');return 'fixture-enqueued';}}),
        audit:()=>[],
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const full=fs.readFileSync(new URL(`fixtures/upgrade-${version}/component.js`,import.meta.url),'utf8');
    const start=full.indexOf('async function upgradeSelfCore('),end=full.indexOf('\nexport async function uninstallComponent',start);
    assert.ok(start>=0 && end>start);
    const output=[],calls=[];
    let targetResult;
    const context=vm.createContext({
      process:{argv:['node','zylos','--self','--yes',...(json?['--json']:[])]},path,ZYLOS_DIR:root,
      console:{log:value=>output.push(value),error:value=>output.push(value)},
      ...Object.fromEntries(['bold','dim','success','warn','yellow','green','heading','error'].map(name=>[name,value=>value])),
      acquireLock:()=>({success:true}),releaseLock:()=>calls.push('unlock'),cleanupCoreTemp:()=>calls.push('cleanup'),
      checkForCoreUpdates:()=>({success:true,hasUpdate:true,current:'old',latest:'target'}),
      downloadCoreToTemp:()=>({success:true,tempDir:root}),readCoreChangelog:()=>'',filterChangelog:()=>'',detectCoreSkillChanges:()=>[],
      printStep(){},printSelfUpgradeProtection(){},formatC4Reply:()=>'',getZylosConfig:()=>({runtime:'claude'}),
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
    const run=vm.compileFunction(`return (${full.slice(start,end)})();`,[],{parsingContext:context,importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
    assert.equal(await run(),true);
    assert.deepEqual(calls,['target','cleanup','unlock']);
    const restarts=fs.readFileSync(log,'utf8').trim().split('\n');
    assert.deepEqual(restarts,regression?['target','parent']:['target']);
    if(json)assert.equal(JSON.parse(output.at(-1)).success,true);
    else assert.match(output.join('\n'),/upgraded/);
  });
}
