import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {CORE_DATABASES,createCoreDbSnapshot,prepareRecoveryDependencies,runCoreDbWorker} from '../core-db-backup.js';
const installed=process.env.CORE_DB_TEST_SKILL || path.join(os.homedir(),'zylos','.claude','skills','comm-bridge');
let Database;try{Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');}catch{}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'core-db-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function skills(dir){for(const item of CORE_DATABASES){const owner=path.join(dir,'.claude','skills',item.owner);fs.mkdirSync(owner,{recursive:true});fs.writeFileSync(path.join(owner,'package.json'),'{}');fs.symlinkSync(path.join(installed,'node_modules'),path.join(owner,'node_modules'));}}
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
