import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
test('unknown and empty existing layouts never receive a stamp',()=>{
 const db=new Database(':memory:');assert.throws(()=>guardDatabase(db,{...wc,migrate(){assert.fail('migration');}}),/missing/);db.exec('CREATE TABLE unknown(x)');assert.throws(()=>wc.inspectSchema(db),/missing/);assert.equal(db.pragma('user_version',{simple:true}),0);db.close();
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
for(const relative of ['.zylos/upgrade/active.json','.zylos/upgrade/cleanup.json','.zylos/upgrade/maintenance.cjs','.backup/self-upgrade','.zylos/upgrade','.zylos','.backup'])test(`missing stable maintenance rejects dangling ${relative}`,t=>{
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
