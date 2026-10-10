import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runSelfUpgrade} from '../self-upgrade.js';

test('darwin retains the legacy upgrade pipeline and advertises protection unavailable',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-darwin-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const calls=[];
 const result=runSelfUpgrade({newVersion:'2.0.0'},{
  platform:'darwin',zylosDir:root,getCurrentVersion:()=>({success:true,version:'1.0.0'}),
  preInstallSteps:[ctx=>{calls.push('legacy');assert.equal(ctx.preInstallProtection,false);return {step:1,status:'done'};}],
  runInstalledFinalizer:ctx=>{assert.equal(ctx.transactionDir,undefined);calls.push('finalizer');return {success:true,steps:[]};}
 });
 assert.equal(result.success,true);assert.equal(result.preInstallProtection,false);
 assert.match(result.protectionUnavailableReason,/unsupported/);assert.deepEqual(calls,['legacy','finalizer']);
 assert.equal(fs.existsSync(path.join(root,'.backup/self-upgrade')),false);
 assert.equal(fs.existsSync(path.join(root,'.zylos/upgrade/active.json')),false);
});

test('begin failure before publication reports no recovery requirement',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-prebegin-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const result=runSelfUpgrade({newVersion:'2.0.0'},{platform:'linux',zylosDir:root,skillsDir:path.join(root,'missing-skills'),getCurrentVersion:()=>({success:true,version:'1.0.0'})});
 assert.equal(result.success,false);assert.equal(result.preInstallProtection,false);assert.equal(result.recovery_required,false);
 assert.equal(fs.existsSync(path.join(root,'.zylos/upgrade/active.json')),false);
});

test('Linux without required process and lock capability uses the legacy path before publication',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-unsupported-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let called=false;
 const result=runSelfUpgrade({newVersion:'2.0.0'},{platform:'linux',protectionSupported:()=>false,zylosDir:root,
  getCurrentVersion:()=>({success:true,version:'1.0.0'}),
  preInstallSteps:[ctx=>{assert.equal(ctx.preInstallProtection,false);called=true;return {step:1,status:'done'};}],
  runInstalledFinalizer:()=>({success:true,steps:[]})});
 assert.equal(called,true);assert.equal(result.success,true);assert.equal(result.preInstallProtection,false);
 assert.match(result.protectionUnavailableReason,/unsupported/);assert.equal(fs.existsSync(path.join(root,'.backup')),false);
});
