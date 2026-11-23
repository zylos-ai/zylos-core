// covers: cli/lib/upgrade-protection.js skills/comm-bridge/scripts/c4-schema.js skills/scheduler/scripts/schema.js cli/lib/core-db-backup.js skills/comm-bridge/scripts/sqlite-schema.js cli/lib/core-db-backup-worker.js cli/lib/upgrade-maintenance.cjs skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.1.0.sql skills/comm-bridge/scripts/__tests__/fixtures/migration-history/scheduler-v0.1.0.sql
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {protectedDataReady} from '../upgrade-protection.js';
import {SUPPORTED_SCHEMA_VERSION as C4_VERSION} from '../../../skills/comm-bridge/scripts/c4-schema.js';
import {SUPPORTED_SCHEMA_VERSION as SCHEDULER_VERSION} from '../../../skills/scheduler/scripts/schema.js';
import {CORE_DATABASES as ALL_CORE_DATABASES,createCoreDbSnapshot as snapshot,prepareRecoveryDependencies,probeCoreDbVersions as probeVersions,rehearseCoreDbUpgrade as rehearse,retirePreviousCoreDbSnapshots,runCoreDbWorker as worker} from '../core-db-backup.js';
const CORE_DATABASES=ALL_CORE_DATABASES.filter(item=>item.owner!=='dashboard');
const createCoreDbSnapshot=options=>snapshot(options);
const runCoreDbWorker=(payload,options)=>worker({dashboardOwnerManaged:false,...payload},options);
const probeCoreDbVersions=(root,target,options)=>probeVersions(root,target,{...options,dashboardOwnerManaged:false});
const rehearseCoreDbUpgrade=(root,target,options)=>rehearse(root,target,{...options,dashboardOwnerManaged:false});
const installed=process.env.CORE_DB_TEST_SKILL || path.resolve('skills/comm-bridge');
const currentVersions=[C4_VERSION,SCHEDULER_VERSION];
let Database;try{Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');}catch{}
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'core-db-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function skills(dir){for(const item of CORE_DATABASES){const owner=path.join(dir,'.claude','skills',item.owner);fs.mkdirSync(owner,{recursive:true});fs.writeFileSync(path.join(owner,'package.json'),'{}');fs.symlinkSync(path.join(installed,'node_modules'),path.join(owner,'node_modules'));}}
// Integration boundary: real SQLite/worker with temporary databases and copied
// dependencies only; run for backup/driver-path changes, skip if unrelated.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; fixture(t) cleans.
test('version probe uses pure owner inspection, detects a missing or older database, and rejects a newer one', {skip:!Database}, async t => {
 const dir=fixture(t);skills(dir);
 const {migrateDatabase}=await import('../../../skills/comm-bridge/scripts/sqlite-schema.js');
 const owners=await Promise.all([import('../../../skills/comm-bridge/scripts/c4-schema.js'),import('../../../skills/scheduler/scripts/schema.js')]);
 for(const item of CORE_DATABASES){
  const file=path.join(dir,item.source);fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);try{migrateDatabase(db,owners[CORE_DATABASES.indexOf(item)],{allowNew:true,strict:false});}finally{db.close();}
 }
 const probe=()=>probeCoreDbVersions(dir,path.resolve('.'),{driverRoot:path.join(dir,'.claude','skills')});
 const current=probe();
 assert.equal(current.needsMigration,false);
 assert.equal(current.databases.length,2);
 assert.ok(current.databases.every((row,index)=>row.fromVersion===currentVersions[index]&&row.toVersion===currentVersions[index]&&!row.needsMigration));
 assert.equal(fs.existsSync(path.join(dir,'.backup/db')),false);
 const scheduler=path.join(dir,'scheduler/scheduler.db'),db=new Database(scheduler);
 try{db.pragma('user_version=0');}finally{db.close();}
 const older=probe();
 assert.equal(older.needsMigration,true);
 assert.equal(older.databases.filter(row=>row.needsMigration).length,1);
 fs.unlinkSync(scheduler);
 const missing=probe();
 assert.equal(missing.needsMigration,true);
 assert.equal(missing.databases.find(row=>row.source==='scheduler/scheduler.db').status,'missing');
 const c4=new Database(path.join(dir,'comm-bridge/c4.db'));
 try{c4.pragma('user_version=99');}finally{c4.close();}
 assert.throws(probe,new RegExp(`exceeds supported ${C4_VERSION}`));
 assert.equal(fs.existsSync(path.join(dir,'.backup/db')),false);
});
test('missing DBs do not create files; orphan sidecars stop and preserve prior group',t=>{
 const dir=fixture(t);const first=createCoreDbSnapshot({zylosDir:dir,transactionId:'one',fromVersion:'1',toVersion:'2'});
 assert.equal(first.manifest.databases.filter(d=>d.status==='missing').length,3);
 fs.mkdirSync(path.join(dir,'scheduler'));fs.writeFileSync(path.join(dir,'scheduler/scheduler.db-wal'),'orphan');
 assert.throws(()=>createCoreDbSnapshot({zylosDir:dir,transactionId:'two'}),/Orphan SQLite/);
 assert.ok(fs.existsSync(first.dbBackupDir));assert.ok(!fs.existsSync(path.join(dir,'scheduler/scheduler.db')));
 const staging=fs.readdirSync(path.join(dir,'.backup/db')).find(n=>n.startsWith('.staging-'));assert.ok(fs.existsSync(path.join(dir,'.backup/db',staging,'failure.json')));
});
test('publishes only complete groups and preserves unrelated directories',t=>{
 const dir=fixture(t);const one=createCoreDbSnapshot({zylosDir:dir,transactionId:'one'});
 fs.mkdirSync(path.join(dir,'.backup/db/unrelated'));fs.writeFileSync(path.join(dir,'.backup/db/unrelated/note'),'keep');
 const two=createCoreDbSnapshot({zylosDir:dir,transactionId:'two'});
 assert.ok(fs.existsSync(one.dbBackupDir),'publication leaves the previous group intact');
 retirePreviousCoreDbSnapshots({zylosDir:dir,manifest:two.manifest});
 assert.ok(!fs.existsSync(one.dbBackupDir));assert.ok(fs.existsSync(two.dbBackupDir));assert.ok(fs.existsSync(path.join(dir,'.backup/db/unrelated/note')));
 assert.equal(fs.statSync(path.join(two.dbBackupDir,'manifest.json')).mode&0o777,0o600);
});
// Integration boundary: real SQLite/worker with temporary databases and copied
// dependencies only; run for backup/driver-path changes, skip if unrelated.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; fixture(t) cleans.
test('readonly WAL backup includes latest committed rows and independent frozen driver works', {skip:!Database},t=>{
 const dir=fixture(t);skills(dir);fs.mkdirSync(path.join(dir,'comm-bridge'));const source=path.join(dir,'comm-bridge/c4.db');
 const writer=new Database(source);t.after(()=>writer.close());writer.pragma('journal_mode=WAL');writer.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, message TEXT); PRAGMA user_version=7; INSERT INTO messages(message) VALUES (\'committed\')');
 const second=new Database(source);second.prepare('INSERT INTO messages(message) VALUES (?)').run('second-connection');second.close();
 const snapshot=createCoreDbSnapshot({zylosDir:dir,transactionId:'wal'});
 const row=snapshot.manifest.databases[0];assert.equal(row.userVersion,7);
 const snapshotFile=path.join(snapshot.dbBackupDir,row.file);
 const db=new Database(snapshotFile,{readonly:true});assert.equal(db.pragma('journal_mode',{simple:true}),'delete');assert.equal(db.prepare('SELECT message FROM messages').get().message,'committed');assert.equal(db.prepare('SELECT count(*) AS count FROM messages').get().count,2);db.close();assert.equal(writer.pragma('user_version',{simple:true}),7);assert.equal(writer.pragma('journal_mode',{simple:true}),'wal');
 for(const suffix of ['-wal','-shm'])assert.equal(fs.existsSync(snapshotFile+suffix),false);
 const transaction=path.join(dir,'transaction');const closure=prepareRecoveryDependencies(transaction,dir);
 for(const item of CORE_DATABASES)fs.unlinkSync(path.join(dir,'.claude/skills',item.owner,'node_modules'));
 assert.equal(runCoreDbWorker({action:'verify',zylosDir:dir,driverPath:closure.driverPath,dbBackupDir:snapshot.dbBackupDir,manifest:snapshot.manifest},closure).databases[0].integrityCheck,'ok');
 fs.appendFileSync(path.join(snapshot.dbBackupDir,row.file),'bad');assert.throws(()=>runCoreDbWorker({action:'verify',zylosDir:dir,driverPath:closure.driverPath,dbBackupDir:snapshot.dbBackupDir,manifest:snapshot.manifest},closure),/hash mismatch/);
});

// Integration boundary: real SQLite/worker with temporary databases and copied
// dependencies only; run for backup/driver-path changes, skip if unrelated.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; fixture(t) cleans.
test('target rehearsal migrates private copies and leaves source databases unchanged', {skip:!Database},t=>{
 const dir=fixture(t),source=path.join(dir,'comm-bridge/c4.db');skills(dir);
 fs.mkdirSync(path.dirname(source),{recursive:true});
 const db=new Database(source);
 try {
  db.exec(fs.readFileSync(path.resolve('skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.1.0.sql'),'utf8'));
  db.exec("INSERT INTO conversations(direction,channel,endpoint_id,content) VALUES('in','web-console','session-handoff','retained')");
 } finally {db.close();}
 const before=fs.readFileSync(source);
 const result=rehearseCoreDbUpgrade(dir,path.resolve('.'),{driverRoot:path.join(dir,'.claude','skills')});
 assert.deepEqual(result.databases.map(row=>row.toVersion),currentVersions);
 assert.equal(result.databases[0].fromVersion,0);
 assert.deepEqual(fs.readFileSync(source),before);
 assert.equal(fs.existsSync(path.join(dir,'scheduler/scheduler.db')),false);
 assert.equal(fs.existsSync(path.join(dir,'web-console/web-console.db')),false);
 assert.equal(fs.existsSync(path.join(dir,'.backup')),false);
});


// Integration boundary: real SQLite/worker with temporary databases and copied
// dependencies only; run for backup/driver-path changes, skip if unrelated.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; fixture(t) cleans.
test('worker snapshot sync failure aborts publication and retains the previous verified group', {skip:!Database},t=>{
 const dir=fixture(t);skills(dir);fs.mkdirSync(path.join(dir,'comm-bridge'));
 const source=path.join(dir,'comm-bridge/c4.db'),db=new Database(source);
 db.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('original')");db.close();
 const previous=createCoreDbSnapshot({zylosDir:dir,transactionId:'previous'});
 const hook=path.join(dir,'sync-failure.cjs');
 fs.writeFileSync(hook,"const fs=require('node:fs');fs.fsyncSync=()=>{throw Error('injected snapshot sync failure');};");
 const options=process.env.NODE_OPTIONS;
 try {
  process.env.NODE_OPTIONS=`--require=${hook}`;
  assert.throws(()=>createCoreDbSnapshot({zylosDir:dir,transactionId:'failed-sync'}),/injected snapshot sync failure/);
 } finally {if(options===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=options;}
 assert.equal(fs.existsSync(path.join(dir,'.backup/db/failed-sync')),false);
 assert.equal(runCoreDbWorker({action:'verify',zylosDir:dir,dbBackupDir:previous.dbBackupDir,manifest:previous.manifest}).databases[0].integrityCheck,'ok');
});

// Integration boundary: real SQLite/worker with temporary databases and copied
// dependencies only; run for backup/driver-path changes, skip if unrelated.
// Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; fixture(t) cleans.
test('controlled installed migration requires installing identity, preserves snapshots and initializes missing current databases', {skip:!Database},t=>{
 const dir=fixture(t),schemaRoot=path.join(dir,'.claude/skills');
 for(const item of CORE_DATABASES) {
  fs.cpSync(path.resolve('skills',item.owner),path.join(schemaRoot,item.owner),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
  fs.symlinkSync(path.join(installed,'node_modules'),path.join(schemaRoot,item.owner,'node_modules'));
 }
 for(const [source,sql] of [['comm-bridge/c4.db','skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.1.0.sql'],['scheduler/scheduler.db',null]]) {
  fs.mkdirSync(path.dirname(path.join(dir,source)),{recursive:true});
  const db=new Database(path.join(dir,source));
  if(sql)db.exec(fs.readFileSync(sql,'utf8'));
  else db.exec(fs.readFileSync(path.resolve('skills/comm-bridge/scripts/__tests__/fixtures/migration-history/scheduler-v0.1.0.sql'),'utf8'));
  db.close();
 }
 const extended=new Database(path.join(dir,'comm-bridge/c4.db'));
 extended.exec("CREATE TABLE archive_records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO archive_records VALUES (1, 'retained'); ALTER TABLE conversations ADD COLUMN extension_value TEXT");
 extended.close();
 const before=fs.readFileSync(path.join(dir,'comm-bridge/c4.db'));
 const schedulerBefore=fs.readFileSync(path.join(dir,'scheduler/scheduler.db'));
 assert.equal(runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot}).databases.length,3);
 assert.deepEqual(fs.readFileSync(path.join(dir,'comm-bridge/c4.db')),before);
 assert.deepEqual(fs.readFileSync(path.join(dir,'scheduler/scheduler.db')),schedulerBefore);
 assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot,requireCurrent:true}),/migrations remain/);
 const transactionId='controlled',transactionDir=path.join(dir,'.backup/self-upgrade',transactionId);
 const payload={action:'upgrade-migrate',zylosDir:dir,schemaRoot,transactionId,transactionDir};
 assert.throws(()=>runCoreDbWorker(payload));
 const snapshot=createCoreDbSnapshot({zylosDir:dir,transactionId});
 const m=createRequire(import.meta.url)('../upgrade-maintenance.cjs');
 fs.mkdirSync(transactionDir,{recursive:true,mode:0o700});
 fs.mkdirSync(path.join(dir,'.zylos/upgrade'),{recursive:true,mode:0o700});
 fs.copyFileSync(path.resolve('cli/lib/upgrade-maintenance.cjs'),path.join(dir,'.zylos/upgrade/maintenance.cjs'));fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/remove-owned-tree.js'),path.join(path.dirname(path.join(dir,'.zylos/upgrade/maintenance.cjs')),'remove-owned-tree.mjs'));
 fs.chmodSync(path.join(dir,'.zylos/upgrade/maintenance.cjs'),0o600);
 const j={formatVersion:1,from:'0.9.4',firstTakeover:true,dashboardOwnerManaged:false,transactionId,zylosDir:dir,skillsDir:schemaRoot,phase:'installing',installationIntent:true,initialIdentity:{},dbBackupDir:snapshot.dbBackupDir,snapshotManifestHash:m.hash(path.join(snapshot.dbBackupDir,'manifest.json'))};
 const digest='a'.repeat(64);
 Object.assign(j,{nodePath:process.execPath,coreManifest:[{name:'comm-bridge',existedBefore:true,backedUp:true,originalHash:digest}],originalServices:[]});
 j.initialIdentity={nodePath:process.execPath,cliRoot:path.join(dir,'package/cli'),cliHash:digest,packageJson:path.join(dir,'package/package.json'),packageHash:digest,workerPath:path.join(dir,'package/cli/lib/core-db-backup-worker.js'),workerHash:digest,ecosystemHash:null,databases:m.databasePaths(2).map(source=>({source,exists:['comm-bridge/c4.db','scheduler/scheduler.db'].includes(source)}))};
 const ordinary=[['comm-bridge/scripts/c4-db.js','getDb',"INSERT INTO conversations(direction,channel,content) VALUES ('in','fixture','after-ready')"],['scheduler/scripts/database.js','getDb',"INSERT INTO tasks(id,name,prompt,type,next_run_at,created_at,updated_at) VALUES ('after-ready','fixture','fixture','one-time',1,1,1)"]];
 const open=(item)=>spawnSync(process.execPath,['--input-type=module','-e',`const mod=await import(${JSON.stringify(path.join(schemaRoot,item[0]))});const db=mod[${JSON.stringify(item[1])}]();db.exec(${JSON.stringify(item[2])});db.close();`],{encoding:'utf8',env:{...process.env,HOME:dir,ZYLOS_DIR:dir,ZYLOS_PACKAGE_ROOT:path.resolve('.'),PM2_HOME:path.join(dir,'pm2-home')}});
 m.durable(path.join(transactionDir,'journal.json'),j);m.marker(dir,transactionDir,j);
 for(const item of ordinary){const result=open(item);assert.notEqual(result.status,0);assert.match(result.stderr,/unavailable|maintenance|upgrade/i);}

 assert.throws(()=>m.assertCoreDatabaseAvailable(dir),/maintenance|upgrade|blocked/i);
 assert.throws(()=>runCoreDbWorker({...payload,transactionId:'other'}),/identity mismatch/);
 const withoutTakeover={...j};delete withoutTakeover.dashboardOwnerManaged;
 m.durable(path.join(transactionDir,'journal.json'),withoutTakeover);
 assert.throws(()=>runCoreDbWorker({...payload,dashboardOwnerManaged:false}),/persisted Dashboard owner state/);
 m.durable(path.join(transactionDir,'journal.json'),j);
 const result=runCoreDbWorker(payload);
 assert.equal(result.databases.length,3);assert.deepEqual(result.databases.filter(row=>row.source!=='components/dashboard/dashboard.db').map(row=>row.userVersion),currentVersions);
 assert.deepEqual(result.databases[0].extensions,{tables:['archive_records'],columns:[{table:'conversations',column:'extension_value'}]});
 assert.throws(()=>m.assertCoreDatabaseAvailable(dir),/maintenance|upgrade|blocked/i);
 assert.equal(runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot,requireCurrent:true}).databases.length,3);
 assert.equal(runCoreDbWorker({action:'verify',zylosDir:dir,dbBackupDir:snapshot.dbBackupDir,manifest:snapshot.manifest}).databases[0].userVersion,0);
 assert.equal(runCoreDbWorker(payload).databases[0].userVersion,C4_VERSION);
 const retained=new Database(path.join(dir,'comm-bridge/c4.db'),{readonly:true});
 assert.equal(retained.prepare('SELECT value FROM archive_records WHERE id=1').get().value,'retained');retained.close();
 for(const item of ordinary)assert.notEqual(open(item).status,0);
 const preflight=m.preflight;m.preflight=()=>({success:true});
 try {protectedDataReady({transactionDir,transactionId});}finally{m.preflight=preflight;}
 for(const item of ordinary)assert.notEqual(open(item).status,0);
 // Migration completion does not publish business availability. Simulate the
 // verified terminal after the protected publication and service checks.
 m.update(transactionDir,j,{phase:'upgrade_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:true,servicesRestored:true}});
 m.unmark(dir,j);
 for(const item of ordinary){const result=open(item);assert.equal(result.status,0,result.stderr);}
 for(const [index,table] of ['conversations','tasks'].entries()) {
  const db=new Database(path.join(dir,CORE_DATABASES[index].source),{readonly:true});
  try {assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,1);}finally{db.close();}
 }
 assert.throws(()=>runCoreDbWorker(payload),/active installing|ENOENT/);
});
