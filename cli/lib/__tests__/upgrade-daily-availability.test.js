import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {savePm2ProcessList} from '../pm2-save.js';
import {discoverUpgradeContext} from '../runtime/upgrade-context.js';
import {runUpgradeEntry} from '../upgrade-entry.js';
import {recoverBeforeUpgrade} from '../upgrade-discovery.js';
import {upgradeSelfCore} from '../../commands/component.js';
import {assertCoreDatabaseAvailable as assertOwnerDatabaseAvailable} from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.UPGRADE_DAILY_TEST_TMPDIR || os.tmpdir(),'upgrade-daily-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
 for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-bootstrap.cjs','bootstrap.cjs']]) {
  fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dest));fs.chmodSync(path.join(stable,dest),0o600);
 }
 const dir=path.join(root,'.backup/self-upgrade/active');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const digest='a'.repeat(64);
 const j={formatVersion:1,transactionId:'active',zylosDir:root,phase:'restored_data_ready',installationIntent:true,
  nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),dbBackupDir:path.join(root,'.backup/db/active'),snapshotManifestHash:digest,
  coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:digest}],originalServices:[],
  initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:digest,cliRoot:path.join(root,'cli'),cliHash:digest,
   workerPath:path.join(root,'cli/worker.js'),workerHash:digest,ecosystemHash:null,databases:m.databasePaths(2).map(source=>({source,exists:true}))}};
 function save(){m.durable(path.join(dir,'journal.json'),j);}
 save();return {root,dir,stable,j,save};
}
function writeUsingOwners(root) {
 const code=`import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';import {openDb} from './skills/web-console/scripts/db.js';for(const db of [getDb(),scheduler(),openDb()]){db.exec('CREATE TABLE IF NOT EXISTS daily_probe(value TEXT)');db.prepare('INSERT INTO daily_probe VALUES (?)').run('written');}close();`;
 return spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:root}});
}
for (const phase of ['upgrade_complete','restored_complete','aborted_before_install']) test(`completed legacy three-database ${phase} history permits upgrade admission`, t => {
 const f=fixture(t);
 f.j.phase=phase;
 f.j.initialIdentity.databases.pop();
 f.j.installationIntent=phase!=='aborted_before_install';
 f.j.cleanup={complete:true,servicesRestored:true};
 f.j.terminalEvidence={verified:true,kind:f.j.installationIntent?'code_data_services':'original_deployment_and_readonly_data'};
 f.save();
 assert.deepEqual(m.discover(f.root),{marker:null,candidates:[],diagnostics:[],blocked:false});
 for (const corrupt of [...(phase==='upgrade_complete'?[]:[j=>{j.cleanup.complete=false;}]),j=>{j.phase='installing';},j=>{j.terminalEvidence.verified=false;},j=>{j.recoveryHashes={};},j=>{j.compensationCutoff={};}]) {
  const saved=structuredClone(f.j);corrupt(f.j);f.save();
  assert.equal(m.discover(f.root).blocked,true);
  Object.assign(f.j,saved);delete f.j.recoveryHashes;delete f.j.compensationCutoff;
 }
});

test('historical terminal journal shapes with retained scripts permit upgrade and startup despite incomplete cleanup', async t => {
 const f=fixture(t);
 fs.rmSync(f.dir,{recursive:true});
 const fixtures=new URL('./helpers/legacy-journals/',import.meta.url);
 const files=fs.readdirSync(fixtures).filter(name=>name.endsWith('.json'));
 assert.equal(files.length,3);
 const journals=files.map(file=>JSON.parse(fs.readFileSync(new URL(file,fixtures),'utf8')));
 // The 0.9.3 case is a shape stand-in, not a real historical release run.
 journals.push({...structuredClone(journals.at(-1)),transactionId:'legacy-092-093-shape',from:'0.9.2',to:'0.9.3'});
 for(const historical of journals) {
  const originalRoot=historical.zylosDir;
  const relocate=value=>Array.isArray(value)?value.map(relocate):value&&typeof value==='object'
   ?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,relocate(item)]))
   :typeof value==='string'?value.replaceAll(originalRoot,f.root):value;
  const journal=relocate(historical);
  journal.dbBackupDir=path.join(f.root,'.backup/db',journal.transactionId);
  const dir=path.join(f.root,'.backup/self-upgrade',journal.transactionId);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const sentinel=path.join(f.root,'historical-script-executed');
  for(const name of ['runner.cjs','maintenance.cjs'])fs.writeFileSync(path.join(dir,name),
   `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'unexpected');throw Error('historical recovery must not execute');`,{mode:0o600});
  const manifest={formatVersion:1,function:'core-self-upgrade-db',status:'complete',id:journal.transactionId,
   databases:journal.initialIdentity.databases.map(d=>({source:d.source,status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null}))};
  m.durable(path.join(journal.dbBackupDir,'manifest.json'),manifest);
  journal.snapshotManifestHash=m.hash(path.join(journal.dbBackupDir,'manifest.json'));
  assert.equal(journal.initialIdentity.databases.length,3);
  assert.equal(Object.hasOwn(journal,'recoveryHashes'),false);
  for(const complete of [true,false]) {
   journal.cleanup.complete=complete;
   m.durable(path.join(dir,'journal.json'),journal);
   const before=fs.readFileSync(path.join(dir,'journal.json'));
   assert.deepEqual(m.discover(f.root),{marker:null,candidates:[],diagnostics:[],blocked:false});
   assert.deepEqual(recoverBeforeUpgrade(f.root),{active:false});
   assert.deepEqual(discoverUpgradeContext(f.root),{active:false,blocked:false});
   let inspected=false;
   const result=await runUpgradeEntry({schemaVersion:1,fromVersion:'0.9.3',tempDir:f.root,installedRoot:f.root,zylosDir:f.root},{
    inspect:()=>{inspected=true;throw Object.assign(Error('inspection boundary'),{code:'INSPECTION_REACHED'});}
   });
   assert.equal(inspected,true);
   assert.equal(result.code,'INSPECTION_REACHED');
   let checked=false,delegated=false;
   fs.mkdirSync(path.join(f.root,'cli/lib'),{recursive:true});
   fs.writeFileSync(path.join(f.root,'package.json'),'{}');
   fs.writeFileSync(path.join(f.root,'cli/lib/upgrade-entry.js'),'');
   assert.equal(await upgradeSelfCore({skipConfirm:true},{zylosDir:f.root,
    checkForCoreUpdates(){checked=true;return {success:true,current:'0.9.3',latest:'0.9.4',hasUpdate:true};},
    downloadCoreToTemp(){return {success:true,tempDir:f.root};},
    runDownloadedUpgrade(){delegated=true;return 0;},cleanupCoreTemp(){},console:{log(){},error(){}}}),true);
   assert.equal(checked,true);assert.equal(delegated,true);
   const written=writeUsingOwners(f.root);assert.equal(written.status,0,written.stderr);
   assert.deepEqual(fs.readFileSync(path.join(dir,'journal.json')),before);
   assert.equal(fs.existsSync(sentinel),false);
  }
 }
 assert.deepEqual(m.discover(f.root).candidates,[]);
 assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(f.root));
 const damaged=path.join(f.root,'.backup/self-upgrade/damaged');fs.mkdirSync(damaged);
 fs.writeFileSync(path.join(damaged,'journal.json'),'{');
 const mixed=m.discover(f.root);
 assert.equal(mixed.blocked,true);assert.ok(mixed.diagnostics.length>0);
 assert.deepEqual(mixed.candidates,[],'a full scan must not rediscover clean legacy history as unfinished');
});

const realOpeners=[
 ['C4','./skills/comm-bridge/scripts/c4-db.js','getDb','comm-bridge/c4.db'],
 ['Scheduler','./skills/scheduler/scripts/database.js','getDb','scheduler/scheduler.db'],
 ['Web Console','./skills/web-console/scripts/db.js','openDb','web-console/web-console.db'],
];
const cutoffShapes=[
 ['closed hooks pending','compensation_closed','pending',true,false],
 ['closed hooks done','compensation_closed','done',true,true],
 ['recovery closed hooks done','recovery_required','done',true,true],
 ['recovery closed hooks pending','recovery_required','pending',true,false],
 ['invalid cutoff hooks done','compensation_closed','done',false,false],
];
for(const [shape,phase,hooks,validCutoff,allowed] of cutoffShapes)for(const [owner,module,entry,source] of realOpeners)
 test(`actual ${owner} opener: ${shape}`,t=>{
  const f=fixture(t);
  const seed=writeUsingOwners(f.root);assert.equal(seed.status,0,seed.stderr);
  Object.assign(f.j,{phase,...(phase==='recovery_required'?{resumePhase:'compensation_closed'}:{}),
   postCutoff:{items:{hooks:{state:hooks}}},compensationCutoff:{formatVersion:1,closed:true,
    transactionId:validCutoff?f.j.transactionId:'wrong-transaction',snapshotManifestHash:f.j.snapshotManifestHash,
    closedAt:'2026-10-28T00:00:00.000Z',writer:'finalizer'}});
  f.save();m.marker(f.root,f.dir,f.j);
  const journalBefore=fs.readFileSync(path.join(f.dir,'journal.json'));
  const markerBefore=fs.readFileSync(path.join(f.stable,'active.json'));
  const databaseBytes=()=>Object.fromEntries(m.DB_PATHS.flatMap(db=>['','-wal','-shm'].map(suffix=>db+suffix))
   .filter(db=>fs.existsSync(path.join(f.root,db))).map(db=>[db,fs.readFileSync(path.join(f.root,db))]));
  const before=databaseBytes();
  const code=`import {${entry} as open} from ${JSON.stringify(module)};try{const db=open();db.prepare('INSERT INTO daily_probe VALUES (?)').run('');console.log(db.prepare('SELECT COUNT(*) AS n FROM daily_probe').get().n);db.close();}catch(error){console.error(error.code+': '+error.message);process.exitCode=1;}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:f.root}});
  if(allowed) {assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'2');}
  else {assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/ZYLOS_MAINTENANCE/);assert.deepEqual(databaseBytes(),before);}
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'journal.json')),journalBefore,'open must not change any journal field');
  assert.deepEqual(fs.readFileSync(path.join(f.stable,'active.json')),markerBefore);
  assert.equal(m.read(path.join(f.dir,'journal.json')).phase,phase);
  assert.equal(fs.existsSync(path.join(f.root,source)),true);
 });
for(const damage of ['malformed','missing','oversized','unknown-entry','dangling-backup'])test(`unmarked ${damage} history cannot stop ordinary database writes or startup`,t=>{
 const f=fixture(t);
 if(damage==='malformed')fs.writeFileSync(path.join(f.dir,'journal.json'),'{');
 if(damage==='missing')fs.unlinkSync(path.join(f.dir,'journal.json'));
 if(damage==='oversized')fs.writeFileSync(path.join(f.dir,'journal.json'),'x'.repeat(1024*1024+1));
 if(damage==='unknown-entry')fs.writeFileSync(path.join(f.root,'.backup/self-upgrade/foreign-entry'),'anything');
 if(damage==='dangling-backup'){fs.renameSync(path.join(f.root,'.backup'),path.join(f.root,'old-backup'));fs.symlinkSync(path.join(f.root,'absent'),path.join(f.root,'.backup'));}
 assert.equal(discoverUpgradeContext(f.root).active,false);
 assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(f.root));
 assert.equal(savePm2ProcessList({root:f.root,save:()=>{},log:()=>{}}),true);
 const result=writeUsingOwners(f.root);assert.equal(result.status,0,result.stderr);
 if(damage==='malformed') {
  const hook=spawnSync(process.execPath,['skills/comm-bridge/scripts/c4-session-init.js'],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:f.root}});
  assert.equal(hook.status,0,hook.stderr);
  assert.match(hook.stdout,/^=== RECENT CONVERSATIONS ===$/m);
  assert.ok(hook.stdout.includes(`Scope: *. Working memory is not injected. Read the complete snapshot with: node ${path.join(f.root,'.claude/skills/zylos-memory/scripts/read-work-memory.js')} --json`));
  assert.ok(hook.stdout.includes(`Before resuming work, read ${path.join(f.root,'memory/handoff.md')} in full`));
  assert.doesNotMatch(hook.stdout,/LAST CHECKPOINT|UPGRADE RECOVERY TASK/);
 }
 assert.equal(m.discover(f.root).blocked,true,'explicit recovery still diagnoses damaged history');
});

test('active READY ignores unrelated corrupt history, allows real writes, and still suppresses PM2 save',t=>{
 const f=fixture(t);
 for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','runner.cjs'],['upgrade-installer.cjs','installer.cjs']]) {
  fs.copyFileSync(path.resolve('cli/lib',src),path.join(f.dir,dest));fs.chmodSync(path.join(f.dir,dest),0o600);
 }
 f.j.recoveryHashes=Object.fromEntries(['maintenance.cjs','runner.cjs','installer.cjs'].map(name=>[name,m.hash(path.join(f.dir,name))]));
 f.save();m.marker(f.root,f.dir,f.j);
 const old=path.join(f.root,'.backup/self-upgrade/old');fs.mkdirSync(old,{mode:0o700});fs.writeFileSync(path.join(old,'journal.json'),'{');
 assert.equal(m.discover(f.root).blocked,true);
 assert.equal(m.discoverActive(f.root).blocked,false);
 assert.equal(discoverUpgradeContext(f.root).blocked,false);
 assert.equal(savePm2ProcessList({root:f.root,save:()=>assert.fail('must preserve list'),log:()=>{}}),false);
 const result=writeUsingOwners(f.root);assert.equal(result.status,0,result.stderr);
});

for(const phase of ['preparing','stopping','offline','installing','restoring','recovery_required'])test(`explicit active ${phase} prevents actual owner writes`,t=>{
 const f=fixture(t);f.j.phase=phase;f.save();m.marker(f.root,f.dir,f.j);
 assert.equal(m.discoverActive(f.root).blocked,true);
 const result=writeUsingOwners(f.root);assert.notEqual(result.status,0);assert.match(result.stderr,/maintenance/);
 for(const source of m.DB_PATHS)assert.equal(fs.existsSync(path.join(f.root,source)),false);
});

for(const phase of ['compensation_closed','recovery_required'])for(const hooks of ['done','pending','failed'])test(`default reader checks cutoff and hooks for ${phase}/${hooks}`,t=>{
 const f=fixture(t);
 Object.assign(f.j,{phase,resumePhase:'compensation_closed',postCutoff:{items:{hooks:{state:hooks}}},
  compensationCutoff:{formatVersion:1,closed:true,transactionId:f.j.transactionId,snapshotManifestHash:f.j.snapshotManifestHash,closedAt:'2026-10-28T00:00:00.000Z',writer:'finalizer'}});
 f.save();m.marker(f.root,f.dir,f.j);
 assert.equal(m.discoverActive(f.root).blocked,hooks!=='done');
 if(hooks==='done')assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(f.root));
 else assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),{code:'ZYLOS_MAINTENANCE'});
 f.j.compensationCutoff.transactionId='other';f.save();
 assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),{code:'ZYLOS_MAINTENANCE'});
});

for(const value of [undefined,'','0','false','1','true'])test(`database availability ignores Zylos environment switches set to ${JSON.stringify(value)}`,t=>{
 const f=fixture(t),environment=process.env;
 // Installer flags and any proposed Zylos bypass flag cannot authorize an open.
 process.env=new Proxy(environment,{get(target,key){
  if(typeof key==='string'&&key.startsWith('ZYLOS_')&&key!=='ZYLOS_DIR')return value;
  return Reflect.get(target,key);
 }});
 try{
  const stable=require(path.join(f.stable,'maintenance.cjs'));
  const readers=[()=>m.assertCoreDatabaseAvailable(f.root),()=>stable.assertCoreDatabaseAvailable(f.root),()=>assertOwnerDatabaseAvailable(f.root)];
  for(const [phase,hooks,cutoff,allowed] of [
   ['installing','done','missing',false],
   ['compensation_closed','pending','valid',false],
   ['compensation_closed','done','invalid',false],
   ['compensation_closed','done','valid',true],
   ['recovery_required','done','valid',true],
  ]){
   Object.assign(f.j,{phase,resumePhase:'compensation_closed',postCutoff:{items:{hooks:{state:hooks}}}});
   delete f.j.compensationCutoff;
   if(cutoff!=='missing')f.j.compensationCutoff={formatVersion:1,closed:true,transactionId:cutoff==='valid'?f.j.transactionId:'other',snapshotManifestHash:f.j.snapshotManifestHash,closedAt:'2026-10-28T00:00:00.000Z',writer:'finalizer'};
   f.save();m.marker(f.root,f.dir,f.j);
   const journal=fs.readFileSync(path.join(f.dir,'journal.json')),marker=fs.readFileSync(path.join(f.stable,'active.json'));
   for(const read of readers)if(allowed)assert.doesNotThrow(read,`${phase}/${hooks}/${cutoff}`);else assert.throws(read,{code:'ZYLOS_MAINTENANCE'},`${phase}/${hooks}/${cutoff}`);
   assert.deepEqual(fs.readFileSync(path.join(f.dir,'journal.json')),journal);
   assert.deepEqual(fs.readFileSync(path.join(f.stable,'active.json')),marker);
  }
 }finally{process.env=environment;}
});

test('malformed active journal stays blocked while abandoned unmarked preparation permits daily use but rejects upgrade',async t=>{
 const f=fixture(t);f.j.phase='preparing';f.j.installationIntent=false;f.save();
 assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(f.root));
 let preflight=false;
 const result=await runUpgradeEntry({schemaVersion:1,fromVersion:'0.9.3',tempDir:f.root,installedRoot:f.root,zylosDir:f.root},{preflight:()=>{preflight=true;}});
 assert.equal(result.success,false);assert.equal(result.recovery_required,true);assert.equal(preflight,false);
 m.marker(f.root,f.dir,f.j);fs.writeFileSync(path.join(f.dir,'journal.json'),'{');
 assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),/maintenance/);assert.equal(discoverUpgradeContext(f.root).blocked,true);
});
