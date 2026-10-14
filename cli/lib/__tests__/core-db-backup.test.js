import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {protectedDataReady} from '../upgrade-protection.js';
import {fileURLToPath} from 'node:url';
import {CORE_DATABASES,createCoreDbSnapshot,prepareRecoveryDependencies,probeCoreDbVersions,rehearseCoreDbUpgrade,runCoreDbWorker} from '../core-db-backup.js';
const installed=process.env.CORE_DB_TEST_SKILL || path.join(os.homedir(),'zylos','.claude','skills','comm-bridge');
let Database;try{Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');}catch{}
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'core-db-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function skills(dir){for(const item of CORE_DATABASES){const owner=path.join(dir,'.claude','skills',item.owner);fs.mkdirSync(owner,{recursive:true});fs.writeFileSync(path.join(owner,'package.json'),'{}');fs.symlinkSync(path.join(installed,'node_modules'),path.join(owner,'node_modules'));}}
test('version probe reads only user_version, detects a missing or older database, and rejects a newer one', {skip:!Database}, t => {
 const dir=fixture(t);skills(dir);
 for(const item of CORE_DATABASES){
  const file=path.join(dir,item.source);fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);try{db.pragma('user_version=1');}finally{db.close();}
 }
 const probe=()=>probeCoreDbVersions(dir,path.resolve('.'),{driverRoot:path.join(dir,'.claude','skills')});
 const current=probe();
 assert.equal(current.needsMigration,false);
 assert.equal(current.databases.length,3);
 assert.ok(current.databases.every(row=>row.fromVersion===1&&row.toVersion===1&&!row.needsMigration));
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
 assert.throws(probe,/exceeds supported 1/);
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
 assert.ok(!fs.existsSync(one.dbBackupDir));assert.ok(fs.existsSync(two.dbBackupDir));assert.ok(fs.existsSync(path.join(dir,'.backup/db/unrelated/note')));
 assert.equal(fs.statSync(path.join(two.dbBackupDir,'manifest.json')).mode&0o777,0o600);
});
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
test('driver missing fails before publication and preserves staging',t=>{
 const dir=fixture(t);fs.mkdirSync(path.join(dir,'comm-bridge'));fs.writeFileSync(path.join(dir,'comm-bridge/c4.db'),'unreadable');
 assert.throws(()=>createCoreDbSnapshot({zylosDir:dir,transactionId:'no-driver'}),/SQLite snapshot failed/);
 assert.ok(!fs.existsSync(path.join(dir,'.backup/db/no-driver')));
});

test('offline-preflight loads only pure owner inspectors through maintenance marker and rejects future schema', {skip:!Database},t=>{
 const dir=fixture(t);skills(dir);const schemaRoot=path.resolve('skills');
 fs.mkdirSync(path.join(dir,'.zylos'));fs.writeFileSync(path.join(dir,'.zylos/self-upgrade-maintenance.json'),'{}');
 assert.equal(runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot}).databases.length,3);
 fs.mkdirSync(path.join(dir,'comm-bridge'));const source=path.join(dir,'comm-bridge/c4.db');const db=new Database(source);db.pragma('user_version=999');db.close();
 const before=fs.readFileSync(source);
 assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot}),/future|newer|unsupported|exceeds/i);
 assert.deepEqual(fs.readFileSync(source),before);
});

test('offline preflight accepts and reports archive tables and extra columns', {skip:!Database},async t=>{
 const dir=fixture(t);skills(dir);
 const schemaRoot=path.resolve('skills');
 const {migrateDatabase}=await import('../../../skills/comm-bridge/scripts/sqlite-schema.js');
 const owners=await Promise.all([
  import('../../../skills/comm-bridge/scripts/c4-schema.js'),
  import('../../../skills/scheduler/scripts/schema.js'),
  import('../../../skills/web-console/scripts/schema.js'),
 ]);
 const requiredTables=['checkpoints','tasks','sessions'];
 for(const [index,item] of CORE_DATABASES.entries()) {
  const file=path.join(dir,item.source);fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);
  try {
   migrateDatabase(db,owners[index],{allowNew:true,strict:false});
   db.exec('CREATE TABLE archive_records(id INTEGER PRIMARY KEY, value TEXT)');
  } finally {db.close();}
 }
 const preflight=()=>runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot});
 const tables=preflight().databases;
 assert.equal(tables.length,3);
 for(const [index,row] of tables.entries()) {
  assert.equal(row.source,CORE_DATABASES[index].source);
  assert.deepEqual(row.extensions,{tables:['archive_records'],columns:[]});
 }
 for(const [index,item] of CORE_DATABASES.entries()) {
  const db=new Database(path.join(dir,item.source));
  try {db.exec(`ALTER TABLE ${requiredTables[index]} ADD COLUMN extension_value TEXT`);} finally {db.close();}
 }
 const before=CORE_DATABASES.map(item=>fs.readFileSync(path.join(dir,item.source)));
 const accepted=preflight().databases;
 for(const [index,row] of accepted.entries()) {
  assert.deepEqual(row.extensions,{tables:['archive_records'],columns:[{table:requiredTables[index],column:'extension_value'}]});
 }
 assert.deepEqual(CORE_DATABASES.map(item=>fs.readFileSync(path.join(dir,item.source))),before);
});

test('upgrade preflight and rehearsal reject an unsafe extension before service stop', {skip:!Database},async t=>{
 const dir=fixture(t);skills(dir);
 const schemaRoot=path.resolve('skills');
 const {migrateDatabase,guardDatabase}=await import('../../../skills/comm-bridge/scripts/sqlite-schema.js');
 const owner=await import('../../../skills/comm-bridge/scripts/c4-schema.js');
 const source=path.join(dir,'comm-bridge/c4.db');fs.mkdirSync(path.dirname(source),{recursive:true});
 const db=new Database(source);
 try {
  migrateDatabase(db,owner,{allowNew:true,strict:false});
  db.exec('ALTER TABLE conversations ADD COLUMN my_tag TEXT NOT NULL');
  assert.equal(guardDatabase(db,owner).version,1);
 }finally{db.close();}
 const before=fs.readFileSync(source);
 assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot}),/conversations\.my_tag.*default/);
 assert.throws(()=>rehearseCoreDbUpgrade(dir,path.resolve('.'),{driverRoot:path.join(os.homedir(),'zylos','.claude','skills')}),/conversations\.my_tag.*default/);
 assert.deepEqual(fs.readFileSync(source),before);
});

test('target rehearsal migrates private copies before stop and leaves live databases unchanged', {skip:!Database},t=>{
 const dir=fixture(t),source=path.join(dir,'comm-bridge/c4.db');
 fs.mkdirSync(path.dirname(source),{recursive:true});
 const db=new Database(source);
 try {
  db.exec(fs.readFileSync(path.resolve('skills/comm-bridge/scripts/__tests__/fixtures/migration-history/c4-v0.1.0.sql'),'utf8'));
  db.exec("INSERT INTO conversations(direction,channel,endpoint_id,content) VALUES('in','web-console','session-handoff','retained')");
 } finally {db.close();}
 const before=fs.readFileSync(source);
 const result=rehearseCoreDbUpgrade(dir,path.resolve('.'),{driverRoot:path.join(os.homedir(),'zylos','.claude','skills')});
 assert.deepEqual(result.databases.map(row=>row.toVersion),[1,1,1]);
 assert.equal(result.databases[0].fromVersion,0);
 assert.deepEqual(fs.readFileSync(source),before);
 assert.equal(fs.existsSync(path.join(dir,'scheduler/scheduler.db')),false);
 assert.equal(fs.existsSync(path.join(dir,'web-console/web-console.db')),false);
 assert.deepEqual(fs.readdirSync(path.join(dir,'.backup/db')).filter(name=>name.startsWith('.rehearsal-')),[]);
});

test('rehearsal worker receives a private backup path and parent removes it on failure',t=>{
 const dir=fixture(t),target=path.join(dir,'target'),observed=path.join(dir,'observed.json');
 fs.mkdirSync(path.join(target,'cli/lib'),{recursive:true});
 fs.mkdirSync(path.join(target,'skills/comm-bridge/scripts'),{recursive:true});
 fs.writeFileSync(path.join(target,'skills/comm-bridge/scripts/sqlite-schema.js'),'');
 fs.writeFileSync(path.join(target,'cli/lib/core-db-backup-worker.js'),`
  const fs=require('node:fs');
  const payload=JSON.parse(process.argv[2]);
  const stat=fs.lstatSync(payload.rehearsalDir);
  fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({path:payload.rehearsalDir,mode:stat.mode&0o777,isDirectory:stat.isDirectory()}));
  process.stderr.write('injected rehearsal failure');
  process.exit(1);
 `);
 assert.throws(()=>rehearseCoreDbUpgrade(dir,target),/injected rehearsal failure/);
 const result=JSON.parse(fs.readFileSync(observed,'utf8'));
 assert.ok(result.path.startsWith(path.join(dir,'.backup/db/.rehearsal-')));
 assert.equal(result.mode,0o700);
 assert.equal(result.isDirectory,true);
 assert.equal(fs.existsSync(result.path),false);
 assert.deepEqual(fs.readdirSync(path.join(dir,'.backup/db')).filter(name=>name.startsWith('.rehearsal-')),[]);
});

test('normalized snapshots inspect directly with no temporary database and preserve live WAL bytes', {skip:!Database},t=>{
 const dir=fixture(t);skills(dir);fs.mkdirSync(path.join(dir,'comm-bridge'));
 const source=path.join(dir,'comm-bridge/c4.db');const writer=new Database(source);t.after(()=>writer.close());
 writer.pragma('journal_mode=WAL');writer.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY,value BLOB)');
 writer.prepare('INSERT INTO entries VALUES (?,?)').run(9007199254740993n,Buffer.from([0,255,2]));
 const before=[source,source+'-wal'].map(file=>fs.readFileSync(file));
 const snapshot=createCoreDbSnapshot({zylosDir:dir,transactionId:'normalized'});
 assert.deepEqual([source,source+'-wal'].map(file=>fs.readFileSync(file)),before);
 assert.equal(writer.pragma('journal_mode',{simple:true}),'wal');
 const row=snapshot.manifest.databases[0],file=path.join(snapshot.dbBackupDir,row.file);
 assert.equal(Object.hasOwn(row,'logicalHash'),false);
 const readonly=new Database(file,{readonly:true,fileMustExist:true});
 try {
  assert.equal(readonly.pragma('journal_mode',{simple:true}),'delete');
  const value=readonly.prepare('SELECT * FROM entries').safeIntegers(true).get();
  assert.equal(value.id,9007199254740993n);assert.deepEqual(value.value,Buffer.from([0,255,2]));
 }finally{readonly.close();}
 const tmpdir=process.env.TMPDIR;
 try {
  process.env.TMPDIR=path.join(dir,'unavailable-temp-directory');
  const verified=runCoreDbWorker({action:'verify',zylosDir:dir,dbBackupDir:snapshot.dbBackupDir,manifest:snapshot.manifest});
  assert.equal(verified.databases[0].integrityCheck,'ok');
 }finally{if(tmpdir===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=tmpdir;}
 for(const suffix of ['-wal','-shm'])assert.equal(fs.existsSync(file+suffix),false);
});
test('copied closure is probe-loaded and remains independent of owner installations', {skip:!Database},t=>{
 const dir=fixture(t);skills(dir);const closure=prepareRecoveryDependencies(path.join(dir,'transaction'),dir);
 assert.equal(Object.hasOwn(closure,'driverClosureHashes'),false);
 for(const item of CORE_DATABASES)fs.unlinkSync(path.join(dir,'.claude/skills',item.owner,'node_modules'));
 assert.deepEqual(runCoreDbWorker({action:'probe',driverPath:closure.driverPath},closure),{ok:true});
 fs.writeFileSync(closure.driverPath,'throw Error("broken copied driver");');
 assert.throws(()=>runCoreDbWorker({action:'probe',driverPath:closure.driverPath},closure),/broken copied driver/);
});
test('old owner without pure schema module fails explicit compatibility preflight',t=>{
 const dir=fixture(t);const schemaRoot=path.join(dir,'old-skills');
 assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot}),/Incompatible owner schema code comm-bridge/);
});

test('worker executes through a directory alias without skipping its CLI entry',t=>{
 const dir=fixture(t);
 const alias=path.join(dir,'worker-alias');
 const worker=fileURLToPath(new URL('../core-db-backup-worker.js',import.meta.url));
 fs.symlinkSync(path.dirname(worker),alias,'dir');
 const result=runCoreDbWorker({action:'snapshot',zylosDir:dir,stagingDir:dir},{workerPath:path.join(alias,path.basename(worker))});
 assert.equal(result.databases.length,3);
 assert.ok(result.databases.every(row=>row.status==='missing'));
});

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

test('controlled installed migration requires installing identity, preserves snapshots and initializes historical absent web DB', {skip:!Database},t=>{
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
 fs.copyFileSync(path.resolve('cli/lib/upgrade-maintenance.cjs'),path.join(dir,'.zylos/upgrade/maintenance.cjs'));
 fs.chmodSync(path.join(dir,'.zylos/upgrade/maintenance.cjs'),0o600);
 const j={formatVersion:1,transactionId,zylosDir:dir,skillsDir:schemaRoot,phase:'installing',installationIntent:true,initialIdentity:{},dbBackupDir:snapshot.dbBackupDir,snapshotManifestHash:m.hash(path.join(snapshot.dbBackupDir,'manifest.json'))};
 const digest='a'.repeat(64);
 Object.assign(j,{nodePath:process.execPath,coreManifest:[{name:'comm-bridge',existedBefore:true,backedUp:true,originalHash:digest}],originalServices:[]});
 j.initialIdentity={nodePath:process.execPath,cliRoot:path.join(dir,'package/cli'),cliHash:digest,packageJson:path.join(dir,'package/package.json'),packageHash:digest,workerPath:path.join(dir,'package/cli/lib/core-db-backup-worker.js'),workerHash:digest,ecosystemHash:null,databases:CORE_DATABASES.map(item=>({source:item.source,exists:item.owner!=='web-console'}))};
 const ordinary=[['comm-bridge/scripts/c4-db.js','getDb',"INSERT INTO conversations(direction,channel,content) VALUES ('in','fixture','after-ready')"],['scheduler/scripts/database.js','getDb',"INSERT INTO tasks(id,name,prompt,type,next_run_at,created_at,updated_at) VALUES ('after-ready','fixture','fixture','one-time',1,1,1)"],['web-console/scripts/db.js','openDb',"INSERT INTO sessions(token,created_at,last_seen_at) VALUES ('after-ready',1,1)"]];
 const open=(item)=>spawnSync(process.execPath,['--input-type=module','-e',`const mod=await import(${JSON.stringify(path.join(schemaRoot,item[0]))});const db=mod[${JSON.stringify(item[1])}]();db.exec(${JSON.stringify(item[2])});db.close();`],{encoding:'utf8',env:{...process.env,HOME:dir,ZYLOS_DIR:dir,PM2_HOME:path.join(dir,'pm2-home')}});
 m.durable(path.join(transactionDir,'journal.json'),j);m.marker(dir,transactionDir,j);
 for(const item of ordinary){const result=open(item);assert.notEqual(result.status,0);assert.match(result.stderr,/unavailable|maintenance|upgrade/i);}

 assert.throws(()=>m.assertCoreDatabaseAvailable(dir),/maintenance|upgrade|blocked/i);
 assert.throws(()=>runCoreDbWorker({...payload,transactionId:'other'}),/identity mismatch/);
 const result=runCoreDbWorker(payload);
 assert.equal(result.databases.length,3);assert.ok(result.databases.every(row=>row.userVersion===1));
 assert.deepEqual(result.databases[0].extensions,{tables:['archive_records'],columns:[{table:'conversations',column:'extension_value'}]});
 assert.throws(()=>m.assertCoreDatabaseAvailable(dir),/maintenance|upgrade|blocked/i);
 assert.equal(runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot,requireCurrent:true}).databases.length,3);
 assert.equal(runCoreDbWorker({action:'verify',zylosDir:dir,dbBackupDir:snapshot.dbBackupDir,manifest:snapshot.manifest}).databases[0].userVersion,0);
 assert.equal(runCoreDbWorker(payload).databases[0].userVersion,1);
 const retained=new Database(path.join(dir,'comm-bridge/c4.db'),{readonly:true});
 assert.equal(retained.prepare('SELECT value FROM archive_records WHERE id=1').get().value,'retained');retained.close();
 for(const item of ordinary)assert.notEqual(open(item).status,0);
 const preflight=m.preflight;m.preflight=()=>({success:true});
 try {protectedDataReady({transactionDir,transactionId});}finally{m.preflight=preflight;}
 for(const item of ordinary){const result=open(item);assert.equal(result.status,0,result.stderr);}
 for(const [index,table] of ['conversations','tasks','sessions'].entries()) {
  const db=new Database(path.join(dir,CORE_DATABASES[index].source),{readonly:true});
  try {assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,1);}finally{db.close();}
 }
 assert.throws(()=>runCoreDbWorker(payload),/active installing/);
});
