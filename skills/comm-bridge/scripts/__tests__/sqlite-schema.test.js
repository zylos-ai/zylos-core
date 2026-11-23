import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDatabase as registeredGuardDatabase, preflightDatabase, assertCoreDatabaseAvailable, migrateDatabase } from '../sqlite-schema.js';
import * as c4 from '../c4-schema.js';
import * as scheduler from '../../../scheduler/scripts/schema.js';
// Existing fault/concurrency probes replace the registered 0→1 callback.
const withProbe = owner => owner.migrate ? { ...owner, MIGRATIONS: { ...owner.MIGRATIONS, 0: { ...owner.MIGRATIONS[0], migrate: owner.migrate } } } : owner;
function guardDatabase(db, owner, options) {
  return registeredGuardDatabase(db, withProbe(owner), options);
}
// Existing layouts are migrated only by the explicit upgrade path, with the
// options ordinary openers used before they became check-only.
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const sql = fs.readFileSync(new URL('../../init-db.sql', import.meta.url), 'utf8');
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'core-schema-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root; }
function run(root, code) {
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:repo,env:{...process.env,ZYLOS_DIR:root},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);return child.stdout;
}
test('actual deployed owner openers initialize and reopen known schemas without duplicate migrations',t=>{
 const root=fixture(t);
 run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';getDb();close();getDb();close();scheduler().close();`);
 for(const [dir,name,owner] of [['comm-bridge','c4',c4],['scheduler','scheduler',scheduler]]){
  const db=new Database(path.join(root,dir,name+'.db'),{readonly:true}); assert.equal(owner.inspectSchema(db).version,owner.SUPPORTED_SCHEMA_VERSION);db.close();
 }
 const db=new Database(path.join(root,'comm-bridge/c4.db'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n,1);db.close();
});
test('future versions are rejected before write pragmas and migration',t=>{
 const root=fixture(t),file=path.join(root,'future.db');const db=new Database(file);db.exec(sql);db.pragma(`user_version=${c4.SUPPORTED_SCHEMA_VERSION+1}`);db.close();const before=fs.readFileSync(file);
 const actual=new Database(file);assert.throws(()=>guardDatabase(actual,{...c4,migrate(){assert.fail('migration');}}),new RegExp(`version ${c4.SUPPORTED_SCHEMA_VERSION+1}`));actual.close();assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(file+'-wal'),false);
});
test('maintenance and malformed discovery blocks normal openers without initializing',t=>{
 const root=fixture(t);const dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(root,'.zylos/upgrade'),{recursive:true});fs.writeFileSync(path.join(root,'.zylos/upgrade/active.json'),'{}');fs.writeFileSync(path.join(dir,'journal.json'),JSON.stringify({formatVersion:1,transactionId:'tx',phase:'restoring'}));assert.throws(()=>assertCoreDatabaseAvailable(root),/unavailable/);
 fs.writeFileSync(path.join(dir,'journal.json'),'{');assert.throws(()=>assertCoreDatabaseAvailable(root));
});

function childModule(root, code) {
 const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:repo,env:{...process.env,ZYLOS_DIR:root},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 const done=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal,stderr})));
 return {child,done};
}
async function waitFile(file) {
 const deadline=Date.now()+5000;
 while(!fs.existsSync(file)) { assert.ok(Date.now()<deadline,`Timed out waiting for ${file}`);await new Promise(resolve=>setTimeout(resolve,10)); }
}
test('all deployed owners recover existing zero-byte and initialized empty version-zero files',t=>{
 for(const header of [false,true]) {
  const root=fixture(t);
  for(const relative of ['comm-bridge/c4.db','scheduler/scheduler.db']) {
   const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
   if(header) {const db=new Database(file);db.exec('VACUUM');db.close();assert.ok(fs.statSync(file).size>0);} else fs.writeFileSync(file,'');
  }
  run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';getDb();close();scheduler().close();`);
  const db=new Database(path.join(root,'comm-bridge/c4.db'));assert.equal(c4.inspectSchema(db).version,c4.SUPPORTED_SCHEMA_VERSION);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n,1);db.close();
 }
});
test('two processes initialize the same existing empty database under one writer lock',async t=>{
 const root=fixture(t),file=path.join(root,'db'),firstReady=path.join(root,'first'),secondReady=path.join(root,'second'),release=path.join(root,'release'),migrations=path.join(root,'migrations');fs.writeFileSync(file,'');
 const imports=`import fs from 'node:fs';import Database from './skills/comm-bridge/node_modules/better-sqlite3/lib/index.js';import * as owner from './skills/comm-bridge/scripts/c4-schema.js';import {guardDatabase as registeredGuardDatabase} from './skills/comm-bridge/scripts/sqlite-schema.js';const guardDatabase=(db,owner)=>registeredGuardDatabase(db,{...owner,MIGRATIONS:{...owner.MIGRATIONS,0:{...owner.MIGRATIONS[0],migrate:owner.migrate}}});import {migrateSchema} from './skills/comm-bridge/scripts/c4-db.js';const db=new Database(${JSON.stringify(file)});`;
 const first=childModule(root,imports+`guardDatabase(db,{...owner,migrate(connection,options){fs.writeFileSync(${JSON.stringify(firstReady)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);fs.appendFileSync(${JSON.stringify(migrations)},'1');migrateSchema(connection,options);}});db.close();`);
 t.after(()=>first.child.kill('SIGKILL'));await waitFile(firstReady);
 const second=childModule(root,imports+`let inspections=0;guardDatabase(db,{...owner,inspectSchema(connection,options){const result=owner.inspectSchema(connection,options);if(++inspections===1){if(!result.empty)throw Error('expected empty schema before lock');fs.writeFileSync(${JSON.stringify(secondReady)},'ready');}return result;},migrate(connection,options){fs.appendFileSync(${JSON.stringify(migrations)},'2');migrateSchema(connection,options);}});db.close();`);
 t.after(()=>second.child.kill('SIGKILL'));await waitFile(secondReady);fs.writeFileSync(release,'go');
 for(const result of await Promise.all([first.done,second.done]))assert.equal(result.code,0,result.stderr);
 assert.equal(fs.readFileSync(migrations,'utf8'),'1');const db=new Database(file);assert.equal(c4.inspectSchema(db).version,c4.SUPPORTED_SCHEMA_VERSION);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n,1);db.close();
});

test('ordinary owners accept additional tables and columns while upgrade inspection stays strict', t => {
 const root=fixture(t);
 const openers=`import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';`;
 run(root,openers+`getDb();close();scheduler().close();`);
 for(const [relative,owner,table] of [['comm-bridge/c4.db',c4,'checkpoints'],['scheduler/scheduler.db',scheduler,'tasks']]) {
  const db=new Database(path.join(root,relative));
  db.exec(`CREATE TABLE extension_state(value TEXT); ALTER TABLE ${table} ADD COLUMN extension_value TEXT`);
  assert.doesNotThrow(()=>guardDatabase(db,owner));
  assert.throws(()=>owner.inspectSchema(db),/unsupported columns|unsupported tables/);
  db.close();
  assert.doesNotThrow(()=>preflightDatabase(Database,path.join(root,relative),owner));
 }
 run(root,openers+`for(const db of [getDb(),scheduler()]){db.prepare('INSERT INTO extension_state VALUES (?)').run('daily-write');}close();`);
 for(const relative of ['comm-bridge/c4.db','scheduler/scheduler.db']) {
  const db=new Database(path.join(root,relative),{readonly:true});assert.equal(db.prepare('SELECT value FROM extension_state').get().value,'daily-write');db.close();
 }
});

const history=name=>fs.readFileSync(new URL(`./fixtures/migration-history/${name}`,import.meta.url),'utf8');
const digest=file=>fs.readFileSync(file).toString('base64');
for(const [label,owner,layout] of [['c4',c4,'c4-v0.9.0-v1.sql'],['scheduler',scheduler,'scheduler-v0.9.0-v1.sql']]) test(`ordinary ${label} open reports an older database without changing it; explicit migration still upgrades it`,t=>{
 const root=fixture(t),file=path.join(root,`${label}.db`);
 const seed=new Database(file);seed.exec(history(layout));assert.equal(seed.pragma('user_version',{simple:true}),1);seed.close();
 const before=digest(file);
 for(const options of [{},{readonly:true}]) {
  const db=new Database(file,options);
  assert.throws(()=>registeredGuardDatabase(db,owner),error=>{
   assert.equal(error.code,'SCHEMA_UPGRADE_REQUIRED');assert.equal(error.schemaVersion,1);assert.equal(error.supportedVersion,owner.SUPPORTED_SCHEMA_VERSION);
   assert.equal(error.message,`${file}: schema version 1 is older than supported ${owner.SUPPORTED_SCHEMA_VERSION} and was not migrated; run "zylos upgrade --self" to migrate it.`);
   return true;
  });
  assert.equal(db.inTransaction,false);db.close();
  assert.equal(digest(file),before);for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(file+suffix),false);
 }
 const explicit=new Database(file);assert.equal(migrateDatabase(explicit,owner,{strict:false}).version,owner.SUPPORTED_SCHEMA_VERSION);
 assert.equal(registeredGuardDatabase(explicit,owner).version,owner.SUPPORTED_SCHEMA_VERSION);explicit.close();
});
