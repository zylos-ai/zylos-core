import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {inspectUpgradeSource} from '../upgrade-entry.js';
import {createCoreDbSnapshot,runCoreDbWorker,validateSnapshotManifest,probeCoreDbVersions,rehearseCoreDbUpgrade,prepareRecoveryDependencies,inspectDashboardOwnerManaged} from '../core-db-backup.js';

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

for(const bundled of [false,true])for(const version of [13,20,99]) test(`real T09 owner selection bundled=${bundled} schema=${version}`,t=>{
  const f=fixture(t);f.database(version).close();
  const installedRoot=path.join(f.root,'installed');fs.mkdirSync(installedRoot);
  if(bundled)fs.mkdirSync(path.join(installedRoot,'skills/dashboard'),{recursive:true});
  fs.writeFileSync(path.join(installedRoot,'package.json'),JSON.stringify({name:'zylos',version:'0.9.4'}));
  fs.writeFileSync(path.join(f.target,'package.json'),JSON.stringify({name:'zylos',version:'1.0.0'}));
  const input={schemaVersion:1,fromVersion:'0.9.4',installedRoot,tempDir:f.target,zylosDir:f.root};
  const before=fs.readFileSync(f.source);
  if(version===99) assert.throws(()=>inspectUpgradeSource(input),/SCHEMA_TOO_NEW.*99.*20/);
  else {
    const state=inspectUpgradeSource(input);
    assert.equal(state.firstTakeover,!bundled);
    assert.equal(state.dashboardOwnerManaged,version>=20);
    assert.equal(state.databaseVersions.databases.length,version>=20?4:3);
  }
  assert.deepEqual(fs.readFileSync(f.source),before);
  assert.equal(fs.existsSync(path.join(f.root,'.backup/self-upgrade')),false);
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

test('unmanaged Dashboard skips owner actions but still snapshots its bytes',t=>{
  const {root,target,dashboardRoot,source,database,driverRoot,payload}=fixture(t);database(13).close();const before=fs.readFileSync(source);
  fs.rmSync(dashboardRoot,{recursive:true});
  assert.equal(probeCoreDbVersions(root,target,{driverRoot,dashboardOwnerManaged:false}).databases.length,3);
  assert.equal(rehearseCoreDbUpgrade(root,target,{driverRoot,dashboardOwnerManaged:false}).databases.length,3);
  assert.equal(runCoreDbWorker({...payload,action:'offline-preflight',dashboardOwnerManaged:false}).databases[3].ownerSkipped,true);
  assert.equal(createCoreDbSnapshot({zylosDir:root,transactionId:'takeover'}).manifest.databases[3].status,'backed_up');
  assert.deepEqual(fs.readFileSync(source),before);
  assert.throws(()=>runCoreDbWorker({...payload,action:'ordinary-migrate'}),/Unknown action/);
  assert.throws(()=>runCoreDbWorker({...payload,action:'upgrade-migrate'}),/requires transaction identity/);
});

test('first takeover rejects corrupt Dashboard bytes even without an owner',t=>{
  const {source,payload}=fixture(t);fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,'invalid sqlite');
  assert.throws(()=>runCoreDbWorker({...payload,action:'offline-preflight',dashboardOwnerManaged:false}),/not a database/);
});

test('standalone restored Dashboard is hash checked during first takeover',t=>{
  const {root,source,database,payload}=fixture(t);database().close();
  const snapshot=createCoreDbSnapshot({zylosDir:root,transactionId:'restore'});
  fs.copyFileSync(path.join(snapshot.dbBackupDir,'dashboard.db'),source);
  const request={...payload,action:'offline-preflight',manifest:snapshot.manifest,dashboardOwnerManaged:false};
  assert.equal(runCoreDbWorker(request).databases[3].status,'present');
  const db=new Database(source);db.exec("INSERT INTO events VALUES ('changed')");db.close();
  assert.throws(()=>runCoreDbWorker(request),/hash mismatch/);
});

test('missing Dashboard stays absent through version inspection, rehearsal and data-ready checks',t=>{
  const {root,target,source,driverRoot,payload}=fixture(t);
  assert.equal(probeCoreDbVersions(root,target,{driverRoot}).databases[3].status,'missing');
  assert.equal(rehearseCoreDbUpgrade(root,target,{driverRoot}).databases[3].status,'missing');
  assert.equal(runCoreDbWorker({...payload,action:'offline-preflight'}).databases[3].status,'missing');
  assert.equal(fs.existsSync(source),false);
  const snapshot=createCoreDbSnapshot({zylosDir:root,transactionId:'missing-preserved'});
  assert.equal(runCoreDbWorker({...payload,action:'offline-preflight',manifest:snapshot.manifest}).databases[3].status,'missing');
  fs.mkdirSync(path.dirname(source),{recursive:true});fs.writeFileSync(source,'unexpected database');
  assert.throws(()=>runCoreDbWorker({...payload,action:'offline-preflight',manifest:snapshot.manifest}),/Expected missing database exists/);
});

function controlledMigration(t, dashboardOwnerManaged) {
  const f=fixture(t),{root,schemaRoot,driverRoot}=f;
  for(const name of ['comm-bridge','scheduler','web-console','dashboard'])fs.cpSync(path.join(schemaRoot,name),path.join(driverRoot,name),{recursive:true,dereference:true,filter:file=>!file.split(path.sep).includes('node_modules')});
  const snapshot=createCoreDbSnapshot({zylosDir:root,transactionId:'deferred-dashboard'});
  const m=createRequire(import.meta.url)('../upgrade-maintenance.cjs');
  const transactionDir=path.join(root,'.backup/self-upgrade/deferred-dashboard'),digest='a'.repeat(64);
  fs.mkdirSync(transactionDir,{recursive:true,mode:0o700});fs.mkdirSync(path.join(root,'.zylos/upgrade'),{recursive:true,mode:0o700});
  fs.copyFileSync(path.resolve('cli/lib/upgrade-maintenance.cjs'),path.join(root,'.zylos/upgrade/maintenance.cjs'));fs.chmodSync(path.join(root,'.zylos/upgrade/maintenance.cjs'),0o600);
  const j={formatVersion:1,from:'0.9.4',firstTakeover:false,dashboardOwnerManaged,transactionId:'deferred-dashboard',zylosDir:root,skillsDir:driverRoot,phase:'installing',installationIntent:true,nodePath:process.execPath,
    dbBackupDir:snapshot.dbBackupDir,snapshotManifestHash:m.hash(path.join(snapshot.dbBackupDir,'manifest.json')),originalServices:[],coreManifest:[{name:'comm-bridge',existedBefore:true,backedUp:true,originalHash:digest}],
    initialIdentity:{nodePath:process.execPath,cliRoot:path.join(root,'package/cli'),cliHash:digest,packageJson:path.join(root,'package/package.json'),packageHash:digest,workerPath:path.join(root,'package/cli/lib/core-db-backup-worker.js'),workerHash:digest,ecosystemHash:null,databases:m.databasePaths(2).map(source=>({source,exists:false}))}};
  m.durable(path.join(transactionDir,'journal.json'),j);m.marker(root,transactionDir,j);
  return {...f, request:{action:'upgrade-migrate',zylosDir:root,schemaRoot:driverRoot,transactionDir,transactionId:j.transactionId}};
}

test('controlled upgrade leaves missing Dashboard creation to its first ordinary open',t=>{
  const {root,source,driverRoot,request}=controlledMigration(t,true);
  const result=runCoreDbWorker(request);
  assert.equal(result.databases[3].status,'missing');assert.equal(result.databases[3].ownerSkipped,undefined);
  assert.equal(fs.existsSync(source),false);
  assert.equal(runCoreDbWorker({action:'offline-preflight',zylosDir:root,schemaRoot:driverRoot,requireCurrent:true}).databases[3].status,'missing');
  assert.equal(fs.existsSync(source),false);
});

for(const managed of [false,true]) test(`controlled migration uses persisted Dashboard owner state ${managed} despite caller disagreement`,t=>{
  const {source,database,driverRoot,request}=controlledMigration(t,managed);
  database(13).close();
  const before=fs.readFileSync(source);
  const owner=path.join(driverRoot,'dashboard/src/lib/schema-owner.js');
  const calls=path.join(driverRoot,'dashboard/migration-calls');
  fs.appendFileSync(owner,`\nimport fs from 'node:fs';\nconst migrate=dashboardSchemaOwner.migrate;dashboardSchemaOwner.migrate=db=>{fs.appendFileSync(${JSON.stringify(calls)},'migrate\\n');return migrate(db);};\n`);
  const result=runCoreDbWorker({...request,dashboardOwnerManaged:!managed});
  const row=result.databases.find(item=>item.source==='components/dashboard/dashboard.db');
  const db=new Database(source,{readonly:true,fileMustExist:true});
  try {assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,managed?20:13);}
  finally {db.close();}
  assert.equal(row.ownerSkipped,managed?undefined:true);
  assert.equal(fs.existsSync(calls),managed);
  if(managed)assert.equal(fs.readFileSync(calls,'utf8'),'migrate\n');
  else assert.deepEqual(fs.readFileSync(source),before);
});

test('missing Dashboard never loads its owner or creates a database before cutoff',t=>{
  const {root,target,source,driverRoot,dashboardRoot,payload}=fixture(t);
  fs.writeFileSync(path.join(dashboardRoot,'src/lib/schema-owner.js'),`throw Error('missing Dashboard must not load owner');`);
  assert.equal(probeCoreDbVersions(root,target,{driverRoot}).databases[3].status,'missing');
  assert.equal(rehearseCoreDbUpgrade(root,target,{driverRoot}).databases[3].status,'missing');
  assert.equal(runCoreDbWorker({...payload,action:'offline-preflight'}).databases[3].status,'missing');
  assert.equal(fs.existsSync(source),false);
});

for(const version of [0,13,19,20,21,99]) test(`Dashboard management uses schema_migrations ${version}, not user_version`,t=>{
  const {root,source,database,driverRoot}=fixture(t);database(version).close();
  const before=fs.readFileSync(source);
  assert.equal(inspectDashboardOwnerManaged(root,{driverRoot}),version>=20);
  assert.deepEqual(fs.readFileSync(source),before);
});

test('Dashboard management handles absent database/table and rejects corrupt bytes',t=>{
  const {root,source,driverRoot}=fixture(t);
  assert.equal(inspectDashboardOwnerManaged(root,{driverRoot}),false);
  assert.equal(fs.existsSync(source),false);
  fs.mkdirSync(path.dirname(source),{recursive:true});
  const db=new Database(source);db.exec('PRAGMA user_version=99');db.close();
  assert.equal(inspectDashboardOwnerManaged(root,{driverRoot}),false);
  fs.writeFileSync(source,'invalid sqlite');
  assert.throws(()=>inspectDashboardOwnerManaged(root,{driverRoot}),/not a database/);
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
