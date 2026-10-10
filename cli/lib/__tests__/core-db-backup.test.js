import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {CORE_DATABASES,createCoreDbSnapshot,prepareRecoveryDependencies,runCoreDbWorker,verifyRecoveryDependencies} from '../core-db-backup.js';
import {logicalHash} from '../core-db-backup-worker.js';
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
 // Inspect a disposable copy: even a readonly WAL-header open creates sidecars.
 const inspectedCopy=path.join(dir,'inspect-snapshot.db');fs.copyFileSync(path.join(snapshot.dbBackupDir,row.file),inspectedCopy);
 const db=new Database(inspectedCopy,{readonly:true});assert.equal(db.prepare('SELECT message FROM messages').get().message,'committed');assert.equal(db.prepare('SELECT count(*) AS count FROM messages').get().count,2);db.close();assert.equal(writer.pragma('user_version',{simple:true}),7);
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

test('logical evidence survives checkpoint but detects committed SQLite values including blobs and wide integers', {skip:!Database},t=>{
 const dir=fixture(t);skills(dir);fs.mkdirSync(path.join(dir,'comm-bridge'));
 const source=path.join(dir,'comm-bridge/c4.db');const writer=new Database(source);t.after(()=>writer.close());
 writer.pragma('journal_mode=WAL');writer.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY,value BLOB)');
 writer.prepare('INSERT INTO entries VALUES (?,?)').run(9007199254740993n,Buffer.from([0,255,2]));
 const snapshot=createCoreDbSnapshot({zylosDir:dir,transactionId:'logical'});const expected=snapshot.manifest.databases[0].logicalHash;
 assert.equal(logicalHash(writer),expected);writer.pragma('wal_checkpoint(TRUNCATE)');assert.equal(logicalHash(writer),expected);
 writer.prepare('UPDATE entries SET value=?').run(Buffer.from([0,255,3]));assert.notEqual(logicalHash(writer),expected);
});
test('frozen dependency hashes reject modified native/module code before worker execution', {skip:!Database},t=>{
 const dir=fixture(t);skills(dir);const closure=prepareRecoveryDependencies(path.join(dir,'transaction'),dir);
 assert.ok(closure.driverClosureHashes.some(row=>row.file.endsWith('.node')));assert.ok(verifyRecoveryDependencies(closure));
 fs.appendFileSync(closure.driverPath,'\n// changed');
 assert.throws(()=>runCoreDbWorker({action:'probe',driverPath:closure.driverPath},closure),/Recovery dependency changed/);
});
test('old owner without pure schema module fails explicit compatibility preflight',t=>{
 const dir=fixture(t);const schemaRoot=path.join(dir,'old-skills');
 assert.throws(()=>runCoreDbWorker({action:'offline-preflight',zylosDir:dir,schemaRoot}),/Incompatible owner schema code comm-bridge/);
});
