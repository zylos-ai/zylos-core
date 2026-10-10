import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-output-'));
process.env.ZYLOS_DIR=fixture;
const {formatC4Reply,formatSelfUpgradeProtection,printSelfUpgradeProtection}=await import('../../commands/component.js');
test.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
const snapshots=[{source:'comm-bridge/c4.db',status:'backed_up',userVersion:1},{source:'scheduler/scheduler.db',status:'missing',userVersion:null},{source:'web-console/web-console.db',status:'backed_up',userVersion:0}];
test('recovery-shaped compensation has no legacy steps and reports independent failure and completed recovery',()=>{
 const data={success:false,failedStep:2,error:'old finalizer refused v2',preInstallProtection:true,dbBackupDir:'/fixture/db/tx',databases:snapshots,transactionDir:'/fixture/tx',rollback:{attempted:true,completed:true,performed:true,stage:'restored_complete',recovery_required:false},recovery_required:false};
 const reply=formatC4Reply('self-upgrade',data);
 assert.match(reply,/upgrade failed.*old finalizer refused v2/);assert.match(reply,/attempted=true completed=true stage=restored_complete/);assert.match(reply,/Recovery required: no/);assert.match(reply,/scheduler\/scheduler.db: missing/);assert.match(reply,/comm-bridge\/c4.db: backed_up \(schema 1\)/);
 const original=console.log,lines=[];console.log=text=>lines.push(text);try{printSelfUpgradeProtection(data);}finally{console.log=original;}assert.equal(lines.join('\n'),formatSelfUpgradeProtection(data));assert.ok(reply.endsWith(lines.join('\n')));
});
test('unconfirmed recovery keeps upgrade failed and reports blocker and cleanup warnings',()=>{
 const reply=formatC4Reply('self-upgrade',{success:false,error:'install failed',rollback:{attempted:true,completed:false,performed:true,stage:'installing',error:'finalizer identity conflict',recovery_required:true,warnings:['archive pending']},cleanupWarnings:['archive pending','cleanup retry pending'],dbBackupDir:'/fixture/db/tx'});
 assert.match(reply,/attempted=true completed=false stage=installing: finalizer identity conflict/);assert.match(reply,/Recovery required: yes; maintenance remains active/);assert.equal(reply.match(/Cleanup warning: archive pending/g).length,1);assert.match(reply,/cleanup retry pending/);
});
test('successful protected upgrade reports retained snapshot states and terminal cleanup warnings',()=>{
 const reply=formatC4Reply('self-upgrade',{success:true,from:'1',to:'2',preInstallProtection:true,dbBackupDir:'/fixture/db/tx',databases:snapshots,archiveDir:'/fixture/archive/tx',cleanupWarnings:['terminal archive fsync pending']});
 assert.match(reply,/zylos-core upgraded: 1 -> 2/);assert.match(reply,/Pre-install protection: enabled/);assert.match(reply,/Database snapshots: \/fixture\/db\/tx/);assert.match(reply,/Archived recovery materials/);assert.match(reply,/terminal archive fsync pending/);assert.match(reply,/Rollback attempted=false completed=false stage=upgrade_complete/);assert.match(reply,/Recovery required: no/);
});
test('verified preinstall abort and unknown legacy completion do not claim database rollback',()=>{
 const aborted=formatC4Reply('self-upgrade',{success:false,error:'boot gate failed',rollback:{attempted:false,completed:false,stage:'aborted_before_install',recovery_required:false}});assert.match(aborted,/attempted=false completed=false stage=aborted_before_install/);
 const unknown=formatSelfUpgradeProtection({rollback:{performed:true}});assert.match(unknown,/attempted=true completed=unknown stage=unknown/);
 const legacy=formatC4Reply('self-upgrade',{success:false,error:'legacy failure',rollback:{performed:true,steps:[{success:true,action:'restore skills'}]}});assert.match(legacy,/Rollback: OK: restore skills/);assert.match(legacy,/completed=true/);
});
test('backup-only success reports verified snapshots and unavailable automatic recovery',()=>{
 const text=formatSelfUpgradeProtection({success:true,preInstallProtection:false,backupOnly:true,automaticRecovery:false,dbSnapshotVerified:true,dbBackupDir:'/fixture/manual/db',manualRecovery:{required:false,dbBackupDir:'/fixture/manual/db',instructions:'Automatic database recovery unavailable; restore manually if upgrade fails.'}});
 assert.match(text,/verified/i);assert.match(text,/automatic.*(unavailable|disabled)/i);assert.match(text,/manual/i);assert.match(text,/\/fixture\/manual\/db/);
 assert.doesNotMatch(text,/maintenance remains active/);
});
test('backup-only failure reports manual recovery without claiming automatic maintenance isolation',()=>{
 const text=formatC4Reply('self-upgrade',{success:false,error:'npm failed',preInstallProtection:false,backupOnly:true,automaticRecovery:false,dbSnapshotVerified:true,dbBackupDir:'/fixture/manual/db',manualRecovery:{required:true,dbBackupDir:'/fixture/manual/db',instructions:'Manual recovery required; automatic database recovery is unavailable.'}});
 assert.match(text,/manual recovery.*(required|yes)/i);assert.match(text,/\/fixture\/manual\/db/);assert.doesNotMatch(text,/maintenance remains active/);
});
test('failed backup-only snapshot never reports a verified backup',()=>{
 const text=formatSelfUpgradeProtection({success:false,preInstallProtection:false,backupOnly:true,automaticRecovery:false,dbSnapshotVerified:false,manualRecovery:{required:false,dbBackupDir:null,instructions:'Snapshot unavailable; installation did not start.'}});
 assert.match(text,/snapshot.*(unavailable|not verified|failed)/i);assert.doesNotMatch(text,/snapshots?: verified/i);
});


test('Mac compensation output distinguishes observed failure from interrupted takeover',()=>{
 const text=formatC4Reply('self-upgrade',{success:false,error:'npm failed',preInstallProtection:true,automaticCompensation:true,automaticResume:false,rollback:{attempted:true,completed:true,stage:'restored_complete'},recovery_required:false});
 assert.match(text,/Automatic compensation: available for observed failures after writer exit is confirmed/);
 assert.match(text,/Interrupted upgrade: manual recovery required; automatic takeover is disabled/);
 assert.match(text,/Rollback attempted=true completed=true stage=restored_complete/);
 assert.match(text,/Recovery required: no/);
});
