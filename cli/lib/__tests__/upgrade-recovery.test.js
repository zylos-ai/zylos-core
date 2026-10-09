import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {CORE_DATABASES,createCoreDbSnapshot,prepareRecoveryDependencies} from '../core-db-backup.js';
import {logicalHash} from '../core-db-backup-worker.js';

const require=createRequire(import.meta.url);
const Database=require(path.resolve('skills/comm-bridge/node_modules/better-sqlite3'));
// Each test loads private copies of the real recovery and maintenance modules.
// Only service calls are replaced: database/native worker, hashes, journal,
// rescue, rename intents, isolation discovery, and archive are real.
async function fixture(t,{missing=false}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-recovery-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
 for(const [src,dst] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']])fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dst));
 const m=require(path.join(stable,'maintenance.cjs')),r=require(path.join(stable,'recovery.cjs'));
 const skillsDir=path.join(root,'.claude/skills');
 for(const item of CORE_DATABASES){const owner=path.join(skillsDir,item.owner);fs.mkdirSync(path.join(owner,'scripts'),{recursive:true});fs.writeFileSync(path.join(owner,'package.json'),'{"type":"module"}');fs.symlinkSync(path.resolve('skills',item.owner,'node_modules'),path.join(owner,'node_modules'));
  fs.copyFileSync(path.resolve('skills',item.owner,item.schema),path.join(owner,item.schema));
 }
 fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/sqlite-schema.js'),path.join(skillsDir,'comm-bridge/scripts/sqlite-schema.js'));
 for(const item of CORE_DATABASES){if(missing&&item.owner==='scheduler')continue;const mod=await import(pathToFileURL(path.join(skillsDir,item.owner,item.schema)));const p=path.join(root,item.source);fs.mkdirSync(path.dirname(p),{recursive:true});const db=new Database(p);
  for(const [name,columns] of Object.entries(mod.TABLES)){const defs=mod.COLUMN_DEFINITIONS?.[name]||{};db.exec(`CREATE TABLE "${name}" (${columns.map(c=>`"${c}" ${defs[c]?.type||'TEXT'}${defs[c]?.pk?' PRIMARY KEY':''}`).join(',')})`);}
  db.pragma('user_version=1');db.close();
 }
 const dir=path.join(root,'.backup/self-upgrade','tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const snapshot=createCoreDbSnapshot({zylosDir:root,transactionId:'tx'}),closure=prepareRecoveryDependencies(dir,root);
 fs.copyFileSync(path.join(stable,'recovery.cjs'),path.join(dir,'runner.cjs'));fs.chmodSync(path.join(dir,'runner.cjs'),0o600);
 for(const [src,dst] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-finalizer.cjs','finalizer.cjs']]){fs.copyFileSync(path.resolve('cli/lib',src),path.join(dir,dst));fs.chmodSync(path.join(dir,dst),0o600);}
 const coreManifest=CORE_DATABASES.map(item=>({name:item.owner,existedBefore:true,backedUp:true,originalHash:m.treeHash(path.join(skillsDir,item.owner))}));
 for(const e of coreManifest)fs.cpSync(path.join(skillsDir,e.name),path.join(dir,'code/skills',e.name),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
 const packageJson=path.join(root,'package.json');fs.writeFileSync(packageJson,'{}');const originalCli=path.join(root,'baseline-cli');fs.mkdirSync(originalCli,{mode:0o700});
 const j={formatVersion:1,transactionId:'tx',zylosDir:root,skillsDir,nodePath:process.execPath,phase:'installing',installationIntent:true,dbBackupDir:snapshot.dbBackupDir,snapshotManifestHash:m.hash(path.join(snapshot.dbBackupDir,'manifest.json')),coreManifest,originalServices:[],initialIdentity:{nodePath:process.execPath,packageJson,packageHash:m.hash(packageJson),cliRoot:originalCli,cliHash:m.treeHash(originalCli),workerPath:closure.workerPath,workerHash:m.hash(closure.workerPath),ecosystemHash:null,databases:snapshot.manifest.databases.map(d=>({source:d.source,exists:d.status!=='missing'}))}};
 const descriptor={formatVersion:1,transactionId:'tx',...closure,runnerPath:path.join(dir,'runner.cjs'),hashes:Object.fromEntries(['runner.cjs','maintenance.cjs','finalizer.cjs'].map(name=>[name,m.hash(path.join(dir,name))]))};m.durable(path.join(dir,'descriptor.json'),descriptor);m.update(dir,j);m.marker(root,dir,j);
 const calls=[];m.stop=()=>calls.push('stop');m.start=()=>calls.push('start');m.verifyServices=()=>calls.push('verify');
 return {root,dir,j,m,r,calls,snapshot,load:()=>m.read(path.join(dir,'journal.json')),db:p=>path.join(root,p)};
}
function change(f){const p=f.db('comm-bridge/c4.db'),db=new Database(p);db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(1,'new-generation');db.close();fs.writeFileSync(p+'-wal','old-wal');fs.writeFileSync(p+'-shm','old-shm');fs.appendFileSync(path.join(f.j.skillsDir,'comm-bridge/package.json'),'\n');}

test('A12/A14/A15: complete compensation restores old code/data, preserves rescue, removes sidecars and archives',async t=>{
 const f=await fixture(t,{missing:true});change(f);fs.mkdirSync(path.dirname(f.db('scheduler/scheduler.db')),{recursive:true});fs.writeFileSync(f.db('scheduler/scheduler.db'),'new-db');
 const original=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.equal(result.stage,'restored_complete');assert.ok(!fs.existsSync(f.db('scheduler/scheduler.db')));assert.ok(!fs.existsSync(f.db('comm-bridge/c4.db-wal')));
 const archived=path.join(f.root,'.backup/self-upgrade-archive/tx');assert.deepEqual(fs.readFileSync(path.join(archived,'rescue/comm-bridge_c4.db')),original);assert.equal(f.m.discover(f.root).blocked,false);assert.deepEqual(f.calls,['stop','start','verify']);
});
test('A14/A28: damaged snapshot is rejected before rescue or replacement',async t=>{
 const f=await fixture(t);change(f);const before=fs.readFileSync(f.db('comm-bridge/c4.db'));fs.appendFileSync(path.join(f.snapshot.dbBackupDir,f.snapshot.manifest.databases[0].file),'bad');
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/hash mismatch/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.ok(!f.calls.includes('start'));assert.equal(f.m.discover(f.root).blocked,true);
});
test('A26: crash after physical DB rename but before done journal resumes existing intent without recapturing rescue',async t=>{
 const f=await fixture(t);change(f);f.r.rescue(f.dir,f.j);f.r.restoreCore(f.dir,f.j);
 const real=f.m.renameIntent;let crashed=false;f.m.renameIntent=(dir,j,key,...args)=>{const result=real(dir,j,key,...args);if(!crashed&&key==='install_comm-bridge_c4.db'){crashed=true;j.actions[key].done=false;f.m.update(dir,j);throw Error('simulated power loss after install rename');}return result;};
 assert.throws(()=>f.r.replaceDatabases(f.dir,f.j,f.snapshot.manifest),/power loss/);const rescueHash=f.m.hash(path.join(f.dir,'rescue/comm-bridge_c4.db'));f.m.renameIntent=real;
 const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.equal(f.m.hash(path.join(f.root,'.backup/self-upgrade-archive/tx/rescue/comm-bridge_c4.db')),rescueHash);
});
test('A26: partial rescue resumes recorded generation and refuses changed rescue evidence',async t=>{
 const f=await fixture(t);change(f);const real=f.m.renameIntent;let crashed=false;f.m.renameIntent=(dir,j,key,...args)=>{const result=real(dir,j,key,...args);if(!crashed&&key==='rescue_comm-bridge_c4.db'){crashed=true;throw Error('simulated crash');}return result;};assert.throws(()=>f.r.rescue(f.dir,f.j),/crash/);f.m.renameIntent=real;
 fs.appendFileSync(path.join(f.dir,'rescue/comm-bridge_c4.db'),'tampered');const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/rescue hash conflict/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});
for(const phase of ['new_data_ready','restored_data_ready','new_verifying','restored_verifying'])test(`A16/A27: ${phase} resumes validation and retains valid normal writes`,async t=>{
 const f=await fixture(t);const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(7,'normal-write');db.close();f.m.update(f.dir,f.j,{phase});
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,false);assert.ok(!f.calls.includes('stop'));const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=7').get().summary,'normal-write');read.close();assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade-archive/tx/rescue')));
});
test('A27: restored verification failure isolates without a second database replacement',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));f.m.verifyServices=()=>{throw Error('service failed');};
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.equal(f.load().resumePhase,'restored_verifying');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.equal(f.m.discover(f.root).blocked,true);
});
test('A28: unconfirmed finalizer exit keeps current generation isolated',async t=>{
 const f=await fixture(t);change(f);f.m.update(f.dir,f.j,{finalizerExitUnconfirmed:true});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/exit requires verification/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});
test('A24/A29: trusted preinstall abort verifies original data without snapshot restore',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.stage,'aborted_before_install',JSON.stringify(result));assert.equal(result.attempted,false);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade-archive/tx/rescue')));assert.equal(f.m.discover(f.root).blocked,false);
});
test('A25: interrupted original service restart only resumes verified abort cleanup',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});let first=true;f.m.start=()=>{f.calls.push('start');if(first){first=false;throw Error('start interrupted');}};
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.load().resumePhase,'aborted_before_install');assert.equal(f.m.discover(f.root).blocked,true);assert.equal(f.r.resume(f.dir).stage,'aborted_before_install');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
});
for(const phase of ['new_data_ready','restored_data_ready'])test(`${phase}: archive failure preserves verified terminal and retries cleanup without compensation`,async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const rename=fs.renameSync;
 fs.renameSync=(src,dest)=>{if(src===f.dir)throw Error('injected archive failure');return rename(src,dest);};
 let result;try{result=f.r.resume(f.dir);}finally{fs.renameSync=rename;}
 assert.equal(result.recovery_required,false);assert.equal(result.complete,false);assert.match(result.warnings.join(' '),/archive failure/);assert.equal(f.load().phase,phase.startsWith('restored')?'restored_complete':'upgrade_complete');assert.equal(f.load().cleanupPending,true);assert.ok(!f.calls.includes('stop'));assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
 f.calls.length=0;const resumed=f.r.resume(f.dir);assert.equal(resumed.complete,true);assert.deepEqual(f.calls,[]);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
});
test('A13: failed stop verification refuses physical replacement and service start',async t=>{
 const f=await fixture(t);change(f);const before=fs.readFileSync(f.db('comm-bridge/c4.db'));f.m.stop=()=>{f.calls.push('stop');throw Error('PM2 stop not confirmed');};const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/not confirmed/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.ok(!f.calls.includes('start'));
});
test('A29: initial journal without descriptor or snapshots aborts through trusted original readonly worker',async t=>{
 const f=await fixture(t);const descriptor=f.m.read(path.join(f.dir,'descriptor.json'));f.j.initialIdentity.workerPath=descriptor.workerPath;f.j.initialIdentity.workerHash=f.m.hash(descriptor.workerPath);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});fs.unlinkSync(path.join(f.dir,'descriptor.json'));fs.rmSync(f.snapshot.dbBackupDir,{recursive:true});
 const db=new Database(f.db('comm-bridge/c4.db'));db.pragma('journal_mode=WAL');db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(4,'pre-stop-commit');db.pragma('wal_checkpoint(TRUNCATE)');db.close();
 const result=f.r.resume(f.dir);assert.equal(result.stage,'aborted_before_install');assert.equal(result.recovery_required,false);const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=4').get().summary,'pre-stop-commit');read.close();
});
for(const action of ['terminal-write','marker-remove'])test(`A25: abort ${action} interruption stays isolated then continues without replacement`,async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});let first=true;const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 if(action==='terminal-write'){const real=f.m.update;f.m.update=(dir,j,changes={})=>{if(first&&changes.phase==='aborted_before_install'){first=false;throw Error('terminal fsync failed');}return real(dir,j,changes);};}
 else{const real=f.m.unmark;f.m.unmark=(...args)=>{if(first){first=false;throw Error('marker remove failed');}return real(...args);};}
 assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.m.discover(f.root).blocked,true);assert.ok(!f.calls.includes('start'));assert.equal(f.r.resume(f.dir).stage,'aborted_before_install');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade-archive/tx/rescue')));
});
test('A26: partial core restore skips verified completed members after interruption',async t=>{
 const f=await fixture(t);change(f);f.r.rescue(f.dir,f.j);const real=f.m.sync,seen=[];let crash=true;f.m.sync=(src,dest)=>{seen.push(path.basename(dest));real(src,dest);if(crash&&path.basename(dest)==='scheduler'){crash=false;throw Error('core-copy crash');}};
 assert.throws(()=>f.r.restoreCore(f.dir,f.j),/core-copy crash/);assert.equal(f.load().codeRestore['comm-bridge'].complete,true);seen.length=0;const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.deepEqual(seen,['scheduler','web-console']);
});
test('A27: failed new-code validation isolates then compensates once',async t=>{
 const f=await fixture(t);const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(8,'new-runtime-write');db.close();f.m.update(f.dir,f.j,{phase:'new_data_ready'});let first=true;f.m.verifyServices=()=>{f.calls.push('verify');if(first){first=false;throw Error('new runtime verification failed');}};
 const before=fs.readFileSync(f.db('comm-bridge/c4.db')),result=f.r.resume(f.dir);assert.equal(result.stage,'restored_complete');assert.equal(result.completed,true);assert.equal(f.calls.filter(c=>c==='stop').length,2);assert.deepEqual(fs.readFileSync(path.join(f.root,'.backup/self-upgrade-archive/tx/rescue/comm-bridge_c4.db')),before);const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT count(*) AS n FROM checkpoints').get().n,0);read.close();
});
test('A28: verified live finalizer group is terminated before compensation and blocker clears durably',async t=>{
 const f=await fixture(t);change(f);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 const execution={...f.m.identity(child.pid),nonce:'test-nonce'};f.m.update(f.dir,f.j,{finalizerLaunchIntent:{nonce:'test-nonce'},finalizerExecution:execution,finalizerExitUnconfirmed:true});
 const result=f.r.resume(f.dir);assert.equal(result.completed,true);const saved=f.m.read(path.join(f.root,'.backup/self-upgrade-archive/tx/journal.json'));assert.equal(saved.finalizerExitConfirmed,true);assert.equal(saved.finalizerExitUnconfirmed,false);assert.equal(require(path.join(f.root,'.backup/self-upgrade-archive/tx/finalizer.cjs')).members(child.pid).length,0);
});
test('A28: live group with conflicting leader identity is never signalled or restored',async t=>{
 const f=await fixture(t);change(f);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 f.m.update(f.dir,f.j,{finalizerLaunchIntent:{nonce:'test-nonce'},finalizerExecution:{...f.m.identity(child.pid),start:'wrong-start',nonce:'test-nonce'},finalizerExitUnconfirmed:true});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/identity conflict/);assert.equal(f.m.alive(f.m.identity(child.pid)),true);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.equal(f.load().finalizerExitUnconfirmed,true);
});
test('A28: missing trusted finalizer helper preserves isolation and current data',async t=>{
 const f=await fixture(t);change(f);f.m.update(f.dir,f.j,{finalizerLaunchIntent:{nonce:'test-nonce'},finalizerExitUnconfirmed:true});fs.unlinkSync(path.join(f.dir,'finalizer.cjs'));const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});
for(const installationIntent of [true,false])test(`unknown phase with installationIntent=${installationIntent} never restores or aborts`,async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'unknown-future-stage',installationIntent});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/unrecognized .* recovery phase/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.ok(!f.calls.includes('start'));assert.equal(f.m.discover(f.root).blocked,true);
});
test('ecosystem copy fsync failure cannot publish completed restore and retry is durable',async t=>{
 const f=await fixture(t),dest=path.join(f.root,'pm2/ecosystem.config.cjs'),backup=path.join(f.dir,'code/pm2/ecosystem.config.cjs');
 fs.mkdirSync(path.dirname(dest),{recursive:true});fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(dest,'new ecosystem');fs.writeFileSync(backup,'original ecosystem');f.j.initialIdentity.ecosystemHash=f.m.hash(backup);f.m.update(f.dir,f.j);
 const sync=fs.fsyncSync;let hit=false;fs.fsyncSync=function(fd){if(fs.readlinkSync('/proc/self/fd/'+fd)===dest){hit=true;throw Error('ecosystem file fsync failed');}return sync.call(this,fd);};
 try{assert.throws(()=>f.r.restoreCore(f.dir,f.j),/ecosystem file fsync failed/);}finally{fs.fsyncSync=sync;}
 assert.equal(hit,true);assert.notEqual(f.load().codeRestore.ecosystem?.complete,true);
 f.r.restoreCore(f.dir,f.j);assert.equal(f.load().codeRestore.ecosystem.complete,true);assert.equal(fs.readFileSync(dest,'utf8'),'original ecosystem');
});
test('verified abort reentry allows legitimate original-service writes after partial restart',async t=>{
 const f=await fixture(t);const checked=f.m.preflight(f.dir,f.j,null);f.m.update(f.dir,f.j,{installationIntent:false,phase:'prepared',stableDataEvidence:checked.databases.map(d=>d.logicalHash)});
 let first=true;f.m.start=()=>{f.calls.push('start');if(first){first=false;const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(11,'legitimate partially restarted service write');db.close();throw Error('another original service failed to restart');}};
 const interrupted=f.r.resume(f.dir);assert.equal(interrupted.recovery_required,true);assert.equal(f.load().resumePhase,'aborted_before_install');
 const result=f.r.resume(f.dir);assert.equal(result.stage,'aborted_before_install');assert.equal(result.recovery_required,false);assert.equal(result.attempted,false);
 const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=11').get().summary,'legitimate partially restarted service write');read.close();assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade-archive/tx/rescue')));
});
test('originally missing ecosystem is removed only with durable matching creation provenance',async t=>{
 const f=await fixture(t),dest=path.join(f.root,'pm2/ecosystem.config.cjs');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'failed upgrade created ecosystem',{mode:0o600});
 f.j.initialIdentity.ecosystemHash=null;f.j.ecosystemCreationIntent={target:dest,originalMissing:true,intendedHash:f.m.hash(dest)};f.m.update(f.dir,f.j);f.r.restoreCore(f.dir,f.j);
 assert.equal(fs.existsSync(dest),false);assert.deepEqual(f.load().codeRestore.ecosystem,{complete:true,missing:true});assert.doesNotThrow(()=>f.r.restoreCore(f.dir,f.j));
});
for(const changed of [false,true])test(`unknown or changed new ecosystem provenance preserves file (changed=${changed})`,async t=>{
 const f=await fixture(t),dest=path.join(f.root,'pm2/ecosystem.config.cjs');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'unattributed ecosystem',{mode:0o600});f.j.initialIdentity.ecosystemHash=null;
 if(changed){f.j.ecosystemCreationIntent={target:dest,originalMissing:true,intendedHash:f.m.hash(dest)};fs.appendFileSync(dest,' externally changed');}
 f.m.update(f.dir,f.j);const before=fs.readFileSync(dest);assert.throws(()=>f.r.restoreCore(f.dir,f.j),changed?/creation hash changed/:/provenance unknown/);assert.deepEqual(fs.readFileSync(dest),before);assert.notEqual(f.load().codeRestore.ecosystem?.complete,true);
});
for(const postReady of [false,true])test(postReady?'explicit new-finalizer failure after data-ready compensates instead of revalidating new data':'A21: default protected pipeline compensates when actual old-finalizer child rejects v2 state after npm starts',async t=>{
 const f=await fixture(t);f.m.unmark(f.root,f.j);fs.rmSync(f.dir,{recursive:true});fs.rmSync(path.join(f.root,'.backup/db'),{recursive:true});
 const incoming=path.join(f.root,'incoming-package');fs.mkdirSync(path.join(incoming,'skills'),{recursive:true});fs.writeFileSync(path.join(incoming,'package.json'),'{"version":"2.0.0"}');
 for(const item of CORE_DATABASES)fs.mkdirSync(path.join(incoming,'skills',item.owner),{recursive:true});
 const bin=path.join(f.root,'fixture-bin');fs.mkdirSync(bin);const pm2=path.join(bin,'pm2');fs.writeFileSync(pm2,'#!/bin/sh\nif [ "$1" = "jlist" ]; then printf "[]\\n"; fi\n',{mode:0o700});
 const old=path.join(f.root,'old-finalizer.cjs');fs.writeFileSync(old,postReady?`const fs=require('node:fs'),path=require('node:path');const s=JSON.parse(fs.readFileSync(process.argv[2]));const m=require(path.join(${JSON.stringify(path.join(f.root,'.zylos/upgrade'))},'maintenance.cjs'));const j=m.read(path.join(s.transactionDir,'journal.json'));m.update(s.transactionDir,j,{phase:'new_data_ready'});m.unmark(j.zylosDir,j);process.stdout.write(JSON.stringify({success:false,failedStep:11,error:'old finalizer rejects schemaVersion=2 after data-ready',steps:[]}));process.exitCode=1;`:"const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.argv[2]));if(s.schemaVersion!==1){process.stdout.write(JSON.stringify({success:false,failedStep:5,error:'old finalizer rejects schemaVersion='+s.schemaVersion,steps:[]}));process.exitCode=1;}else process.exitCode=2;\n");
 const priorPath=process.env.PATH,priorRoot=process.env.ZYLOS_DIR;process.env.PATH=bin+path.delimiter+priorPath;process.env.ZYLOS_DIR=f.root;
 let npmStarted=false,result;const originalDb=new Database(f.db('comm-bridge/c4.db'),{readonly:true}),before=logicalHash(originalDb);originalDb.close();
 try{const {runSelfUpgrade,createFinalizeState}=await import('../self-upgrade.js');result=runSelfUpgrade({tempDir:incoming,newVersion:'2.0.0'},{zylosDir:f.root,skillsDir:f.j.skillsDir,getCurrentVersion:()=>({success:true,version:'1.0.0'}),step3:{verifyBoot:()=>({verified:true,fixture:true})},step4:{execSync:command=>{npmStarted=true;if(command.startsWith('npm pack'))return 'fixture.tgz\n';const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(99,'new-install-generation');db.close();return '';}},runInstalledFinalizer:ctx=>{const state=createFinalizeState(ctx);assert.equal(state.schemaVersion,2);assert.equal(ctx.journal.installationIntent,true);const stateFile=path.join(f.root,'old-state.json');fs.writeFileSync(stateFile,JSON.stringify(state));const child=spawnSync(process.execPath,[old,stateFile],{encoding:'utf8'});assert.equal(child.status,1);return JSON.parse(child.stdout);}});}finally{process.env.PATH=priorPath;if(priorRoot===undefined)delete process.env.ZYLOS_DIR;else process.env.ZYLOS_DIR=priorRoot;}
 assert.equal(npmStarted,true);assert.equal(result.success,false);assert.match(result.error,/old finalizer rejects schemaVersion=2/);assert.equal(result.rollback.attempted,true,JSON.stringify(result.rollback));assert.equal(result.rollback.completed,true,JSON.stringify(result.rollback));assert.equal(result.rollback.stage,'restored_complete');assert.equal(result.recovery_required,false);const restoredDb=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(logicalHash(restoredDb),before);restoredDb.close();const archive=path.join(f.root,'.backup/self-upgrade-archive');assert.equal(fs.readdirSync(archive).length,1);const saved=f.m.read(path.join(archive,fs.readdirSync(archive)[0],'journal.json'));assert.equal(saved.installationIntent,true);assert.equal(saved.phase,'restored_complete');
});
test('terminal archive rename followed by fsync failure is rediscovered through cleanup pointer and resumed',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});const rename=fs.renameSync,sync=fs.fsyncSync;let renamed=false,failed=false;
 fs.renameSync=(src,dest)=>{const out=rename(src,dest);if(src===f.dir)renamed=true;return out;};fs.fsyncSync=fd=>{if(renamed&&!failed&&fs.readlinkSync('/proc/self/fd/'+fd)===path.dirname(f.dir)){failed=true;throw Error('archive parent fsync interruption');}return sync(fd);};
 let result;try{result=f.r.resume(f.dir);}finally{fs.renameSync=rename;fs.fsyncSync=sync;}
 assert.equal(result.recovery_required,false);assert.equal(result.complete,false);assert.match(result.warnings.join(' '),/fsync interruption/);const found=f.m.discover(f.root);assert.equal(found.diagnostics.length,0);assert.equal(found.candidates.length,1);assert.equal(found.candidates[0].archived,true);f.calls.length=0;assert.equal(f.r.resume(found.candidates[0].dir).complete,true);assert.deepEqual(f.calls,[]);assert.ok(!fs.existsSync(path.join(f.root,'.zylos/upgrade/cleanup.json')));assert.equal(f.m.discover(f.root).candidates.length,0);
});
for(const archived of [false,true])test(`${archived?'archived':'active'} verified terminal finalizer blocker is checked before cleanup; confirmed reentry resumes services without DB replacement`,async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:true,markerRemoved:true,servicesRestored:true}});f.m.unmark(f.root,f.j);
 const dir=archived?f.m.archive(f.dir,f.j):f.dir,child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 const identity=f.m.identity(child.pid);f.m.update(dir,f.j,{finalizerLaunchIntent:{nonce:'test-nonce'},finalizerExecution:{...identity,start:'conflicting-start',nonce:'test-nonce'},finalizerExitUnconfirmed:true,archiveServicesStopped:true});f.m.durable(path.join(f.root,'.zylos/upgrade/cleanup.json'),{formatVersion:1,transactionId:'tx'});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 assert.equal(f.m.discover(f.root).blocked,true);const blocked=f.r.resume(dir);assert.equal(blocked.recovery_required,true);assert.equal(f.m.read(path.join(dir,'journal.json')).phase,'restored_complete');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));assert.equal(f.m.alive(identity),true);assert.equal(f.m.discover(f.root).candidates.length,1);
 const saved=f.m.read(path.join(dir,'journal.json'));f.m.update(dir,saved,{finalizerExecution:{...identity,nonce:'test-nonce'}});f.calls.length=0;const resumed=f.r.resume(dir);assert.equal(resumed.completed,true);assert.equal(resumed.recovery_required,false);assert.deepEqual(f.calls,['start','verify']);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade-archive/tx/rescue')));assert.equal(f.m.discover(f.root).blocked,false);assert.ok(!fs.existsSync(path.join(f.root,'.zylos/upgrade/cleanup.json')));
});
test('archived nonterminal cannot become restore input even with a valid copied descriptor',async t=>{
 const f=await fixture(t),dest=path.join(f.root,'.backup/self-upgrade-archive/tx');fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.renameSync(f.dir,dest);const before=fs.readFileSync(f.db('comm-bridge/c4.db'));assert.throws(()=>f.r.resume(dest),/unverified archived transaction/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.deepEqual(f.calls,[]);
});
test('archived terminal service validation failure retains normal writes and retries verification without compensation',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:true,markerRemoved:true,servicesRestored:true}});f.m.unmark(f.root,f.j);const dir=f.m.archive(f.dir,f.j);f.m.update(dir,f.j,{archiveServicesStopped:true});f.m.durable(path.join(f.root,'.zylos/upgrade/cleanup.json'),{formatVersion:1,transactionId:'tx'});
 let first=true;f.m.start=()=>{f.calls.push('start');if(first){const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(73,'restarted-original-service-write');db.close();}};f.m.verifyServices=()=>{f.calls.push('verify');if(first){first=false;throw Error('archive service validation failed');}};
 const blocked=f.r.resume(dir);assert.equal(blocked.recovery_required,true);assert.equal(f.m.read(path.join(dir,'journal.json')).phase,'restored_complete');assert.equal(f.m.discover(f.root).blocked,true);assert.ok(!fs.existsSync(path.join(dir,'rescue')));assert.equal(f.r.resume(dir).completed,true);const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=73').get().summary,'restarted-original-service-write');read.close();assert.equal(f.m.discover(f.root).blocked,false);
});
test('early abort refuses altered original CLI tree before service restart or database writes',async t=>{
 const f=await fixture(t),cli=path.join(f.root,'original-cli');fs.mkdirSync(cli,{mode:0o700});fs.writeFileSync(path.join(cli,'command.js'),'original',{mode:0o600});f.j.initialIdentity.cliRoot=cli;f.j.initialIdentity.cliHash=f.m.treeHash(cli);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});fs.writeFileSync(path.join(cli,'command.js'),'changed',{mode:0o600});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/original installed CLI identity changed/);assert.ok(!f.calls.includes('start'));assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
});
for(const conflict of [false,true])test(`orphan installer group ${conflict?'conflict preserves current data':'is terminated before compensation'}`,async t=>{
 const f=await fixture(t);change(f);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});const execution=f.m.identity(child.pid);
 f.m.update(f.dir,f.j,{installerLaunchIntent:{nonce:'installer-test-nonce'},installerExecution:{...execution,...(conflict?{start:'conflicting-start'}:{}),nonce:'installer-test-nonce'},installerExitUnconfirmed:true});const before=fs.readFileSync(f.db('comm-bridge/c4.db')),result=f.r.resume(f.dir);
 if(conflict){assert.equal(result.recovery_required,true);assert.match(result.error,/identity conflict/);assert.equal(f.m.alive(execution),true);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));assert.equal(f.load().installerExitUnconfirmed,true);}
 else{assert.equal(result.completed,true);const saved=f.m.read(path.join(f.root,'.backup/self-upgrade-archive/tx/journal.json'));assert.equal(saved.installerExitConfirmed,true);assert.equal(saved.installerExitUnconfirmed,false);assert.equal(require(path.join(f.root,'.backup/self-upgrade-archive/tx/finalizer.cjs')).members(child.pid).length,0);}
});
test('archived installer blocker cannot bypass process containment through terminal cleanup',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:true,markerRemoved:true,servicesRestored:true}});f.m.unmark(f.root,f.j);const dir=f.m.archive(f.dir,f.j),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});const execution=f.m.identity(child.pid);
 f.m.update(dir,f.j,{installerLaunchIntent:{nonce:'installer-test-nonce'},installerExecution:{...execution,start:'conflicting-start',nonce:'installer-test-nonce'},installerExitUnconfirmed:true});f.m.durable(path.join(f.root,'.zylos/upgrade/cleanup.json'),{formatVersion:1,transactionId:'tx'});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));assert.equal(f.m.discover(f.root).blocked,true);assert.equal(f.r.resume(dir).recovery_required,true);assert.equal(f.m.alive(execution),true);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.equal(f.m.read(path.join(dir,'journal.json')).phase,'restored_complete');
 const saved=f.m.read(path.join(dir,'journal.json'));f.m.update(dir,saved,{installerExecution:{...execution,nonce:'installer-test-nonce'}});assert.equal(f.r.resume(dir).completed,true);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.equal(f.m.discover(f.root).blocked,false);assert.ok(!fs.existsSync(path.join(dir,'rescue')));
});
for(const dangling of [false,true])test(`original CLI ${dangling?'dangling':'live'} symlink prevents preinstall abort provenance`,async t=>{
 const f=await fixture(t),cli=path.join(f.root,'original-cli'),outside=path.join(f.root,'outside.js');fs.mkdirSync(cli,{mode:0o700});if(!dangling)fs.writeFileSync(outside,'fixture',{mode:0o600});fs.symlinkSync(outside,path.join(cli,'linked.js'));f.j.initialIdentity.cliRoot=cli;f.j.initialIdentity.cliHash=f.m.treeHash(cli);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});const before=fs.readFileSync(f.db('comm-bridge/c4.db')),result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/CLI symlink rejected/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});
