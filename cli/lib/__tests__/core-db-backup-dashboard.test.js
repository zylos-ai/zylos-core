import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createCoreDbSnapshot,runCoreDbWorker,validateSnapshotManifest,probeCoreDbVersions,rehearseCoreDbUpgrade,prepareRecoveryDependencies} from '../core-db-backup.js';

const installed=process.env.CORE_DB_TEST_SKILL;
let Database;try {Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');} catch {}
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-snapshot-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const driverRoot=path.join(root,'.claude/skills');
  for(const name of ['comm-bridge','scheduler','web-console']) {
    const owner=path.join(driverRoot,name);fs.mkdirSync(owner,{recursive:true});
    fs.writeFileSync(path.join(owner,'package.json'),'{}');
    fs.symlinkSync(path.join(installed,'node_modules'),path.join(owner,'node_modules'));
  }
  const dashboardRoot=path.join(root,'owner');fs.mkdirSync(path.join(dashboardRoot,'src/lib'),{recursive:true});
  fs.writeFileSync(path.join(dashboardRoot,'package.json'),'{"type":"module","main":"index.js"}');
  fs.writeFileSync(path.join(dashboardRoot,'index.js'),`throw Error('Dashboard service entry must not load');`);
  fs.symlinkSync(path.join(installed,'node_modules'),path.join(dashboardRoot,'node_modules'));
  // Frozen IB-62 contract substitute. Dashboard owns its version authority;
  // migration 20 deliberately differs from old prose's illustrative 13.
  fs.writeFileSync(path.join(dashboardRoot,'src/lib/schema-owner.js'),`
    import fs from 'node:fs';
    import path from 'node:path';
    import {createRequire} from 'node:module';
    const Database=createRequire(${JSON.stringify(path.join(installed,'package.json'))})('better-sqlite3');
    export const dashboardSchemaOwner={
      supportsNewDatabase(){return true;},
      inspectSchema(file){
        if(!fs.existsSync(file))return {currentVersion:null,targetVersion:20,needsMigration:true};
        const db=new Database(file,{readonly:true,fileMustExist:true});
        try {const currentVersion=db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
          return {currentVersion,targetVersion:20,needsMigration:currentVersion<20};}finally{db.close();}
      },
      migrate(file){fs.mkdirSync(path.dirname(file),{recursive:true});const db=new Database(file);
        try {db.transaction(()=>{db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)');db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?)').run(20);})();}finally{db.close();}
      }
    };
  `);
  const source=path.join(root,'components/dashboard/dashboard.db');
  function database(version=12) {
    fs.mkdirSync(path.dirname(source),{recursive:true});const db=new Database(source);
    db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); CREATE TABLE events(value TEXT); PRAGMA user_version=0');
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(version);return db;
  }
  return {root,driverRoot,dashboardRoot,source,database};
}

test('new snapshots contain exactly four rows, legacy format remains three, and verification rejects incomplete groups',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'four-missing-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const current=createCoreDbSnapshot({zylosDir:root,transactionId:'four'});
  assert.equal(current.manifest.formatVersion,2);assert.equal(current.manifest.databases.length,4);
  assert.equal(current.manifest.databases[3].source,'components/dashboard/dashboard.db');
  assert.equal(fs.existsSync(path.join(root,'components/dashboard/dashboard.db')),false);
  const verify=manifest=>runCoreDbWorker({action:'verify',zylosDir:root,dbBackupDir:current.dbBackupDir,manifest});
  assert.equal(verify(current.manifest).databases.length,4);
  const incomplete={...current.manifest,databases:current.manifest.databases.slice(0,3)};
  assert.throws(()=>verify(incomplete),/Incomplete/);
  assert.throws(()=>validateSnapshotManifest({...current.manifest,formatVersion:3}),/Unsupported/);
  assert.throws(()=>verify({...current.manifest,databases:[...incomplete.databases,incomplete.databases[0]]}),/Invalid snapshot source/);
  const legacy={...incomplete,formatVersion:1};assert.equal(verify(legacy).databases.length,3);
  assert.throws(()=>verify({...legacy,databases:current.manifest.databases}),/Incomplete/);
});

test('presence-only original verification remains distinct from complete snapshot manifests',{skip:!Database},t=>{
  const {root,driverRoot}=fixture(t);
  const sources=['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db'];
  const payload={action:'offline-preflight',zylosDir:root,schemaRoot:path.resolve('skills'),driverRoot,expectedDatabases:sources.map(source=>({source,status:'missing'}))};
  assert.equal(runCoreDbWorker(payload).databases.length,3);
  assert.throws(()=>runCoreDbWorker({...payload,action:'verify'}),/Missing manifest entry/);
  assert.throws(()=>runCoreDbWorker({...payload,expectedDatabases:[...payload.expectedDatabases.slice(0,2),payload.expectedDatabases[0]]}),/Invalid original database presence evidence/);
});

test('original Dashboard presence evidence rejects both unexpected disappearance and creation',{skip:!Database},t=>{
  const {root,source,database,driverRoot,dashboardRoot}=fixture(t);
  database().close();const before=fs.readFileSync(source);
  const expectedDatabases=['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db','components/dashboard/dashboard.db'].map(source=>({source,status:'missing'}));
  const payload={action:'offline-preflight',zylosDir:root,schemaRoot:path.resolve('skills'),driverRoot,dashboardRoot,expectedDatabases,formatVersion:2};
  assert.throws(()=>runCoreDbWorker(payload),/Expected missing database exists/);
  assert.deepEqual(fs.readFileSync(source),before);
  expectedDatabases[3].status='complete';
  assert.equal(runCoreDbWorker(payload).databases[3].status,'present');
  fs.unlinkSync(source);
  assert.throws(()=>runCoreDbWorker(payload),/Expected database absent/);
  expectedDatabases[3].status='missing';
  assert.equal(runCoreDbWorker(payload).databases[3].status,'missing');
  assert.equal(fs.existsSync(source),false);
});

test('Dashboard online snapshot includes committed WAL rows and normalizes only the copy',{skip:!Database},t=>{
  const {root,source,database}=fixture(t),writer=database();t.after(()=>writer.close());
  writer.pragma('journal_mode=WAL');writer.prepare('INSERT INTO events VALUES (?)').run('committed WAL');
  const before=[source,source+'-wal'].map(file=>fs.readFileSync(file));
  const result=createCoreDbSnapshot({zylosDir:root,transactionId:'wal-four'});
  const row=result.manifest.databases[3],file=path.join(result.dbBackupDir,row.file);
  assert.equal(row.file,'dashboard.db');assert.equal(row.userVersion,0);assert.equal(row.status,'backed_up');
  assert.deepEqual([source,source+'-wal'].map(file=>fs.readFileSync(file)),before);
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try {assert.equal(db.prepare('SELECT value FROM events').get().value,'committed WAL');assert.equal(db.pragma('journal_mode',{simple:true}),'delete');}finally{db.close();}
  for(const suffix of ['-wal','-shm'])assert.equal(fs.existsSync(file+suffix),false);
  assert.equal(runCoreDbWorker({action:'verify',zylosDir:root,dbBackupDir:result.dbBackupDir,manifest:result.manifest}).databases[3].sha256,hash(file));
});

test('Dashboard owner schema, rather than user_version, rejects future schemas before modifications',{skip:!Database},t=>{
  const {root,source,database,driverRoot,dashboardRoot}=fixture(t);database(99).close();const before=fs.readFileSync(source);
  const snapshot=createCoreDbSnapshot({zylosDir:root,transactionId:'future'});
  assert.equal(snapshot.manifest.databases[3].status,'backed_up');
  assert.throws(()=>probeCoreDbVersions(root,path.resolve('.'),{driverRoot,dashboardRoot}),/SCHEMA_TOO_NEW.*99.*20/);
  assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:root,schemaRoot:path.resolve('skills'),driverRoot,dashboardRoot}),/SCHEMA_TOO_NEW.*99.*20/);
  assert.deepEqual(fs.readFileSync(source),before);
});

test('Dashboard rehearsal migrates only its private copy and preserves the pragma', {skip:!Database},t=>{
  const {root,source,database,driverRoot,dashboardRoot}=fixture(t);database().close();const before=fs.readFileSync(source);
  const probe=probeCoreDbVersions(root,path.resolve('.'),{driverRoot,dashboardRoot});
  assert.deepEqual(probe.databases[3],{source:'components/dashboard/dashboard.db',status:'present',fromVersion:12,toVersion:20,needsMigration:true});
  const result=rehearseCoreDbUpgrade(root,path.resolve('.'),{driverRoot,dashboardRoot});
  assert.equal(result.databases[3].fromVersion,12);assert.equal(result.databases[3].toVersion,20);
  assert.deepEqual(fs.readFileSync(source),before);
});

test('version probe loads the downloaded Dashboard owner and rejects an unavailable target owner',{skip:!Database},t=>{
  const {root,source,database,driverRoot,dashboardRoot}=fixture(t);
  database().close();const before=fs.readFileSync(source);
  const target=path.join(root,'download');fs.mkdirSync(path.join(target,'skills'),{recursive:true});
  for(const name of ['comm-bridge','scheduler','web-console']) fs.symlinkSync(path.resolve('skills',name),path.join(target,'skills',name));
  fs.cpSync(dashboardRoot,path.join(target,'skills/dashboard'),{recursive:true});
  const probe=probeCoreDbVersions(root,target,{driverRoot});
  assert.deepEqual(probe.databases[3],{source:'components/dashboard/dashboard.db',status:'present',fromVersion:12,toVersion:20,needsMigration:true});
  fs.renameSync(path.join(target,'skills/dashboard'),path.join(target,'skills/unavailable'));
  assert.throws(()=>probeCoreDbVersions(root,target,{driverRoot}),/Incompatible owner schema code dashboard/);
  assert.deepEqual(fs.readFileSync(source),before);
});

test('Dashboard creation capability is checked without creating a missing database',{skip:!Database},t=>{
  const {root,source,driverRoot,dashboardRoot}=fixture(t);
  const file=path.join(dashboardRoot,'src/lib/schema-owner.js');
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('supportsNewDatabase(){return true;}','supportsNewDatabase(){return false;}'));
  assert.throws(()=>probeCoreDbVersions(root,path.resolve('.'),{driverRoot,dashboardRoot}),/cannot initialize missing database/);
  assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:root,schemaRoot:path.resolve('skills'),driverRoot,dashboardRoot}),/cannot initialize missing database/);
  assert.equal(fs.existsSync(source),false);
});

test('Dashboard compatibility checks reject its unavailable native driver without borrowing Core dependencies',{skip:!Database},t=>{
  const {root,source,database,driverRoot,dashboardRoot}=fixture(t);
  database().close();const before=fs.readFileSync(source);
  fs.unlinkSync(path.join(dashboardRoot,'node_modules'));
  assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:root,schemaRoot:path.resolve('skills'),driverRoot,dashboardRoot}),/better-sqlite3/);
  const tx=path.join(root,'transaction');fs.mkdirSync(tx);
  assert.throws(()=>prepareRecoveryDependencies(tx,root,{dashboardRoot}),/better-sqlite3/);
  assert.deepEqual(fs.readFileSync(source),before);
});

test('real P12 owner migrates rehearsal copies and survives freezing without its source package',{
  skip:!Database || !process.env.P12_OWNER_DIR,
},async t=>{
  const {root,source,driverRoot,dashboardRoot}=fixture(t);
  for(const name of ['schema-owner.js','schema.js']) fs.copyFileSync(path.join(process.env.P12_OWNER_DIR,'src/lib',name),path.join(dashboardRoot,'src/lib',name));
  fs.unlinkSync(path.join(dashboardRoot,'node_modules'));
  fs.symlinkSync(path.join(process.env.P12_OWNER_DIR,'node_modules'),path.join(dashboardRoot,'node_modules'));
  const {dashboardSchemaOwner:owner}=await import(pathToFileURL(path.join(dashboardRoot,'src/lib/schema-owner.js')));
  assert.equal(owner.inspectSchema(source).targetVersion,20);
  assert.equal(fs.existsSync(source),false);
  owner.migrate(source);
  const db=new Database(source);
  db.exec('DROP INDEX idx_events_group_seq; ALTER TABLE runtime_events DROP COLUMN run_id; ALTER TABLE runtime_events DROP COLUMN session_group; DELETE FROM schema_migrations WHERE version=20');
  db.close();
  const before=fs.readFileSync(source);
  assert.equal(probeCoreDbVersions(root,path.resolve('.'),{driverRoot,dashboardRoot}).databases[3].fromVersion,13);
  assert.equal(rehearseCoreDbUpgrade(root,path.resolve('.'),{driverRoot,dashboardRoot}).databases[3].toVersion,20);
  assert.deepEqual(fs.readFileSync(source),before);
  const tx=path.join(root,'transaction');fs.mkdirSync(tx);
  const closure=prepareRecoveryDependencies(tx,root,{dashboardRoot});
  fs.renameSync(dashboardRoot,dashboardRoot+'-unavailable');
  const frozen=runCoreDbWorker({action:'offline-preflight',zylosDir:root,schemaRoot:path.resolve('skills'),driverRoot,formatVersion:2,driverPath:closure.driverPath},{workerPath:closure.workerPath});
  assert.equal(frozen.databases[3].status,'present');
  assert.deepEqual(fs.readFileSync(source),before);
  const future=new Database(source);future.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(99);future.close();
  assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:root,schemaRoot:path.resolve('skills'),driverRoot,formatVersion:2,driverPath:closure.driverPath},{workerPath:closure.workerPath}),/SCHEMA_TOO_NEW/);
});

test('Dashboard backup API failure does not publish a complete group',{skip:!Database},t=>{
  const {root,source,database}=fixture(t);database().close();const before=fs.readFileSync(source);
  const hook=path.join(root,'backup-failure.cjs');
  fs.writeFileSync(hook,`const Database=require(${JSON.stringify(path.join(installed,'node_modules/better-sqlite3'))});Database.prototype.backup=function(){throw Error('injected backup API failure');};`);
  const previous=process.env.NODE_OPTIONS;
  try {process.env.NODE_OPTIONS=`--require=${hook}`;assert.throws(()=>createCoreDbSnapshot({zylosDir:root,transactionId:'api-failed'}),/injected backup API failure/);}
  finally {if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;}
  assert.deepEqual(fs.readFileSync(source),before);
  const rootDir=path.join(root,'.backup/db'),staging=fs.readdirSync(rootDir).find(name=>name.startsWith('.staging-'));
  assert.equal(fs.existsSync(path.join(rootDir,'api-failed')),false);
  assert.equal(fs.existsSync(path.join(rootDir,staging,'manifest.json')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir,staging,'failure.json'))).status,'failed');
});

test('orphan Dashboard sidecars and invalid databases fail the whole snapshot with a durable failure record',{skip:!Database},t=>{
  const {root,source}=fixture(t);fs.mkdirSync(path.dirname(source),{recursive:true});
  for(const [id,prepare] of [['orphan',()=>fs.writeFileSync(source+'-wal','orphan')],['corrupt',()=>{fs.rmSync(source+'-wal');fs.writeFileSync(source,'invalid sqlite');}]]) {
    prepare();assert.throws(()=>createCoreDbSnapshot({zylosDir:root,transactionId:id}),/Orphan SQLite|not a database/);
    assert.equal(fs.existsSync(path.join(root,'.backup/db',id)),false);
  }
  const dirs=fs.readdirSync(path.join(root,'.backup/db')).filter(name=>name.startsWith('.staging-'));
  assert.equal(dirs.length,2);
  for(const dir of dirs) {assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.backup/db',dir,'failure.json'))).status,'failed');assert.equal(fs.existsSync(path.join(root,'.backup/db',dir,'manifest.json')),false);}
});
