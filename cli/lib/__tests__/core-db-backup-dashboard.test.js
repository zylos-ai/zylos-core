import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {createCoreDbSnapshot,runCoreDbWorker,validateSnapshotManifest,probeCoreDbVersions,rehearseCoreDbUpgrade,prepareRecoveryDependencies} from '../core-db-backup.js';

const installed=process.env.CORE_DB_TEST_SKILL || path.resolve('skills/comm-bridge');
const Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-snapshot-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const driverRoot=path.join(root,'.claude/skills');
  fs.mkdirSync(path.join(driverRoot,'comm-bridge'),{recursive:true});
  fs.writeFileSync(path.join(driverRoot,'comm-bridge/package.json'),'{}');
  fs.symlinkSync(path.join(installed,'node_modules'),path.join(driverRoot,'comm-bridge/node_modules'));
  const target=path.join(root,'target'),schemaRoot=path.join(target,'skills');
  fs.mkdirSync(schemaRoot,{recursive:true});
  for(const name of ['comm-bridge','scheduler','web-console']) fs.symlinkSync(path.resolve('skills',name),path.join(schemaRoot,name));
  fs.mkdirSync(path.join(target,'cli/lib'),{recursive:true});
  fs.symlinkSync(path.resolve('cli/lib/core-db-backup-worker.js'),path.join(target,'cli/lib/core-db-backup-worker.js'));
  const dashboardRoot=path.join(schemaRoot,'dashboard');fs.mkdirSync(path.join(dashboardRoot,'src/lib'),{recursive:true});
  fs.writeFileSync(path.join(dashboardRoot,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(dashboardRoot,'index.js'),`throw Error('service entry must not load');`);
  // Pure owner deliberately has no driver dependency or node_modules.
  fs.writeFileSync(path.join(dashboardRoot,'src/lib/schema-owner.js'),`
    export const dashboardSchemaOwner={
      supportsNewDatabase(){return true;},
      inspectSchema(db){
        if(typeof db.prepare!=='function')throw Error('owner requires an open handle');
        const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
        const currentVersion=exists?db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version:null;
        return {currentVersion,targetVersion:20,needsMigration:currentVersion!==20};
      },
      migrate(db){db.transaction(()=>{db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)');db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?)').run(20);})();}
    };
  `);
  const source=path.join(root,'components/dashboard/dashboard.db');
  function database(version=12) {
    fs.mkdirSync(path.dirname(source),{recursive:true});const db=new Database(source);
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); CREATE TABLE events(value TEXT); PRAGMA user_version=7');
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(version);return db;
  }
  const payload={zylosDir:root,schemaRoot,driverRoot};
  return {root,target,schemaRoot,driverRoot,dashboardRoot,source,database,payload};
}

test('new snapshots always contain four rows and legacy validation remains available',t=>{
  const {root}=fixture(t),current=createCoreDbSnapshot({zylosDir:root,transactionId:'four'});
  assert.equal(current.manifest.formatVersion,2);assert.equal(current.manifest.databases.length,4);
  assert.equal(current.manifest.databases[3].source,'components/dashboard/dashboard.db');
  const verify=manifest=>runCoreDbWorker({action:'verify',zylosDir:root,dbBackupDir:current.dbBackupDir,manifest});
  assert.equal(verify(current.manifest).databases.length,4);
  const incomplete={...current.manifest,databases:current.manifest.databases.slice(0,3)};
  assert.throws(()=>verify(incomplete),/Incomplete/);
  assert.throws(()=>validateSnapshotManifest({...current.manifest,formatVersion:3}),/Unsupported/);
  assert.equal(verify({...incomplete,formatVersion:1}).databases.length,3);
  assert.throws(()=>createCoreDbSnapshot({zylosDir:root,transactionId:'legacy',formatVersion:1}),/require formatVersion 2/);
  assert.throws(()=>runCoreDbWorker({action:'snapshot',zylosDir:root,formatVersion:1}),/require formatVersion 2/);
});

test('Dashboard online snapshot includes WAL rows and normalizes only the copy',t=>{
  const {root,source,database}=fixture(t),writer=database();t.after(()=>writer.close());
  writer.pragma('journal_mode=WAL');writer.prepare('INSERT INTO events VALUES (?)').run('committed WAL');
  const before=[source,source+'-wal'].map(file=>fs.readFileSync(file));
  const result=createCoreDbSnapshot({zylosDir:root,transactionId:'wal-four'});
  const row=result.manifest.databases[3],file=path.join(result.dbBackupDir,row.file);
  assert.equal(row.userVersion,7);assert.equal(row.status,'backed_up');
  assert.deepEqual([source,source+'-wal'].map(file=>fs.readFileSync(file)),before);
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try {assert.equal(db.prepare('SELECT value FROM events').get().value,'committed WAL');assert.equal(db.pragma('journal_mode',{simple:true}),'delete');}finally{db.close();}
  for(const suffix of ['-wal','-shm'])assert.equal(fs.existsSync(file+suffix),false);
  assert.equal(runCoreDbWorker({action:'verify',zylosDir:root,dbBackupDir:result.dbBackupDir,manifest:result.manifest}).databases[3].sha256,hash(file));
});

test('Dashboard owner version rejects future schemas without writing the database',t=>{
  const {root,target,source,database,driverRoot,payload}=fixture(t);database(99).close();const before=fs.readFileSync(source);
  assert.throws(()=>probeCoreDbVersions(root,target,{driverRoot}),/SCHEMA_TOO_NEW.*99.*20/);
  assert.throws(()=>runCoreDbWorker({...payload,action:'offline-preflight'}),/SCHEMA_TOO_NEW.*99.*20/);
  assert.deepEqual(fs.readFileSync(source),before);
});

test('Dashboard rehearsal receives Core handles and migrates only the private copy',t=>{
  const {root,target,source,database,driverRoot}=fixture(t);database().close();const before=fs.readFileSync(source);
  assert.deepEqual(probeCoreDbVersions(root,target,{driverRoot}).databases[3],{source:'components/dashboard/dashboard.db',status:'present',fromVersion:12,toVersion:20,needsMigration:true});
  assert.equal(rehearseCoreDbUpgrade(root,target,{driverRoot}).databases[3].toVersion,20);
  assert.deepEqual(fs.readFileSync(source),before);
  const db=new Database(source);try {assert.equal(db.pragma('user_version',{simple:true}),7);}finally{db.close();}
});

test('all four owners use the explicitly frozen Core driver',t=>{
  const {root,payload,database}=fixture(t);database().close();
  const driverPath=path.join(root,'driver.cjs');
  fs.writeFileSync(driverPath,`const Database=require(${JSON.stringify(path.join(installed,'node_modules/better-sqlite3'))});module.exports=function(file,options){if(String(file).includes('/components/dashboard/'))throw Error('frozen Core driver reached Dashboard');return new Database(file,options);};`);
  assert.throws(()=>runCoreDbWorker({...payload,action:'version-probe',driverPath}),/frozen Core driver reached Dashboard/);
});

test('first takeover skips Dashboard owner actions but still snapshots its bytes',t=>{
  const {root,target,dashboardRoot,source,database,driverRoot,payload}=fixture(t);database(99).close();const before=fs.readFileSync(source);
  fs.rmSync(dashboardRoot,{recursive:true});
  assert.equal(probeCoreDbVersions(root,target,{driverRoot,firstTakeover:true}).databases.length,3);
  assert.equal(rehearseCoreDbUpgrade(root,target,{driverRoot,firstTakeover:true}).databases.length,3);
  assert.equal(runCoreDbWorker({...payload,action:'offline-preflight',firstTakeover:true}).databases[3].ownerSkipped,true);
  assert.equal(createCoreDbSnapshot({zylosDir:root,transactionId:'takeover'}).manifest.databases[3].status,'backed_up');
  assert.deepEqual(fs.readFileSync(source),before);
  assert.throws(()=>runCoreDbWorker({...payload,action:'ordinary-migrate',firstTakeover:true}),/Unknown action/);
  assert.throws(()=>runCoreDbWorker({...payload,action:'upgrade-migrate',firstTakeover:true}),/requires transaction identity/);
});

test('first takeover rejects corrupt Dashboard bytes even without an owner',t=>{
  const {source,payload}=fixture(t);fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,'invalid sqlite');
  assert.throws(()=>runCoreDbWorker({...payload,action:'offline-preflight',firstTakeover:true}),/not a database/);
});

test('standalone restored Dashboard is hash checked during first takeover',t=>{
  const {root,source,database,payload}=fixture(t);database().close();
  const snapshot=createCoreDbSnapshot({zylosDir:root,transactionId:'restore'});
  fs.copyFileSync(path.join(snapshot.dbBackupDir,'dashboard.db'),source);
  const request={...payload,action:'offline-preflight',manifest:snapshot.manifest,firstTakeover:true,standaloneRestored:true};
  assert.equal(runCoreDbWorker(request).databases[3].status,'present');
  const db=new Database(source);db.exec("INSERT INTO events VALUES ('changed')");db.close();
  assert.throws(()=>runCoreDbWorker(request),/hash mismatch/);
});

test('missing Dashboard creation support is checked without creating a business file',t=>{
  const {root,target,source,driverRoot,dashboardRoot}=fixture(t),file=path.join(dashboardRoot,'src/lib/schema-owner.js');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('supportsNewDatabase(){return true;}','supportsNewDatabase(){return false;}'));
  assert.throws(()=>probeCoreDbVersions(root,target,{driverRoot}),/cannot initialize missing database/);
  assert.equal(fs.existsSync(source),false);
});

test('recovery closure freezes only Core driver without Dashboard dependencies',t=>{
  const {root}=fixture(t),closure=prepareRecoveryDependencies(path.join(root,'transaction'),root);
  assert.equal(fs.existsSync(closure.driverPath),true);
  assert.equal(fs.existsSync(path.join(closure.driverClosureRoot,'dashboard-owner')),false);
  assert.equal(runCoreDbWorker({action:'probe',driverPath:closure.driverPath},{workerPath:closure.workerPath}).ok,true);
});

test('orphan Dashboard sidecars and invalid bytes fail snapshots durably',t=>{
  const {root,source}=fixture(t);fs.mkdirSync(path.dirname(source),{recursive:true});
  for(const [id,prepare] of [['orphan',()=>fs.writeFileSync(source+'-wal','orphan')],['corrupt',()=>{fs.rmSync(source+'-wal');fs.writeFileSync(source,'invalid sqlite');}]]) {
    prepare();assert.throws(()=>createCoreDbSnapshot({zylosDir:root,transactionId:id}),/Orphan SQLite|not a database/);
    assert.equal(fs.existsSync(path.join(root,'.backup/db',id)),false);
  }
  const dirs=fs.readdirSync(path.join(root,'.backup/db')).filter(name=>name.startsWith('.staging-'));
  assert.equal(dirs.length,2);
  for(const dir of dirs)assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.backup/db',dir,'failure.json'))).status,'failed');
});
