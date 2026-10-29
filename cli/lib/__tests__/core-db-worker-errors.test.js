import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {LEGACY_CORE_DATABASES,runCoreDbWorker} from '../core-db-backup.js';
import {migrateDatabase} from '../../../skills/comm-bridge/scripts/sqlite-schema.js';

const installed=process.env.CORE_DB_TEST_SKILL || path.resolve('skills/comm-bridge');
const Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');
const worker=path.resolve('cli/lib/core-db-backup-worker.js');

function fixture(t, failingOwner) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'worker-errors-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const schemaRoot=path.join(root,'schemas');
  fs.mkdirSync(schemaRoot);
  for(const item of LEGACY_CORE_DATABASES) {
    const owner=path.join(schemaRoot,item.owner);
    if(item.owner!==failingOwner) {
      fs.symlinkSync(path.resolve('skills',item.owner),owner);
      continue;
    }
    fs.mkdirSync(path.join(owner,'scripts'),{recursive:true});
    fs.writeFileSync(path.join(owner,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(owner,item.schema),`
      import * as actual from ${JSON.stringify(pathToFileURL(path.resolve('skills',item.owner,item.schema)).href)};
      export * from ${JSON.stringify(pathToFileURL(path.resolve('skills',item.owner,item.schema)).href)};
      export const MIGRATIONS={...actual.MIGRATIONS,0:{to:1,migrate(){throw Object.assign(Error('fixture migration failed at '+import.meta.url+'\\n at private source'),{code:'SQLITE_ERROR'});}}};
    `);
    if(item.owner==='comm-bridge') fs.symlinkSync(path.resolve('skills/comm-bridge/scripts/sqlite-schema.js'),path.join(owner,'scripts/sqlite-schema.js'));
  }
  const dashboard=path.join(schemaRoot,'dashboard/src/lib');
  fs.mkdirSync(dashboard,{recursive:true});
  fs.writeFileSync(path.join(schemaRoot,'dashboard/package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(dashboard,'schema-owner.js'),`
    export const dashboardSchemaOwner={
      inspectSchema(db){const currentVersion=db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;return {currentVersion,targetVersion:20,needsMigration:currentVersion!==20};},
      migrate(){throw Object.assign(Error('fixture migration failed at '+import.meta.url+'\\n at private source'),{code:'SQLITE_ERROR'});}
    };
  `);
  const driverRoot=path.resolve('skills');
  return {root,schemaRoot,payload:{zylosDir:root,schemaRoot,driverRoot,formatVersion:2}};
}

function assertFailure(error, code) {
  assert.equal(error.code,code);
  assert.doesNotMatch(error.message,/\n|file:\/\/|\/home\/| at private source/);
  return true;
}

test('migration engine gives uncoded callback failures a structured migration code and rolls back',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());
  const owner={SUPPORTED_SCHEMA_VERSION:1,inspectSchema:()=>({version:0,empty:true}),
    MIGRATIONS:{0:{to:1,migrate(database){database.exec('CREATE TABLE partial(value TEXT)');throw Error('uncoded callback failure');}}}};
  assert.throws(()=>migrateDatabase(db,owner,{allowNew:true}),error=>{
    assert.equal(error.code,'SCHEMA_MIGRATION_FAILED');
    assert.equal(error.message,'uncoded callback failure');
    return true;
  });
  assert.equal(db.inTransaction,false);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(),undefined);
});

for(const item of LEGACY_CORE_DATABASES) test(`${item.owner} version probe itself classifies future owner version`,t=>{
  const {root,payload,schemaRoot}=fixture(t,item.owner);
  fs.writeFileSync(path.join(schemaRoot,item.owner,item.schema),`
    export const SUPPORTED_SCHEMA_VERSION=1,supportsNewDatabase=true,TABLES={};
    export function inspectSchema(){return {version:2,empty:false,extensions:{tables:[],columns:[]}};}
  `);
  const file=path.join(root,item.source);fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);db.close();
  assert.throws(()=>runCoreDbWorker({...payload,action:'version-probe'}),error=>{
    assert.match(error.message,/schema version 2 exceeds supported 1/);
    return assertFailure(error,'SCHEMA_TOO_NEW');
  });
});

for(const item of LEGACY_CORE_DATABASES) test(`${item.owner} worker inspection preserves schema rejection and successful reads`,t=>{
  const {root,payload}=fixture(t);
  assert.equal(runCoreDbWorker({...payload,action:'version-probe'}).databases.length,4);
  const file=path.join(root,item.source);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);db.pragma('user_version=999');db.close();
  const before=fs.readFileSync(file);
  for(const action of ['version-probe','offline-preflight','rehearse']) {
    const rehearsalDir=path.join(root,'rehearsal-'+action);
    if(action==='rehearse')fs.mkdirSync(rehearsalDir);
    assert.throws(()=>runCoreDbWorker({...payload,action,rehearsalDir}),error=>assertFailure(error,'SCHEMA_TOO_NEW'));
  }
  assert.deepEqual(fs.readFileSync(file),before);
});

for(const owner of ['comm-bridge','scheduler','web-console','dashboard']) test(`${owner} rehearsal returns a structured migration failure without source details`,t=>{
  const {root,payload}=fixture(t,owner);
  if(owner==='dashboard') {
    const file=path.join(root,'components/dashboard/dashboard.db');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const db=new Database(file);db.exec('CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(19)');db.close();
  }
  const rehearsalDir=path.join(root,'rehearsal');fs.mkdirSync(rehearsalDir);
  assert.throws(()=>runCoreDbWorker({...payload,action:'rehearse',rehearsalDir}),error=>{
    assert.match(error.message,/fixture migration failed/);
    assert.ok(!error.message.includes(root));
    return assertFailure(error,'SCHEMA_MIGRATION_FAILED');
  });
});

test('worker subprocess emits a structured error on stdout without a stack on stderr',t=>{
  const {payload}=fixture(t);
  const child=spawnSync(process.execPath,[worker,JSON.stringify({...payload,action:'unknown-action'})],{encoding:'utf8'});
  assert.equal(child.status,1);
  assert.equal(child.stderr,'');
  const result=JSON.parse(child.stdout);
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'UPGRADE_FAILED');
  assert.match(result.error.message,/Unknown action/);
  assert.deepEqual(Object.keys(result.error).sort(),['code','message']);
});
