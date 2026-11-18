import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {runUpgradeEntry} from '../../cli/lib/upgrade-entry.js';
import {recovery, maintenance} from '../../cli/lib/upgrade-protection.js';
const [root, scenario, megabytes] = process.argv.slice(2);
const repo = path.resolve(import.meta.dirname, '../..');
const env = process.env;
for (const key of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TMUX_TMPDIR']) assert.ok(fs.realpathSync(env[key]).startsWith(root + '/'), key);
const installed = path.join(root, 'prefix/lib/node_modules/zylos'), target=path.join(root,'target');
const skills = path.join(env.ZYLOS_DIR,'.claude/skills');
fs.mkdirSync(path.join(root,'prefix/bin'),{recursive:true});
const cp = (from,to) => fs.cpSync(from,to,{recursive:true,filter:file=>!['node_modules','__tests__'].includes(path.basename(file))});
for (const directory of [installed,target]) {
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'zylos',version:'1.0.0-beta.12',type:'module'}));
  cp(path.join(repo,'cli'),path.join(directory,'cli'));
  for (const name of ['comm-bridge','scheduler']) cp(path.join(repo,'skills',name),path.join(directory,'skills',name));
  const owner=path.join(directory,'skills/dashboard/src/lib/schema-owner.js');
  fs.mkdirSync(path.dirname(owner),{recursive:true});
  fs.copyFileSync(path.join(repo,'test/fixtures/upgrade-dashboard-owner.js'),owner);
  fs.writeFileSync(path.join(directory,'skills/dashboard/package.json'),'{"type":"module"}\n');
}
cp(path.join(installed,'skills'),skills);
const driverDir=path.dirname(createRequire(path.join(repo,'skills/comm-bridge/package.json')).resolve('better-sqlite3/package.json'));
const req=createRequire(path.join(driverDir,'package.json'));
const Database=req(driverDir);
const modules=path.join(skills,'comm-bridge/node_modules');fs.mkdirSync(modules);
for(const name of ['better-sqlite3','bindings','file-uri-to-path']) fs.symlinkSync(path.dirname(req.resolve(name+'/package.json')),path.join(modules,name));
fs.writeFileSync(path.join(env.HOME,'.npmrc'),'prefix='+path.join(root,'prefix')+'\n');
const database=path.join(env.ZYLOS_DIR,'components/dashboard/dashboard.db');
fs.mkdirSync(path.dirname(database),{recursive:true});
let db=new Database(database);
db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES ('+(scenario==='unchanged'?21:20)+'); CREATE TABLE payload(data BLOB); CREATE TABLE writer_ticks(ticks INTEGER); INSERT INTO writer_ticks VALUES(0)');
const insert=db.prepare('INSERT INTO payload VALUES (zeroblob(1048576))');
db.transaction(()=>{for(let n=0;n<Number(megabytes);n++)insert.run();})();
const bytes=fs.statSync(database).size;
if(Number(megabytes)===1024)assert.ok(bytes>=1024**3);
db.close();
// Present current schemas make the ordinary branch genuinely migration-free.
const engine=await import(path.join(repo,'skills/comm-bridge/scripts/sqlite-schema.js'));
for(const [name,file] of [['comm-bridge','c4.db'],['scheduler','scheduler.db']]) {
  const owner=await import(path.join(repo,'skills',name,'scripts',name==='comm-bridge'?'c4-schema.js':'schema.js'));
  fs.mkdirSync(path.join(env.ZYLOS_DIR,name),{recursive:true});
  db=new Database(path.join(env.ZYLOS_DIR,name,file));
  engine.migrateDatabase(db, owner, {allowNew:true, strict:false});db.close();
}
const pm2=(...args)=>execFileSync('pm2',args,{encoding:'utf8',timeout:15000});
const records=()=>maintenance.services({skillsDir:skills});
const writer=path.join(skills,'dashboard/writer.mjs');
fs.copyFileSync(path.join(repo,'test/fixtures/upgrade-dashboard-writer.js'),writer);
fs.mkdirSync(path.join(skills,'custom'),{recursive:true});
const idle=path.join(skills,'custom/idle.js');fs.writeFileSync(idle,'setInterval(()=>{},1000);\n');
env.UPGRADE_DRIVER=driverDir;env.UPGRADE_READY=path.join(root,'writer-ready');
pm2('start',writer,'--name','zylos-dashboard','--cwd',root);
pm2('start',idle,'--name','fixture-online','--cwd',root);
pm2('start',idle,'--name','fixture-stopped','--cwd',root);pm2('stop','fixture-stopped');
const deadline=Date.now()+15000;
while(!fs.existsSync(env.UPGRADE_READY)) {if(Date.now()>deadline)throw Error('writer did not start');await new Promise(r=>setTimeout(r,25));}
await new Promise(r=>setTimeout(r,100));
db=new Database(database);const ticks=db.prepare('SELECT ticks FROM writer_ticks').get().ticks;db.close();assert.ok(ticks>0);
if(scenario==='failure-stopped')pm2('stop','zylos-dashboard');
for(const p of records())assert.ok(p.script.startsWith(skills+'/'));
let context, reachedInstall=false;
const result=await runUpgradeEntry({schemaVersion:1,fromVersion:'1.0.0-beta.12',installedRoot:installed,tempDir:target,zylosDir:env.ZYLOS_DIR},{
  install(ctx) {
    context=ctx;reachedInstall=true;
    assert.ok(records().every(p=>p.status==='stopped'&&p.pid===0));
    assert.equal(ctx.journal.phase,'prepared');
    assert.equal(ctx.journal.installationIntent,false);
    assert.ok(fs.existsSync(path.join(ctx.dbBackupDir,'manifest.json')));
    throw Error('fixture stops before package installation');
  },
  recover(ctx) {context=ctx;return recovery(ctx);},
});
assert.equal(result.success,false);assert.equal(result.recovery_required,false,JSON.stringify(result));
const failure=scenario.startsWith('failure');
assert.equal(reachedInstall,!failure,JSON.stringify(result));
if(failure)assert.match(result.error,/fixture migration refuses incompatible data/);
else assert.match(result.error,/fixture stops before package installation/);
const events=fs.existsSync(env.UPGRADE_EVENTS)?fs.readFileSync(env.UPGRADE_EVENTS,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
assert.equal(events.length,scenario==='unchanged'?0:1);
for(const e of events){assert.equal(e.phase,'offline');assert.equal(e.installationIntent,false);}
const state=records();
for(const [name,status] of [['fixture-online','online'],['fixture-stopped','stopped'],['zylos-dashboard',scenario==='failure-stopped'?'stopped':'online']])assert.equal(state.find(p=>p.name===name)?.status,status,JSON.stringify(state));
assert.equal(fs.existsSync(path.join(env.ZYLOS_DIR,'.backup/db/.rehearsal')),false);
assert.equal(context.journal.installationIntent,false);
assert.equal(context.journal.dashboardWasStopped,scenario==='failure-stopped');
process.stdout.write(JSON.stringify({scenario,bytes,writerTransactions:ticks,reachedInstall,events,restored:state.map(({name,status})=>({name,status})),rollback:result.rollback})+'\n');
