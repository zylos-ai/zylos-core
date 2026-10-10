import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDatabase, preflightDatabase, assertCoreDatabaseAvailable } from '../sqlite-schema.js';
import * as c4 from '../c4-schema.js';
import * as scheduler from '../../../scheduler/scripts/schema.js';
import * as wc from '../../../web-console/scripts/schema.js';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const sql = fs.readFileSync(new URL('../../init-db.sql', import.meta.url), 'utf8');
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'core-schema-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root; }
function run(root, code) {
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:repo,env:{...process.env,ZYLOS_DIR:root},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);return child.stdout;
}
test('actual deployed owner openers initialize and reopen known schemas without duplicate migrations',t=>{
 const root=fixture(t);
 run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';import {openDb} from './skills/web-console/scripts/db.js';getDb();close();getDb();close();scheduler().close();openDb().close();`);
 for(const [dir,name,owner] of [['comm-bridge','c4',c4],['scheduler','scheduler',scheduler],['web-console','web-console',wc]]){
  const db=new Database(path.join(root,dir,name+'.db'),{readonly:true}); assert.equal(owner.inspectSchema(db).version,1);db.close();
 }
 const db=new Database(path.join(root,'comm-bridge/c4.db'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n,1);db.close();
});
test('known C4 legacy fields/backfill/retag migrate together and only once',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'comm-bridge'));
 const db=new Database(path.join(root,'comm-bridge/c4.db'));
 const legacy=sql.replace(/    delivery_action TEXT[^\n]*\n/,'').replace(/    raw_content TEXT[^\n]*\n/,'').replace(/-- C4 unhealthy[\s\S]*?-- Create initial checkpoint/,'-- Create initial checkpoint');db.exec(legacy);
 db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content) VALUES('in','web-console','session-handoff','history')").run();
 db.prepare("INSERT INTO control_queue(content,created_at,updated_at) VALUES(?,1,1)").run('work ---- ack via: node example ack --id 1');db.close();
 run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';getDb();close();`);
 const check=new Database(path.join(root,'comm-bridge/c4.db'));assert.equal(check.pragma('user_version',{simple:true}),1);assert.equal(check.prepare('SELECT raw_content FROM control_queue').get().raw_content,'work');assert.equal(check.prepare('SELECT channel FROM conversations').get().channel,'void');check.prepare("UPDATE control_queue SET raw_content=NULL").run();check.close();
 run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';getDb();close();`);
 const reopened=new Database(path.join(root,'comm-bridge/c4.db'));assert.equal(reopened.prepare('SELECT raw_content FROM control_queue').get().raw_content,null);reopened.close();
});
test('future versions are rejected before write pragmas and migration',t=>{
 const root=fixture(t),file=path.join(root,'future.db');const db=new Database(file);db.exec(sql);db.pragma('user_version=2');db.close();const before=fs.readFileSync(file);
 const actual=new Database(file);assert.throws(()=>guardDatabase(actual,{...c4,migrate(){assert.fail('migration');}}),/version 2/);actual.close();assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(file+'-wal'),false);
});
test('unknown layouts and readonly empty layouts never receive a stamp',()=>{
 const db=new Database(':memory:');assert.throws(()=>guardDatabase(db,{...wc,migrate(){assert.fail('migration');}},{readonly:true}),/missing/);db.exec('CREATE TABLE unknown(x)');assert.throws(()=>wc.inspectSchema(db),/missing/);assert.equal(db.pragma('user_version',{simple:true}),0);db.close();
});
test('failure rolls back schema, data and version; readonly inspection never migrates',()=>{
 const db=new Database(':memory:');db.exec(sql);
 assert.throws(()=>guardDatabase(db,{...c4,migrate(connection){connection.exec("CREATE TABLE rollback_test(x); UPDATE checkpoints SET summary='changed';");throw new Error('injected');}}),/injected/);
 assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='rollback_test'").get(),undefined);assert.equal(db.prepare('SELECT summary FROM checkpoints').get().summary,'initial');assert.equal(db.pragma('user_version',{simple:true}),0);
 guardDatabase(db,{...c4,migrate(){assert.fail('readonly migration');}},{readonly:true});assert.equal(db.pragma('user_version',{simple:true}),0);db.close();
});
test('lock re-read honors another initializer and rejects a newly future database',()=>{
 for(const nextVersion of [1,2]) {
  const db=new Database(':memory:');db.exec(sql);let inspected=0;let migrated=false;
  const owner={...c4,inspectSchema(connection,options){if(++inspected===2) connection.pragma(`user_version=${nextVersion}`);return c4.inspectSchema(connection,options);},migrate(){migrated=true;}};
  if(nextVersion===2)assert.throws(()=>guardDatabase(db,owner),/version 2/);else guardDatabase(db,owner);
  assert.equal(migrated,false);db.close();
 }
});
test('preflight is raw readonly, supports expected missing and rejects orphan sidecars',t=>{
 const root=fixture(t),file=path.join(root,'db');assert.deepEqual(preflightDatabase(Database,file,wc,{allowMissing:true}),{missing:true});assert.equal(fs.existsSync(file),false);
 fs.writeFileSync(file+'-wal','orphan');assert.throws(()=>preflightDatabase(Database,file,wc,{allowMissing:true}),/Orphan/);
});
test('maintenance and malformed discovery blocks normal openers without initializing',t=>{
 const root=fixture(t);const dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'journal.json'),JSON.stringify({formatVersion:1,transactionId:'tx',phase:'restoring'}));assert.throws(()=>assertCoreDatabaseAvailable(root),/unavailable/);
 fs.writeFileSync(path.join(dir,'journal.json'),'{');assert.throws(()=>assertCoreDatabaseAvailable(root));
});
for(const phase of ['new_data_ready','restored_complete','aborted_before_install'])test(`missing stable maintenance cannot trust ${phase} labels to release normal owner openers`,t=>{
 const root=fixture(t),dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'journal.json'),JSON.stringify({formatVersion:1,transactionId:'tx',phase,cleanup:{complete:true},terminalEvidence:{verified:true}}),{mode:0o600});
 assert.throws(()=>assertCoreDatabaseAvailable(root),/stable maintenance entry missing/);
 run(root, `import assert from 'node:assert/strict';import fs from 'node:fs';import {getDb} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';import {openDb} from './skills/web-console/scripts/db.js';for(const open of [getDb,scheduler,openDb])assert.throws(open,/stable maintenance entry missing/);for(const source of ['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db'])assert.equal(fs.existsSync(process.env.ZYLOS_DIR+'/'+source),false);`);
});
for(const relative of ['.zylos/upgrade/active.json','.backup/self-upgrade','.zylos/upgrade','.zylos','.backup'])test(`missing stable maintenance rejects dangling ${relative}`,t=>{
 const root=fixture(t),file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.symlinkSync(path.join(root,'absent'),file);assert.throws(()=>assertCoreDatabaseAvailable(root),/unavailable/);assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
});
test('first-adoption absence and empty active root permit schema initialization without fabricated protection',t=>{
 const root=fixture(t);assert.doesNotThrow(()=>assertCoreDatabaseAvailable(root));fs.mkdirSync(path.join(root,'.backup/self-upgrade'),{recursive:true,mode:0o700});assert.doesNotThrow(()=>assertCoreDatabaseAvailable(root));
});
test('monitor reports schema incompatibility and fail-closes pending work',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'comm-bridge'));const db=new Database(path.join(root,'comm-bridge/c4.db'));db.exec(sql);db.pragma('user_version=2');db.close();
 run(root, `import assert from 'node:assert/strict';import {UsageMonitor} from './skills/activity-monitor/scripts/usage-monitor.js';const logs=[];const monitor=new UsageMonitor({}, {zylosDir:process.env.ZYLOS_DIR,log:line=>logs.push(line)});assert.equal(monitor.getPendingWorkCount(),Infinity);assert.match(logs[0],/schema version 2/);`);
});

test('web-console rejects future C4 before stale session cleanup',t=>{
 const root=fixture(t);
 run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {openDb} from './skills/web-console/scripts/db.js';getDb();close();const wc=openDb();wc.prepare('INSERT INTO sessions VALUES(?,?,?)').run('stale',1,1);wc.close();`);
 const c4db=new Database(path.join(root,'comm-bridge/c4.db'));c4db.pragma('user_version=2');c4db.close();
 const child=spawnSync(process.execPath,['skills/web-console/scripts/server.js'],{cwd:repo,env:{...process.env,ZYLOS_DIR:root},encoding:'utf8',timeout:5000});assert.notEqual(child.status,0);assert.match(child.stderr,/schema version 2/);
 const wcdb=new Database(path.join(root,'web-console/web-console.db'),{readonly:true});assert.equal(wcdb.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,1);wcdb.close();
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
  for(const relative of ['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db']) {
   const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
   if(header) {const db=new Database(file);db.exec('VACUUM');db.close();assert.ok(fs.statSync(file).size>0);} else fs.writeFileSync(file,'');
  }
  run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';import {openDb} from './skills/web-console/scripts/db.js';getDb();close();scheduler().close();openDb().close();`);
  const db=new Database(path.join(root,'comm-bridge/c4.db'));assert.equal(c4.inspectSchema(db).version,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n,1);db.close();
 }
});
test('process death during initial migration leaves an empty database recoverable by the real owner',async t=>{
 const root=fixture(t),file=path.join(root,'comm-bridge/c4.db'),ready=path.join(root,'ready');fs.mkdirSync(path.dirname(file));
 const running=childModule(root, `import fs from 'node:fs';import Database from './skills/comm-bridge/node_modules/better-sqlite3/lib/index.js';import * as owner from './skills/comm-bridge/scripts/c4-schema.js';import {guardDatabase} from './skills/comm-bridge/scripts/sqlite-schema.js';import {migrateSchema} from './skills/comm-bridge/scripts/c4-db.js';const db=new Database(${JSON.stringify(file)});guardDatabase(db,{...owner,migrate(connection,options){migrateSchema(connection,options);fs.writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}});`);
 t.after(()=>running.child.kill('SIGKILL'));await waitFile(ready);running.child.kill('SIGKILL');assert.equal((await running.done).signal,'SIGKILL');
 const interrupted=new Database(file);assert.equal(interrupted.pragma('user_version',{simple:true}),0);assert.equal(interrupted.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,0);interrupted.close();
 run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';getDb();close();`);
 const recovered=new Database(file);assert.equal(c4.inspectSchema(recovered).version,1);assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n,1);recovered.close();
});
test('two processes initialize the same existing empty database under one writer lock',async t=>{
 const root=fixture(t),file=path.join(root,'db'),firstReady=path.join(root,'first'),secondReady=path.join(root,'second'),release=path.join(root,'release'),migrations=path.join(root,'migrations');fs.writeFileSync(file,'');
 const imports=`import fs from 'node:fs';import Database from './skills/comm-bridge/node_modules/better-sqlite3/lib/index.js';import * as owner from './skills/comm-bridge/scripts/c4-schema.js';import {guardDatabase} from './skills/comm-bridge/scripts/sqlite-schema.js';import {migrateSchema} from './skills/comm-bridge/scripts/c4-db.js';const db=new Database(${JSON.stringify(file)});`;
 const first=childModule(root,imports+`guardDatabase(db,{...owner,migrate(connection,options){fs.writeFileSync(${JSON.stringify(firstReady)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);fs.appendFileSync(${JSON.stringify(migrations)},'1');migrateSchema(connection,options);}});db.close();`);
 t.after(()=>first.child.kill('SIGKILL'));await waitFile(firstReady);
 const second=childModule(root,imports+`let inspections=0;guardDatabase(db,{...owner,inspectSchema(connection,options){const result=owner.inspectSchema(connection,options);if(++inspections===1){if(!result.empty)throw Error('expected empty schema before lock');fs.writeFileSync(${JSON.stringify(secondReady)},'ready');}return result;},migrate(connection,options){fs.appendFileSync(${JSON.stringify(migrations)},'2');migrateSchema(connection,options);}});db.close();`);
 t.after(()=>second.child.kill('SIGKILL'));await waitFile(secondReady);fs.writeFileSync(release,'go');
 for(const result of await Promise.all([first.done,second.done]))assert.equal(result.code,0,result.stderr);
 assert.equal(fs.readFileSync(migrations,'utf8'),'1');const db=new Database(file);assert.equal(c4.inspectSchema(db).version,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get().n,1);db.close();
});
test('empty-schema allowance rejects views and readonly preflight never initializes existing empty files',t=>{
 const root=fixture(t),file=path.join(root,'empty');fs.writeFileSync(file,'');const before=fs.readFileSync(file);
 assert.throws(()=>preflightDatabase(Database,file,wc,{allowMissing:true}),/missing/);assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(file+'-wal'),false);
 const db=new Database(':memory:');db.exec('CREATE VIEW unknown AS SELECT 1 AS x');assert.throws(()=>guardDatabase(db,{...wc,migrate(){assert.fail('migration');}}),/unsupported objects/);assert.equal(db.pragma('user_version',{simple:true}),0);db.close();
});
test('empty initialization requires owner capability and a regular file; malformed files remain unchanged',t=>{
 const db=new Database(':memory:');assert.throws(()=>guardDatabase(db,{...wc,supportsNewDatabase:false,migrate(){assert.fail('migration');}}),/missing/);db.close();
 const root=fixture(t),target=path.join(root,'target'),link=path.join(root,'link');fs.writeFileSync(target,'');fs.symlinkSync(target,link);const linked=new Database(link);assert.throws(()=>guardDatabase(linked,{...wc,migrate(){assert.fail('migration');}}),/Unsafe empty database/);linked.close();assert.equal(fs.statSync(target).size,0);
 const file=path.join(root,'malformed');fs.writeFileSync(file,'not a SQLite database');const before=fs.readFileSync(file);const malformed=new Database(file);assert.throws(()=>guardDatabase(malformed,{...wc,migrate(){assert.fail('migration');}}),/not a database/);malformed.close();assert.deepEqual(fs.readFileSync(file),before);
});
test('SQLite automatic transaction rollback preserves the original migration error',()=>{
 const db=new Database(':memory:');db.exec(sql);
 assert.throws(()=>guardDatabase(db,{...c4,migrate(connection){connection.exec('CREATE TABLE unique_migration(x INTEGER UNIQUE); INSERT INTO unique_migration VALUES(1); INSERT OR ROLLBACK INTO unique_migration VALUES(1);');}}),error=>error.code==='SQLITE_CONSTRAINT_UNIQUE' && /UNIQUE constraint failed/.test(error.message));
 assert.equal(db.inTransaction,false);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='unique_migration'").get(),undefined);assert.equal(db.pragma('user_version',{simple:true}),0);db.close();
});
test('invalid schema versions are distinguished from future supported-range versions',()=>{
 const db=new Database(':memory:');db.pragma('user_version = -1');assert.throws(()=>wc.inspectSchema(db),/invalid schema version -1/);db.close();
 for(const version of [1.5,undefined,NaN])assert.throws(()=>wc.inspectSchema({pragma(){return version;}}),/invalid schema version/);
 const future=new Database(':memory:');future.pragma('user_version = 2');assert.throws(()=>wc.inspectSchema(future),/schema version 2 exceeds supported 1/);future.close();
});

for (const layout of ['symlink .zylos', 'symlink .backup', 'group writable', 'partial stable deployment', 'dangling stable helper', 'empty0775']) test(`ordinary owner openers permit ${layout} without recovery materials`, t => {
 const root=fixture(t);
 if(layout.startsWith('symlink')) {
  const target=path.join(root,'legacy-parent');fs.mkdirSync(target);fs.symlinkSync(target,path.join(root,layout.split(' ')[1]));
 }
 const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true});
 if(layout==='dangling stable helper') fs.symlinkSync(path.join(root,'missing'),path.join(stable,'maintenance.cjs'));
 else fs.writeFileSync(path.join(stable,'maintenance.cjs'),"throw Error('partial deployment must not load');");
 const active=path.join(root,'.backup/self-upgrade');fs.mkdirSync(active,{recursive:true});
 if(layout==='group writable' || layout==='empty0775') {
  for(const directory of [path.join(root,'.zylos'),stable,path.join(root,'.backup'),active])fs.chmodSync(directory,0o775);
  if(layout==='group writable')fs.chmodSync(path.join(stable,'maintenance.cjs'),0o664);
 }
 assert.doesNotThrow(()=>assertCoreDatabaseAvailable(root));
 run(root, `import {getDb,close} from './skills/comm-bridge/scripts/c4-db.js';import {getDb as scheduler} from './skills/scheduler/scripts/database.js';import {openDb} from './skills/web-console/scripts/db.js';getDb();close();scheduler().close();openDb().close();`);
 for(const [relative,owner] of [['comm-bridge/c4.db',c4],['scheduler/scheduler.db',scheduler],['web-console/web-console.db',wc]]) {
  const db=new Database(path.join(root,relative),{readonly:true});assert.equal(owner.inspectSchema(db).version,1);db.close();
 }
});
test('dangling stable helper with actual materials still blocks ordinary owners', t => {
 const root=fixture(t),stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true});fs.symlinkSync(path.join(root,'missing'),path.join(stable,'maintenance.cjs'));fs.writeFileSync(path.join(stable,'active.json'),'{}');
 assert.throws(()=>assertCoreDatabaseAvailable(root),/unsafe stable maintenance entry/);
});
