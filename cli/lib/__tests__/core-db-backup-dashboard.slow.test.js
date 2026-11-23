// covers: skills/dashboard/src/lib/store.js skills/dashboard/src/lib/schema.js cli/lib/upgrade-entry.js cli/lib/core-db-backup.js cli/lib/core-db-backup-worker.js skills/dashboard/src/lib/schema-owner.js skills/dashboard/__tests__/fixtures/dashboard-history.js skills/dashboard/__tests__/fixtures/schema13.js skills/dashboard/__tests__/helpers/explicit-migration.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {legacy as dashboardSchema13} from '../../../skills/dashboard/__tests__/fixtures/dashboard-history.js';
import {Store} from '../../../skills/dashboard/src/lib/store.js';
import {TARGET_SCHEMA_VERSION} from '../../../skills/dashboard/src/lib/schema.js';
import {createCoreDbSnapshot,runCoreDbWorker,validateSnapshotManifest,probeCoreDbVersions,rehearseCoreDbUpgrade,inspectDashboardOwnerManaged,inspectCoreManagesDashboardDb} from '../core-db-backup.js';

const installed=process.env.CORE_DB_TEST_SKILL || path.resolve('skills/comm-bridge');
const Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t, {targetVersion=20,realDashboard=false}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-snapshot-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const driverRoot=path.join(root,'.claude/skills');
  fs.mkdirSync(path.join(driverRoot,'comm-bridge'),{recursive:true});
  fs.writeFileSync(path.join(driverRoot,'comm-bridge/package.json'),'{}');
  fs.symlinkSync(path.join(installed,'node_modules'),path.join(driverRoot,'comm-bridge/node_modules'));
  const target=path.join(root,'target'),schemaRoot=path.join(target,'skills');
  fs.mkdirSync(schemaRoot,{recursive:true});
  for(const name of ['comm-bridge','scheduler']) fs.symlinkSync(path.resolve('skills',name),path.join(schemaRoot,name));
  fs.mkdirSync(path.join(target,'cli/lib'),{recursive:true});
  fs.symlinkSync(path.resolve('cli/lib/core-db-backup-worker.js'),path.join(target,'cli/lib/core-db-backup-worker.js'));
  const dashboardRoot=path.join(schemaRoot,'dashboard');fs.mkdirSync(path.join(dashboardRoot,'src/lib'),{recursive:true});
  fs.writeFileSync(path.join(dashboardRoot,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(dashboardRoot,'index.js'),`throw Error('service entry must not load');`);
  // Pure owner deliberately has no driver dependency or node_modules.
  if(realDashboard)fs.writeFileSync(path.join(dashboardRoot,'src/lib/schema-owner.js'),`export {dashboardSchemaOwner} from ${JSON.stringify(pathToFileURL(path.resolve('skills/dashboard/src/lib/schema-owner.js')).href)};\n`);
  else fs.writeFileSync(path.join(dashboardRoot,'src/lib/schema-owner.js'),`
    export const dashboardSchemaOwner={
      inspectSchema(db){
        if(typeof db.prepare!=='function')throw Error('owner requires an open handle');
        const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
        const currentVersion=exists?db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version:null;
        return {currentVersion,targetVersion:${targetVersion},needsMigration:currentVersion!==${targetVersion}};
      },
      migrate(db){db.transaction(()=>{db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)');db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?)').run(${targetVersion});})();}
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

test('new snapshots contain current databases and released formats remain readable',t=>{
  const {root}=fixture(t);
  fs.mkdirSync(path.join(root,'web-console'));
  const historical=path.join(root,'web-console/web-console.db');
  fs.writeFileSync(historical,'historical bytes must not be opened');
  fs.writeFileSync(historical+'-wal','historical WAL must not be opened');
  const current=createCoreDbSnapshot({zylosDir:root,transactionId:'current'});
  assert.equal(current.manifest.formatVersion,3);assert.equal(current.manifest.databases.length,3);
  assert.equal(fs.readFileSync(historical,'utf8'),'historical bytes must not be opened');
  assert.equal(fs.existsSync(path.join(current.dbBackupDir,'web-console.db')),false);
  assert.equal(current.manifest.databases[2].source,'components/dashboard/dashboard.db');
  const verify=manifest=>runCoreDbWorker({action:'verify',zylosDir:root,dbBackupDir:current.dbBackupDir,manifest});
  assert.equal(verify(current.manifest).databases.length,3);
  const missingWeb={source:'web-console/web-console.db',status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null};
  const legacyRows=[...current.manifest.databases.slice(0,2),missingWeb];
  for(const formatVersion of [1,2]) {
    const databases=formatVersion===1?legacyRows:[...legacyRows,current.manifest.databases[2]];
    assert.equal(verify({...current.manifest,formatVersion,databases}).databases.length,databases.length);
    assert.equal(verify({...current.manifest,formatVersion:undefined,databases}).databases.length,databases.length);
  }
  assert.equal(verify({...current.manifest,formatVersion:undefined}).databases.length,3);
  assert.throws(()=>verify({...current.manifest,databases:legacyRows}),/Invalid database collection/);
  assert.throws(()=>verify({...current.manifest,formatVersion:undefined,databases:[...legacyRows.slice(0,2),legacyRows[0]]}),/Invalid database collection/);
  assert.throws(()=>validateSnapshotManifest({...current.manifest,formatVersion:4}),/Unsupported/);
  for(const formatVersion of [1,2]) {
    assert.throws(()=>createCoreDbSnapshot({zylosDir:root,transactionId:'legacy',formatVersion}),/require formatVersion 3/);
    assert.throws(()=>runCoreDbWorker({action:'snapshot',zylosDir:root,formatVersion}),/require formatVersion 3/);
  }
});

test('Dashboard owner version rejects future schemas without writing the database',t=>{
  const {root,target,source,database,driverRoot,payload}=fixture(t);database(99).close();const before=fs.readFileSync(source);
  for(const run of [()=>probeCoreDbVersions(root,target,{driverRoot}),()=>runCoreDbWorker({...payload,action:'offline-preflight'})]) assert.throws(run,error=>{
    assert.equal(error.code,'SCHEMA_TOO_NEW');
    assert.match(error.message,/SCHEMA_TOO_NEW.*99.*20/);
    assert.doesNotMatch(error.message,/\n|\/home\/|file:\/\//);
    return true;
  });
  assert.deepEqual(fs.readFileSync(source),before);
});

function controlledMigration(t, dashboardOwnerManaged, options) {
  const f=fixture(t, options),{root,schemaRoot,driverRoot}=f;
  options?.prepare?.(f);
  for(const name of ['comm-bridge','scheduler','dashboard'])fs.cpSync(path.join(schemaRoot,name),path.join(driverRoot,name),{recursive:true,dereference:true,filter:file=>!file.split(path.sep).includes('node_modules')});
  const snapshot=createCoreDbSnapshot({zylosDir:root,transactionId:'deferred-dashboard'});
  const m=createRequire(import.meta.url)('../upgrade-maintenance.cjs');
  const transactionDir=path.join(root,'.backup/self-upgrade/deferred-dashboard'),digest='a'.repeat(64);
  fs.mkdirSync(transactionDir,{recursive:true,mode:0o700});fs.mkdirSync(path.join(root,'.zylos/upgrade'),{recursive:true,mode:0o700});
  fs.copyFileSync(path.resolve('cli/lib/upgrade-maintenance.cjs'),path.join(root,'.zylos/upgrade/maintenance.cjs'));fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/remove-owned-tree.js'),path.join(path.dirname(path.join(root,'.zylos/upgrade/maintenance.cjs')),'remove-owned-tree.mjs'));fs.chmodSync(path.join(root,'.zylos/upgrade/maintenance.cjs'),0o600);
  const j={formatVersion:1,from:'0.9.4',firstTakeover:false,dashboardOwnerManaged,transactionId:'deferred-dashboard',zylosDir:root,skillsDir:driverRoot,phase:'installing',installationIntent:true,nodePath:process.execPath,
    dbBackupDir:snapshot.dbBackupDir,snapshotManifestHash:m.hash(path.join(snapshot.dbBackupDir,'manifest.json')),originalServices:[],coreManifest:[{name:'comm-bridge',existedBefore:true,backedUp:true,originalHash:digest}],
    initialIdentity:{nodePath:process.execPath,cliRoot:path.join(root,'package/cli'),cliHash:digest,packageJson:path.join(root,'package/package.json'),packageHash:digest,workerPath:path.join(root,'package/cli/lib/core-db-backup-worker.js'),workerHash:digest,ecosystemHash:null,databases:m.databasePaths(2).map(source=>({source,exists:false}))}};
  m.durable(path.join(transactionDir,'journal.json'),j);m.marker(root,transactionDir,j);
  return {...f, request:{action:'upgrade-migrate',zylosDir:root,schemaRoot:driverRoot,transactionDir,transactionId:j.transactionId}};
}

// A first takeover that could not migrate the standalone database leaves it at
// 13 under a Core that ships Dashboard. It is Core's from then on: the probe,
// rehearsal, snapshot, worker migration and readback carry it to the latest
// version with the real Dashboard owner, as a same-version upgrade does.
test('a Dashboard database left at 13 after the takeover goes through the protected migration to the latest version',t=>{
  const f=controlledMigration(t,true,{realDashboard:true,prepare:({source})=>{fs.mkdirSync(path.dirname(source),{recursive:true});dashboardSchema13(source);}});
  const {root,target,source,driverRoot,request}=f;
  const installedRoot=path.join(root,'installed');fs.mkdirSync(path.join(installedRoot,'skills/dashboard'),{recursive:true});
  const managed=inspectCoreManagesDashboardDb(root,installedRoot,{driverRoot});
  assert.equal(managed,true);
  const before=hash(source);
  const probe=probeCoreDbVersions(root,target,{driverRoot,dashboardOwnerManaged:managed});
  const row=probe.databases.find(item=>item.source==='components/dashboard/dashboard.db');
  assert.deepEqual(row,{source:'components/dashboard/dashboard.db',status:'present',fromVersion:13,toVersion:TARGET_SCHEMA_VERSION,needsMigration:true});
  assert.equal(probe.needsMigration,true);
  const rehearsal=rehearseCoreDbUpgrade(root,target,{driverRoot,dashboardOwnerManaged:managed}).databases.find(item=>item.source==='components/dashboard/dashboard.db');
  assert.equal(rehearsal.toVersion,TARGET_SCHEMA_VERSION);
  assert.equal(hash(source),before,'probe and rehearsal leave the live database alone');
  const migrated=runCoreDbWorker(request).databases.find(item=>item.source==='components/dashboard/dashboard.db');
  const readback=runCoreDbWorker({action:'offline-preflight',zylosDir:root,schemaRoot:driverRoot,requireCurrent:true,dashboardOwnerManaged:true}).databases.find(item=>item.source==='components/dashboard/dashboard.db');
  t.diagnostic(JSON.stringify({managed,probe:row,rehearsal,migrated,readback}));
  assert.equal(readback.status,'present');
  const snapshot=JSON.parse(fs.readFileSync(path.join(root,'.backup/db/deferred-dashboard/manifest.json'),'utf8')).databases.find(item=>item.source==='components/dashboard/dashboard.db');
  const copy=new Database(path.join(root,'.backup/db/deferred-dashboard',snapshot.file),{readonly:true});
  try {assert.equal(copy.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,13,'the snapshot keeps the version-13 database');}
  finally {copy.close();}
  const store=new Store(source);
  try {
    assert.equal(store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,TARGET_SCHEMA_VERSION);
    assert.equal(store.db.prepare("SELECT id FROM runtime_events WHERE id='old'").get().id,'old');
    assert.equal(store.db.prepare("SELECT token_hash FROM auth_sessions").get().token_hash,'retained');
  } finally {store.close();}
});

for(const version of [0,13,19,20,21,22,99]) test(`Dashboard management uses schema_migrations ${version}, not user_version`,t=>{
  const {root,source,database,driverRoot}=fixture(t);database(version).close();
  const before=fs.readFileSync(source);
  assert.equal(inspectDashboardOwnerManaged(root,{driverRoot}),version>=20);
  assert.deepEqual(fs.readFileSync(source),before);
});
