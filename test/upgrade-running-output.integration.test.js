import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beginUpgrade, maintenance as m} from '../cli/lib/upgrade-protection.js';
import {runUpgradeEntry, outputUpgradeResult} from '../cli/lib/upgrade-entry.js';
import {upgradeSelfCore} from '../cli/commands/component.js';
import {runningUpgradeNotice} from '../cli/lib/upgrade-discovery.js';

function capture(result, jsonOutput) {
  let stdout='',stderr='';
  outputUpgradeResult(result,{jsonOutput},{stdout:{write:value=>{stdout+=value;}},stderr:{write:value=>{stderr+=value;}}});
  return {stdout,stderr};
}

// Boundary: real transaction publication/discovery and PID+boot+start check,
// followed by both human presenters. No installation, service, tmux or DB starts.
// Run for upgrade admission/presentation changes; skip unrelated finalization.
test('only a verified live controller changes both human entrypoints to wait and retry', async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-running-')));
  const coreDir=path.join(root,'old-package'),tempDir=path.join(root,'target'),skillsDir=path.join(root,'.claude/skills');
  for(const directory of [path.join(coreDir,'skills/core'),path.join(coreDir,'cli/lib'),path.join(tempDir,'skills/core'),path.join(skillsDir,'core')])fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(coreDir,'package.json'),JSON.stringify({name:'zylos',version:'1.0.0-beta.11'}));
  fs.writeFileSync(path.join(coreDir,'cli/lib/core-db-backup-worker.js'),'// fixture; never executed');
  const ctx={coreDir,tempDir,from:'1.0.0-beta.11',to:'1.0.0',firstTakeover:true,dashboardOwnerManaged:false};
  let controller,owner;
  t.after(()=>{if(ctx.releaseControl && owner)m.durable(controller,owner);ctx.releaseControl?.();fs.rmSync(root,{recursive:true,force:true});});
  const services=m.services;m.services=()=>[];
  t.after(()=>{m.services=services;});
  for(const key of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR'])assert.ok(process.env[key]?.startsWith(path.dirname(process.env.HOME)+path.sep),`${key} escaped isolation`);
  t.diagnostic(JSON.stringify({HOME:process.env.HOME,ZYLOS_DIR:process.env.ZYLOS_DIR,PM2_HOME:process.env.PM2_HOME,TMPDIR:process.env.TMPDIR,root,services:[],databases:[],tmux:'not started'}));
  beginUpgrade(ctx,{zylosDir:root,skillsDir});
  if(!m.canRecognizeProcesses()){t.skip('process identity unavailable on this platform');return;}
  controller=path.join(ctx.transactionDir,'controller.json');owner=m.read(controller);
  const input={schemaVersion:1,fromVersion:ctx.from,installedRoot:coreDir,tempDir,zylosDir:root};
  for(const kind of ['live','wrong-boot','wrong-start','missing-identity','released']) {
    if(kind==='released'){m.durable(controller,owner);ctx.releaseControl();ctx.releaseControl=null;}
    else m.durable(controller,kind==='live'?owner:kind==='wrong-boot'?{...owner,boot:'different'}:kind==='wrong-start'?{...owner,start:'different'}:{pid:owner.pid});
    const result=await runUpgradeEntry(input,{inspect(){assert.fail('unfinished transaction reached preflight');}});
    assert.equal(result.code,'UPGRADE_RECOVERY_REQUIRED');
    assert.equal(result.error,'Unfinished upgrade requires recovery before another installation.');
    assert.match(result.next,/recovery status/);
    const before=JSON.stringify(result),human=capture(result,false);
    assert.equal(capture(result,true).stdout,before+'\n');
    assert.equal(JSON.stringify(result),before);
    let text='';
    const deps={zylosDir:root,console:{error:line=>{text+=line+'\n';},log:()=>assert.fail('failed upgrade logged success')},checkForCoreUpdates:()=>assert.fail('unfinished upgrade checked remote')};
    // The live case uses real outer admission. Other states stop before its
    // recovery subprocess: this case tests presentation, not recovery execution.
    if(kind!=='live')deps.recoverBeforeUpgrade=()=>{throw Object.assign(Error(result.error),{recovery_required:true,next:result.next});};
    assert.equal(await upgradeSelfCore({},deps),false);
    let json='';
    assert.equal(await upgradeSelfCore({jsonOutput:true},{...deps,console:{log:line=>{json+=line;},error:()=>assert.fail('JSON admission printed human text')}}),false);
    const outer=JSON.parse(json);
    assert.deepEqual(Object.keys(outer).sort(),['success','code','error','persisted','recovery_required','next'].sort());
    assert.equal(outer.recovery_required,true);
    assert.match(outer.next,/recovery status/);
    assert.doesNotMatch(outer.error+' '+outer.next,/Another Core upgrade is still running|Wait for it/);
    for(const output of [human.stderr,text]) {
      if(kind==='live') {
        assert.match(output,/Another Core upgrade is still running/);
        assert.match(output,/Next: Wait for it to finish, then retry/);
        assert.doesNotMatch(output,/recovery status|blocked until recovery/);
      } else {
        assert.doesNotMatch(output,/still running|Wait for it/);
        assert.match(output,/Next: Run zylos recovery status/);
      }
    }
  }
});

test('ambiguous or unsupported identity never produces running guidance', () => {
  const candidate={dir:'/isolated/transaction'};
  for(const found of [{candidates:[candidate,candidate],diagnostics:[]},{candidates:[candidate],diagnostics:['untrusted']},{candidates:[candidate],diagnostics:[]}]) {
    const maintenance={discover:()=>found,canRecognizeProcesses:()=>false,read:()=>assert.fail('uncertain identity must not be read')};
    assert.equal(runningUpgradeNotice('/isolated',{maintenance}),null);
  }
});
