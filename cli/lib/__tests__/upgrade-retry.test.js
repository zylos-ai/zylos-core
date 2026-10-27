import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { selectSameVersionRetry } from '../upgrade-retry.js';
import { databasesForFormat } from '../core-db-backup-worker.js';
import { createFinalizeState, runSelfUpgrade } from '../self-upgrade.js';
import { beginUpgrade, maintenance } from '../upgrade-protection.js';

const target = 'arbitrary-target';
const id = (ms, suffix = 'aaaaaaaaaaaa') => `upgrade-${ms}-${suffix}`;

async function cliAdmission(root) {
  const source=fs.readFileSync(new URL('../../commands/component.js',import.meta.url),'utf8');
  const start=source.indexOf('async function upgradeSelfCore(');
  const end=source.indexOf('\nexport async function uninstallComponent',start);
  assert.ok(start>=0 && end>start);
  const calls=[],outputs=[];
  const context=vm.createContext({
    process:{argv:['node','zylos','--json','--yes']},
    console:{log:value=>outputs.push(JSON.parse(value)),error:value=>outputs.push(value)},
    ZYLOS_DIR:root,selectSameVersionRetry,
    checkForCoreUpdates:()=>({success:true,current:target,latest:target,hasUpdate:false}),
    acquireLock:()=>{calls.push('lock');return {success:true};},
    releaseLock:()=>calls.push('unlock'),cleanupCoreTemp:()=>calls.push('cleanup'),
    downloadCoreToTemp:()=>{calls.push('download');throw Error('controlled download stop');},
    formatC4Reply:()=>'',
  });
  const run=vm.runInContext(source.slice(start,end)+'\nupgradeSelfCore',context);
  return {result:await run(),calls,outputs};
}

test('CLI ordinary up-to-date admission creates no lock or download', async t=>{
  const result=await cliAdmission(fixture(t));
  assert.equal(result.result,true);assert.deepEqual(result.calls,[]);
  assert.equal(result.outputs[0].action,'check');
});

test('CLI same-version retry reaches the controlled download under the lock', async t=>{
  const root=fixture(t);saved(root,id(1));
  const result=await cliAdmission(root);
  assert.equal(result.result,false);assert.deepEqual(result.calls,['lock','download','cleanup','unlock']);
  assert.equal(result.outputs[0].error,'controlled download stop');
});

test('CLI invalid latest retry rejects before lock and download', async t=>{
  const root=fixture(t);saved(root,id(1),{to:'different-target'});
  const result=await cliAdmission(root);
  assert.equal(result.result,false);assert.deepEqual(result.calls,[]);
  assert.equal(result.outputs[0].code,'RETRY_BASE_INVALID');
  assert.equal(result.outputs[0].field,'to');
});
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-retry-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function saved(root, transactionId, { phase = 'restored_complete', to = target, from = 'arbitrary-source', effectiveFrom, formatVersion = 1 } = {}) {
  const dir = path.join(root, '.backup/self-upgrade', transactionId);
  const dbBackupDir = path.join(root, '.backup/db', transactionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(dbBackupDir, { recursive: true });
  const manifest = {formatVersion, function:'core-self-upgrade-db',status:'complete',id:transactionId,
    databases:databasesForFormat(formatVersion).map(({source}) => ({source,status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null}))};
  const bytes = JSON.stringify(manifest);
  fs.writeFileSync(path.join(dbBackupDir, 'manifest.json'), bytes);
  const journal = {formatVersion:1,transactionId,zylosDir:root,phase,from,to,initialIdentity:{},dbBackupDir,
    snapshotManifestHash:crypto.createHash('sha256').update(bytes).digest('hex'),...(effectiveFrom === undefined ? {} : {effectiveFrom})};
  fs.writeFileSync(path.join(dir,'journal.json'), JSON.stringify(journal));
  return {dir,journal,manifest};
}

test('no history returns up to date without creating files', t => {
  const root = fixture(t);
  assert.equal(selectSameVersionRetry(root,target),null);
  assert.deepEqual(fs.readdirSync(root),[]);
});
for (const formatVersion of [1,2]) test(`restored format ${formatVersion} inherits its actual manifest and arbitrary source`, t => {
  const root=fixture(t), transactionId=id(200);
  saved(root,transactionId,{formatVersion});
  assert.deepEqual(selectSameVersionRetry(root,target),{retryOf:transactionId,effectiveFrom:'arbitrary-source',snapshotFormatVersion:formatVersion});
});
test('retry of retry preserves original effective source and finalize state fields', t => {
  const root=fixture(t), transactionId=id(201);
  saved(root,transactionId,{from:target,effectiveFrom:'original-source',formatVersion:2});
  const retry=selectSameVersionRetry(root,target);
  const state=createFinalizeState({...retry,preInstallProtection:true});
  assert.equal(state.retryOf,transactionId);
  assert.equal(state.effectiveFrom,'original-source');
  assert.equal(state.snapshotFormatVersion,2);
});
test('newest timestamp wins, full id breaks equal millisecond ties; never falls back', t => {
  const root=fixture(t);
  saved(root,id(9),{});
  saved(root,id(10,'aaaaaaaaaaaa'),{});
  saved(root,id(10,'bbbbbbbbbbbb'),{phase:'upgrade_complete'});
  assert.equal(selectSameVersionRetry(root,target),null);
  assert.equal(selectSameVersionRetry(root,target,{excludeTransactionId:id(10,'bbbbbbbbbbbb')}).retryOf,id(10));
});
test('mismatched latest restored target rejects with actionable identity before changes', t => {
  const root=fixture(t), transactionId=id(201);
  const {dir}=saved(root,transactionId,{to:'other'});
  const before=fs.readFileSync(path.join(dir,'journal.json'),'utf8');
  assert.throws(() => selectSameVersionRetry(root,target), error => error.code==='RETRY_BASE_INVALID' && error.transactionId===transactionId && error.field==='to' && !!error.next);
  assert.equal(fs.readFileSync(path.join(dir,'journal.json'),'utf8'),before);
  assert.deepEqual(fs.readdirSync(root).sort(),['.backup']);
});
test('damaged newest journal cannot fall back to an older restored candidate', t => {
  const root=fixture(t);
  saved(root,id(1),{});
  const {dir}=saved(root,id(2),{});
  fs.writeFileSync(path.join(dir,'journal.json'),'bad json');
  assert.throws(() => selectSameVersionRetry(root,target),{code:'RETRY_BASE_INVALID',transactionId:id(2),field:'journal'});
});
test('manifest corruption rejects rather than inferring format from source version', t => {
  const root=fixture(t), transactionId=id(2);
  const {journal}=saved(root,transactionId,{from:'0.9.2',formatVersion:2});
  fs.writeFileSync(path.join(journal.dbBackupDir,'manifest.json'),'{}');
  assert.throws(() => selectSameVersionRetry(root,target),{code:'RETRY_BASE_INVALID',field:'snapshotManifest'});
});
test('changed retry base is rejected before any pipeline steps', t => {
  const root=fixture(t);
  saved(root,id(1),{});
  const retry=selectSameVersionRetry(root,target);
  saved(root,id(2),{phase:'upgrade_complete'});
  const result=runSelfUpgrade({newVersion:target,retry},{zylosDir:root,getCurrentVersion:()=>({success:true,version:target}),preInstallSteps:[()=>{throw Error('must not execute');}]});
  assert.equal(result.success,false);
  assert.equal(result.code,'RETRY_BASE_INVALID');
});

test('retry identity and inherited format exist at the very first journal write', t => {
  const root=fixture(t), coreDir=path.join(root,'old-package'), tempDir=path.join(root,'new-package'), skillsDir=path.join(root,'.claude/skills');
  for (const dir of [path.join(coreDir,'skills/core'),path.join(tempDir,'skills/core'),path.join(coreDir,'cli/lib'),path.join(skillsDir,'core')]) fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(coreDir,'package.json'),'{"version":"old"}');
  fs.writeFileSync(path.join(coreDir,'cli/lib/core-db-backup-worker.js'),'// fixture');
  const ctx={coreDir,tempDir,from:target,to:target,retryOf:id(1),effectiveFrom:'original-source',snapshotFormatVersion:1};
  const originalServices=maintenance.services, originalUpdate=maintenance.update;
  let initial;
  maintenance.services=()=>[];
  maintenance.update=(dir,journal,changes)=>{
    initial ??= structuredClone(journal);
    return originalUpdate(dir,journal,changes);
  };
  try {
    beginUpgrade(ctx,{zylosDir:root,skillsDir});
    assert.equal(initial.retryOf,id(1));
    assert.equal(initial.effectiveFrom,'original-source');
    assert.equal(initial.from,target);
    assert.equal(initial.to,target);
    assert.equal(Object.hasOwn(initial,'snapshotFormatVersion'),false);
    assert.equal(initial.initialIdentity.databases.length,3);
    const state=createFinalizeState(ctx);
    assert.equal(state.retryOf,initial.retryOf);
    assert.equal(state.effectiveFrom,initial.effectiveFrom);
  } finally {
    ctx.releaseControl?.();
    maintenance.services=originalServices;
    maintenance.update=originalUpdate;
  }
});
