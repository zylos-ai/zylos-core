import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {CORE_DATABASES,createCoreDbSnapshot,prepareRecoveryDependencies} from '../core-db-backup.js';
import {upgradeStartupPrompt} from '../runtime/upgrade-context.js';

const require=createRequire(import.meta.url);
const Database=require(path.resolve('skills/comm-bridge/node_modules/better-sqlite3'));
// Each test loads private copies of the real recovery and maintenance modules.
// Only service calls are replaced: database/native worker, hashes, journal,
// rescue, rename intents, isolation discovery, and terminal marker removal are real.
async function fixture(t,{missing=false,wal=false}={}) {
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
  db.pragma('user_version=1');if(wal)db.pragma('journal_mode=WAL');db.close();
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

for(const legacy of ['group-writable','backup-alias'])test(`completed upgrade permits ordinary owners after retained materials become ${legacy}`,async t=>{
 const f=await fixture(t);
 f.m.update(f.dir,f.j,{phase:'new_data_ready'});
 const result=f.r.resume(f.dir);
 assert.equal(result.stage,'upgrade_complete',JSON.stringify(result));
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')),false);
 assert.equal(f.load().terminalEvidence.verified,true);
 // Deploy the actual owner openers only after code verification has finished.
 for(const item of CORE_DATABASES)fs.cpSync(path.resolve('skills',item.owner,'scripts'),path.join(f.j.skillsDir,item.owner,'scripts'),{recursive:true});
 const monitor=path.join(f.j.skillsDir,'activity-monitor');fs.mkdirSync(path.join(monitor,'scripts'),{recursive:true});
 fs.writeFileSync(path.join(monitor,'package.json'),'{"type":"module"}');
 fs.copyFileSync(path.resolve('skills/activity-monitor/scripts/shard-registry.js'),path.join(monitor,'scripts/shard-registry.js'));
 if(legacy==='group-writable') {
  const shared=file=>{const stat=fs.lstatSync(file);if(stat.isSymbolicLink())return;fs.chmodSync(file,stat.mode|0o020);if(stat.isDirectory())for(const name of fs.readdirSync(file))shared(path.join(file,name));};
  shared(path.join(f.root,'.zylos'));shared(path.join(f.root,'.backup'));
 } else {
  fs.renameSync(path.join(f.root,'.backup'),path.join(f.root,'retained-backup'));
  fs.symlinkSync(path.join(f.root,'retained-backup'),path.join(f.root,'.backup'));
 }
 const discovery=f.m.discover(f.root);assert.equal(discovery.blocked,false);assert.deepEqual(discovery.diagnostics,[]);assert.deepEqual(discovery.candidates,[]);
 assert.equal(upgradeStartupPrompt(f.root),null);
 const runner=path.join(f.root,'open-owners.mjs');
 fs.writeFileSync(runner,`import assert from 'node:assert/strict';
 import {getDb,close} from './.claude/skills/comm-bridge/scripts/c4-db.js';
 import {getDb as scheduler} from './.claude/skills/scheduler/scripts/database.js';
 import {openDb} from './.claude/skills/web-console/scripts/db.js';
 for(const open of [getDb,scheduler,openDb]){const db=open();assert.equal(db.pragma('user_version',{simple:true}),1);db.close();}
 close();`);
 const alias=path.join(f.root,'deployment-alias');fs.symlinkSync(f.root,alias);
 for(const deploymentRoot of [f.root,alias]) {
  const opened=spawnSync(process.execPath,[runner],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:deploymentRoot}});
  assert.equal(opened.status,0,opened.stderr);
 }
 const hook=path.join(f.j.skillsDir,'comm-bridge/scripts/c4-session-init.js');
 const checkpoint=spawnSync(process.execPath,[hook],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:f.root}});
 assert.equal(checkpoint.status,0,checkpoint.stderr);assert.doesNotMatch(checkpoint.stdout,/UPGRADE RECOVERY TASK/);
});

test('A12/A14/A15: complete compensation restores old code/data, preserves rescue, removes sidecars and retains terminal materials',async t=>{
 const f=await fixture(t,{missing:true});change(f);fs.mkdirSync(path.dirname(f.db('scheduler/scheduler.db')),{recursive:true});fs.writeFileSync(f.db('scheduler/scheduler.db'),'new-db');
 const original=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.equal(result.stage,'restored_complete');assert.ok(!fs.existsSync(f.db('scheduler/scheduler.db')));assert.ok(!fs.existsSync(f.db('comm-bridge/c4.db-wal')));
 const archived=path.join(f.root,'.backup/self-upgrade/tx');assert.deepEqual(fs.readFileSync(path.join(archived,'rescue/comm-bridge_c4.db')),original);assert.equal(f.m.discover(f.root).blocked,false);assert.deepEqual(f.calls,['stop','start','verify']);
});
test('A14/A28: damaged snapshot is rejected before rescue or replacement',async t=>{
 const f=await fixture(t);change(f);const before=fs.readFileSync(f.db('comm-bridge/c4.db'));fs.appendFileSync(path.join(f.snapshot.dbBackupDir,f.snapshot.manifest.databases[0].file),'bad');
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/hash mismatch/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.ok(!f.calls.includes('start'));assert.equal(f.m.discover(f.root).blocked,true);
});
test('A26: crash after physical DB rename but before done journal resumes existing intent without recapturing rescue',async t=>{
 const f=await fixture(t);change(f);f.r.rescue(f.dir,f.j);f.r.restoreCore(f.dir,f.j);
 const real=f.m.renameIntent;let crashed=false;f.m.renameIntent=(dir,j,key,...args)=>{const result=real(dir,j,key,...args);if(!crashed&&key==='install_comm-bridge_c4.db'){crashed=true;j.actions[key].done=false;f.m.update(dir,j);throw Error('simulated power loss after install rename');}return result;};
 assert.throws(()=>f.r.replaceDatabases(f.dir,f.j,f.snapshot.manifest),/power loss/);const rescueHash=f.m.hash(path.join(f.dir,'rescue/comm-bridge_c4.db'));f.m.renameIntent=real;
 const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.equal(f.m.hash(path.join(f.root,'.backup/self-upgrade/tx/rescue/comm-bridge_c4.db')),rescueHash);
});
test('A26: partial rescue resumes recorded generation and refuses changed rescue evidence',async t=>{
 const f=await fixture(t);change(f);const real=f.m.renameIntent;let crashed=false;f.m.renameIntent=(dir,j,key,...args)=>{const result=real(dir,j,key,...args);if(!crashed&&key==='rescue_comm-bridge_c4.db'){crashed=true;throw Error('simulated crash');}return result;};assert.throws(()=>f.r.rescue(f.dir,f.j),/crash/);f.m.renameIntent=real;
 fs.appendFileSync(path.join(f.dir,'rescue/comm-bridge_c4.db'),'tampered');const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/rescue hash conflict/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});
for(const phase of ['new_data_ready','restored_data_ready','new_verifying','restored_verifying'])test(`A16/A27: ${phase} resumes validation and retains valid normal writes`,async t=>{
 const f=await fixture(t);const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(7,'normal-write');db.close();f.m.update(f.dir,f.j,{phase});
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,false);assert.ok(!f.calls.includes('stop'));const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=7').get().summary,'normal-write');read.close();assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade/tx/rescue')));
});
test('A27: restored verification failure isolates without a second database replacement',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));f.m.verifyServices=()=>{throw Error('service failed');};
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.equal(f.load().resumePhase,'restored_verifying');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.equal(f.m.discover(f.root).blocked,true);
});
test('A28: unconfirmed finalizer exit keeps current generation isolated',async t=>{
 const f=await fixture(t);change(f);f.m.update(f.dir,f.j,{finalizerExitUnconfirmed:true});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/interrupted launch/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});
test('A24/A29: trusted preinstall abort verifies original data without snapshot restore',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.stage,'aborted_before_install',JSON.stringify(result));assert.equal(result.attempted,false);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade/tx/rescue')));assert.equal(f.m.discover(f.root).blocked,false);
});
test('R3: group-writable original npm CLI root permits verified preinstall abort',async t=>{
 const f=await fixture(t);fs.chmodSync(f.j.initialIdentity.cliRoot,0o775);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);
 assert.equal(result.stage,'aborted_before_install',JSON.stringify(result));assert.equal(result.recovery_required,false);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.equal(f.m.discover(f.root).blocked,false);
});
test('A25: interrupted original service restart only resumes verified abort cleanup',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});let first=true;f.m.start=()=>{f.calls.push('start');if(first){first=false;throw Error('start interrupted');}};
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.load().resumePhase,'aborted_before_install');assert.equal(f.m.discover(f.root).blocked,true);assert.equal(f.r.resume(f.dir).stage,'aborted_before_install');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
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
 else{const real=fs.unlinkSync;t.after(()=>{fs.unlinkSync=real;});fs.unlinkSync=file=>{if(first&&file===path.join(f.root,'.zylos/upgrade/active.json')){first=false;throw Error('marker remove failed');}return real(file);};}
 assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.m.discover(f.root).blocked,action==='terminal-write');if(action==='terminal-write')assert.ok(!f.calls.includes('start'));else assert.ok(f.calls.includes('start'));assert.equal(f.r.resume(f.dir).stage,'aborted_before_install');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade/tx/rescue')));
});
test('A26: partial core restore skips verified completed members after interruption',async t=>{
 const f=await fixture(t);change(f);f.r.rescue(f.dir,f.j);const real=f.m.sync,seen=[];let crash=true;f.m.sync=(src,dest)=>{seen.push(path.basename(dest));real(src,dest);if(crash&&path.basename(dest)==='scheduler'){crash=false;throw Error('core-copy crash');}};
 assert.throws(()=>f.r.restoreCore(f.dir,f.j),/core-copy crash/);assert.equal(f.load().codeRestore['comm-bridge'].complete,true);seen.length=0;const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.deepEqual(seen,['scheduler','web-console']);
});
test('A27: failed new-code validation isolates then compensates once',async t=>{
 const f=await fixture(t);const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(8,'new-runtime-write');db.close();f.m.update(f.dir,f.j,{phase:'new_data_ready'});let first=true;f.m.verifyServices=()=>{f.calls.push('verify');if(first){first=false;throw Error('new runtime verification failed');}};
 const before=fs.readFileSync(f.db('comm-bridge/c4.db')),result=f.r.resume(f.dir);assert.equal(result.stage,'restored_complete');assert.equal(result.completed,true);assert.equal(f.calls.filter(c=>c==='stop').length,2);assert.deepEqual(fs.readFileSync(path.join(f.root,'.backup/self-upgrade/tx/rescue/comm-bridge_c4.db')),before);const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT count(*) AS n FROM checkpoints').get().n,0);read.close();
});
test('A28: live finalizer blocks compensation until the process group has exited',async t=>{
 const f=await fixture(t);change(f);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 f.m.update(f.dir,f.j,{finalizerStarted:true,finalizerPid:child.pid,finalizerExitUnconfirmed:true});
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const blocked=f.r.resume(f.dir);
 assert.equal(blocked.recovery_required,true);assert.match(blocked.error,/still active/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
 const exited=new Promise(resolve=>child.once('exit',resolve));process.kill(-child.pid,'SIGKILL');await exited;
 const result=f.r.resume(f.dir);assert.equal(result.completed,true);const saved=f.load();assert.equal(saved.finalizerExitConfirmed,true);assert.equal(saved.finalizerExitUnconfirmed,false);
});
test('A28: interrupted finalizer launch without a PID preserves current data',async t=>{
 const f=await fixture(t);change(f);f.m.update(f.dir,f.j,{finalizerStarted:true,finalizerPid:null,finalizerExitUnconfirmed:true});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/interrupted launch/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.equal(f.load().finalizerExitUnconfirmed,true);
});
test('A28: missing trusted finalizer helper preserves isolation and current data',async t=>{
 const f=await fixture(t);change(f);f.m.update(f.dir,f.j,{finalizerStarted:true,finalizerPid:null,finalizerExitUnconfirmed:true});fs.unlinkSync(path.join(f.dir,'finalizer.cjs'));const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
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
 const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=11').get().summary,'legitimate partially restarted service write');read.close();assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade/tx/rescue')));
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
 let npmStarted=false,result;const originalDb=new Database(f.db('comm-bridge/c4.db'),{readonly:true}),before=originalDb.prepare('SELECT * FROM checkpoints ORDER BY id').all();originalDb.close();
 try{const {runSelfUpgrade,createFinalizeState}=await import('../self-upgrade.js');result=runSelfUpgrade({tempDir:incoming,newVersion:'2.0.0'},{zylosDir:f.root,skillsDir:f.j.skillsDir,getCurrentVersion:()=>({success:true,version:'1.0.0'}),step3:{verifyBoot:()=>({verified:true,fixture:true})},step4:{execSync:command=>{npmStarted=true;if(command.startsWith('npm pack'))return 'fixture.tgz\n';const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(99,'new-install-generation');db.close();return '';}},runInstalledFinalizer:ctx=>{const state=createFinalizeState(ctx);assert.equal(state.schemaVersion,2);assert.equal(ctx.journal.installationIntent,true);const stateFile=path.join(f.root,'old-state.json');fs.writeFileSync(stateFile,JSON.stringify(state));const child=spawnSync(process.execPath,[old,stateFile],{encoding:'utf8'});assert.equal(child.status,1);return JSON.parse(child.stdout);}});}finally{process.env.PATH=priorPath;if(priorRoot===undefined)delete process.env.ZYLOS_DIR;else process.env.ZYLOS_DIR=priorRoot;}
 assert.equal(npmStarted,true);assert.equal(result.success,false);assert.match(result.error,/old finalizer rejects schemaVersion=2/);assert.equal(result.rollback.attempted,true,JSON.stringify(result.rollback));assert.equal(result.rollback.completed,true,JSON.stringify(result.rollback));assert.equal(result.rollback.stage,'restored_complete');assert.equal(result.recovery_required,false);const restoredDb=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.deepEqual(restoredDb.prepare('SELECT * FROM checkpoints ORDER BY id').all(),before);restoredDb.close();const archive=path.join(f.root,'.backup/self-upgrade');assert.equal(fs.readdirSync(archive).length,1);const saved=f.m.read(path.join(archive,fs.readdirSync(archive)[0],'journal.json'));assert.equal(saved.installationIntent,true);assert.equal(saved.phase,'restored_complete');
});
test('early abort refuses altered original CLI tree before service restart or database writes',async t=>{
 const f=await fixture(t),cli=path.join(f.root,'original-cli');fs.mkdirSync(cli,{mode:0o700});fs.writeFileSync(path.join(cli,'command.js'),'original',{mode:0o600});f.j.initialIdentity.cliRoot=cli;f.j.initialIdentity.cliHash=f.m.treeHash(cli);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});fs.writeFileSync(path.join(cli,'command.js'),'changed',{mode:0o600});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/original installed CLI identity changed/);assert.ok(!f.calls.includes('start'));assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
});
test('orphan installer blocks compensation until its process group has exited',async t=>{
 const f=await fixture(t);change(f);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 f.m.update(f.dir,f.j,{installerStarted:true,installerPid:child.pid,installerExitUnconfirmed:true});const before=fs.readFileSync(f.db('comm-bridge/c4.db')),result=f.r.resume(f.dir);
 assert.equal(result.recovery_required,true);assert.match(result.error,/still active/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));assert.equal(f.load().installerExitUnconfirmed,true);
 const exited=new Promise(resolve=>child.once('exit',resolve));process.kill(-child.pid,'SIGKILL');await exited;
 assert.equal(f.r.resume(f.dir).completed,true);assert.equal(f.load().installerExitConfirmed,true);assert.equal(f.load().installerExitUnconfirmed,false);
});
for(const dangling of [false,true])test(`original CLI ${dangling?'dangling':'live'} symlink prevents preinstall abort provenance`,async t=>{
 const f=await fixture(t),cli=path.join(f.root,'original-cli'),outside=path.join(f.root,'outside.js');fs.mkdirSync(cli,{mode:0o700});if(!dangling)fs.writeFileSync(outside,'fixture',{mode:0o600});fs.symlinkSync(outside,path.join(cli,'linked.js'));f.j.initialIdentity.cliRoot=cli;f.j.initialIdentity.cliHash=f.m.treeHash(cli);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});const before=fs.readFileSync(f.db('comm-bridge/c4.db')),result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/CLI symlink rejected/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});

test('resume uses phase durably changed before controller acquisition instead of stale pre-lock journal', async t => {
  const f = await fixture(t);
  change(f);
  const before = fs.readFileSync(f.db('comm-bridge/c4.db'));
  const acquire = f.m.acquire;
  f.m.acquire = (dir, ...args) => {
    // Model another controller finishing data restoration before ownership is
    // acquired. The new ready phase must validate normal writes, not restore.
    const latest = f.m.read(path.join(dir, 'journal.json'));
    f.m.update(dir, latest, {phase:'restored_data_ready'});
    return acquire(dir, ...args);
  };
  const result = f.r.resume(f.dir);
  assert.equal(result.stage, 'restored_complete');
  assert.equal(result.recovery_required, false);
  assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')), before);
  assert.deepEqual(f.calls, ['start', 'verify']);
  assert.equal(fs.existsSync(path.join(f.root, '.backup/self-upgrade/tx/rescue')), false);
});
test('journal deployment identity changed before acquisition is rejected without writing or starting services', async t => {
  const f = await fixture(t);
  const acquire = f.m.acquire;
  f.m.acquire = (dir, ...args) => {
    const release = acquire(dir, ...args);
    const latest = f.m.read(path.join(dir, 'journal.json'));
    f.m.update(dir, latest, {zylosDir:path.join(f.root, 'redirected')});
    return release;
  };
  assert.throws(() => f.r.resume(f.dir), /invalid journal identity/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.load().phase, 'installing');
  assert.equal(fs.existsSync(path.join(f.root, 'redirected')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'controller.json')), false);
});
test('resume through deployment root alias validates canonical journal identity under lock', async t => {
  const f = await fixture(t);
  f.m.update(f.dir, f.j, {phase:'restored_data_ready'});
  const alias = f.root + '-alias';
  fs.symlinkSync(f.root, alias);
  t.after(() => fs.unlinkSync(alias));
  const result = f.r.resume(path.join(alias, '.backup/self-upgrade/tx'));
  assert.equal(result.stage, 'restored_complete');
  assert.equal(result.recovery_required, false);
  assert.deepEqual(f.calls, ['start', 'verify']);
});
test('restored WAL-mode snapshot remains resumable after readonly preflight and interrupted READY publication', async t => {
  const f = await fixture(t, {wal:true});
  change(f);
  let interrupted = false;
  const update = f.m.update;
  f.m.update = (dir, j, changes={}) => {
    if (!interrupted && changes.phase==='restored_data_ready') {
      interrupted=true;
      throw Error('READY publication interrupted after readonly preflight');
    }
    return update(dir, j, changes);
  };
  const first = f.r.resume(f.dir);
  assert.equal(first.recovery_required, true);
  assert.match(first.error, /READY publication interrupted/);
  assert.equal(f.load().resumePhase, 'installing');
  const second = f.r.resume(f.dir);
  assert.equal(second.stage, 'restored_complete', JSON.stringify(second));
  assert.equal(second.recovery_required, false);
});
test('preinstall readonly verification still includes committed uncheckpointed original WAL data', async t => {
  const f = await fixture(t, {wal:true});
  const writer = new Database(f.db('comm-bridge/c4.db'));
  t.after(() => {if(writer.open)writer.close();});
  writer.pragma('wal_autocheckpoint=0');
  writer.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(82, 'committed-live-WAL');
  assert.ok(fs.statSync(f.db('comm-bridge/c4.db-wal')).size > 0);
  f.m.update(f.dir, f.j, {installationIntent:false, phase:'preparing'});
  const result = f.r.resume(f.dir);
  assert.equal(result.stage, 'aborted_before_install', JSON.stringify(result));
  assert.equal(result.recovery_required, false);
  assert.equal(writer.prepare('SELECT summary FROM checkpoints WHERE id=82').get().summary, 'committed-live-WAL');
});

for(const phase of ['new_data_ready','restored_data_ready']) test(`${phase}: terminal marker clear failure retries without replacing committed data`, async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const unlink=fs.unlinkSync;let first=true;t.after(()=>{fs.unlinkSync=unlink;});
 fs.unlinkSync=file=>{if(first&&file===path.join(f.root,'.zylos/upgrade/active.json')){first=false;throw Error('terminal marker clear failed');}return unlink(file);};
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/marker clear failed/);
 assert.equal(f.load().phase,phase.startsWith('restored')?'restored_complete':'upgrade_complete');
 assert.equal(f.m.discover(f.root).blocked,false);assert.equal(f.m.discover(f.root).candidates.length,1);assert.ok(!f.calls.includes('stop'));
 f.calls.length=0;assert.equal(f.r.resume(f.dir).complete,true);assert.deepEqual(f.calls,[]);
 assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(fs.existsSync(f.dir));
 assert.equal(fs.existsSync(path.join(f.root,'.backup/self-upgrade-archive')),false);
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/cleanup.json')),false);
 assert.equal(f.m.discover(f.root).candidates.length,0);
});
test('terminal marker unlink followed by fsync interruption recreates the marker and resumes in place', async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});const unlink=fs.unlinkSync,sync=fs.fsyncSync;let removed=false,first=true;
 t.after(()=>{fs.unlinkSync=unlink;fs.fsyncSync=sync;});
 fs.unlinkSync=file=>{const value=unlink(file);if(file===path.join(f.root,'.zylos/upgrade/active.json'))removed=true;return value;};
 fs.fsyncSync=fd=>{if(removed&&first){first=false;throw Error('marker directory fsync interrupted');}return sync(fd);};
 assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.m.discover(f.root).blocked,false);
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')),true);
 f.calls.length=0;assert.equal(f.r.resume(f.dir).complete,true);assert.deepEqual(f.calls,[]);assert.ok(fs.existsSync(f.dir));
});
for(const phase of ['new_data_ready','restored_data_ready']) test(`${phase}: terminal journal write failure resumes verification without compensation`, async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase});const update=f.m.update;let first=true;
 f.m.update=(dir,j,changes={})=>{if(first&&changes.phase?.endsWith('_complete')){first=false;throw Error('terminal journal fsync failed');}return update(dir,j,changes);};
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));assert.equal(f.r.resume(f.dir).recovery_required,true);
 assert.equal(f.load().resumePhase,phase.startsWith('restored')?'restored_verifying':'new_verifying');
 assert.equal(f.m.discover(f.root).blocked,true);assert.equal(f.r.resume(f.dir).recovery_required,false);
 assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.equal(fs.existsSync(path.join(f.dir,'rescue')),false);
});
test('terminal marker is removed only after original services and durable terminal journal validate', async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});const start=f.m.start,verify=f.m.verifyServices,unlink=fs.unlinkSync;t.after(()=>{fs.unlinkSync=unlink;});
 f.m.start=j=>{assert.ok(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')));assert.equal(f.m.discover(f.root).blocked,false);return start(j);};
 f.m.verifyServices=j=>{assert.ok(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')));return verify(j);};
 fs.unlinkSync=file=>{if(file===path.join(f.root,'.zylos/upgrade/active.json')){assert.equal(f.m.terminalValid(f.load()),true);assert.deepEqual(f.calls,['start','verify']);}return unlink(file);};
 assert.equal(f.r.resume(f.dir).recovery_required,false);assert.ok(fs.existsSync(f.dir));assert.equal(f.m.discover(f.root).candidates.length,0);
});
test('terminal directory remains in place and explicit repeat resume performs no service or DB work', async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});assert.equal(f.r.resume(f.dir).completed,true);
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));f.calls.length=0;
 assert.equal(f.r.resume(f.dir).completed,true);assert.deepEqual(f.calls,[]);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
 assert.equal(f.m.discover(f.root).candidates.length,0);assert.ok(fs.existsSync(path.join(f.dir,'descriptor.json')));
});

test('verified terminal with stopped services retries startup without database compensation', async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});assert.equal(f.r.resume(f.dir).completed,true);
 const terminal=f.load();f.m.update(f.dir,terminal,{terminalServicesStopped:true});f.m.marker(f.root,f.dir,terminal);
 const start=f.m.start;let first=true;f.m.start=j=>{start(j);if(first){first=false;const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(74,'partially restarted service write');db.close();throw Error('terminal startup interrupted');}};
 f.calls.length=0;assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.load().phase,'restored_complete');assert.equal(f.load().terminalServicesStopped,true);
 assert.equal(f.m.discover(f.root).blocked,false);assert.equal(f.m.discover(f.root).candidates.length,1);
 f.calls.length=0;assert.equal(f.r.resume(f.dir).completed,true);assert.deepEqual(f.calls,['start','verify']);assert.equal(f.load().terminalServicesStopped,false);
 const db=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(db.prepare('SELECT summary FROM checkpoints WHERE id=74').get().summary,'partially restarted service write');db.close();assert.equal(fs.existsSync(path.join(f.dir,'rescue')),false);
});
