import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {migrateDatabase} from '../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../skills/comm-bridge/scripts/c4-schema.js';
import * as schedulerSchema from '../../skills/scheduler/scripts/schema.js';

const [root,scenario]=process.argv.slice(2), repo=path.resolve(import.meta.dirname,'../..');
const reservation=net.createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
const dashboardPort=reservation.address().port;assert.notEqual(dashboardPort,3470);await new Promise(resolve=>reservation.close(resolve));
const z=process.env.ZYLOS_DIR, home=process.env.HOME, bin=path.join(root,'b'), prefix=path.join(root,'n');
const core=path.join(prefix,'lib/node_modules/zylos'), target=path.join(root,'release');
const pm2=fs.realpathSync(process.env.ZYLOS_ACCEPTANCE_PM2);
const sourceModules=fs.realpathSync(path.join(repo,'node_modules'));
const sqliteModules=fs.realpathSync(path.join(repo,'skills/comm-bridge/node_modules'));
const modules=path.join(core,'node_modules'), skills=path.join(z,'.claude/skills');
const npm=fs.realpathSync(path.join(path.dirname(process.execPath),'npm'));
const env={...process.env,PATH:[bin,path.join(prefix,'bin'),path.dirname(process.execPath),'/usr/bin','/bin'].join(':'),
  npm_config_prefix:prefix,npm_config_cache:path.join(root,'cache'),npm_config_offline:'true',
  npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false',
  ZYLOS_PACKAGE_ROOT:core,NO_COLOR:'1',ZYLOS_GH_RETRY_DELAY_MS:''};
console.log('Exact child isolation:',JSON.stringify({cwd:root,env,pm2,core,skills,database:path.join(z,'comm-bridge/c4.db'),socket:path.join(root,'t/s')}));
for(const k of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR']) assert.ok(env[k].startsWith(root+'/'));
const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
const run=(exe,args,{failure=false,...options}={})=>{
 const r=spawnSync(exe,args,{env,cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8<<20,...options});
 assert.equal(r.error,undefined,r.error?.message);if(!failure)assert.equal(r.status,0,`${exe} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);return r;
};
const copySource=dest=>fs.cpSync(repo,dest,{recursive:true,dereference:false,filter:file=>!path.relative(repo,file).split(path.sep).some(p=>['.git','node_modules','test','__tests__','.env','.npmrc'].includes(p))});
const copyModules=dest=>{fs.mkdirSync(dest,{recursive:true});for(const name of ['dotenv','js-yaml','argparse','smol-toml'])fs.cpSync(path.join(sourceModules,name),path.join(dest,name),{recursive:true,dereference:true});fs.cpSync(sqliteModules,dest,{recursive:true,dereference:true});const f=path.join(dest,'better-sqlite3/package.json');const p=JSON.parse(fs.readFileSync(f));p.files.push('build/Release/better_sqlite3.node');write(f,JSON.stringify(p));};
const metadata=dir=>{
 for(const entry of fs.readdirSync(path.join(dir,'skills'),{withFileTypes:true})) {
  const f=path.join(dir,'skills',entry.name,'package.json');if(!fs.existsSync(f))continue;
  const p=JSON.parse(fs.readFileSync(f));delete p.dependencies;delete p.devDependencies;write(f,JSON.stringify(p));
 }
};
fs.mkdirSync(bin);copySource(core);metadata(core);copyModules(modules);
fs.cpSync(path.join(core,'skills'),skills,{recursive:true});
copyModules(path.join(skills,'comm-bridge/node_modules'));copyModules(path.join(skills,'dashboard/node_modules'));
assert.ok(path.isAbsolute(process.env.ZYLOS_ACCEPTANCE_DASHBOARD_MODULES || ''),'provide preprovisioned Dashboard dependencies');
fs.cpSync(fs.realpathSync(process.env.ZYLOS_ACCEPTANCE_DASHBOARD_MODULES),path.join(skills,'dashboard/node_modules'),{recursive:true,dereference:true});
const original=JSON.parse(fs.readFileSync(path.join(core,'package.json'))).version;
copySource(target);metadata(target);
const pkg=JSON.parse(fs.readFileSync(path.join(target,'package.json')));pkg.version='1.0.0-beta.999';delete pkg.devDependencies;
pkg.bundleDependencies=Object.keys(pkg.dependencies);write(path.join(target,'package.json'),JSON.stringify(pkg));
fs.rmSync(path.join(target,'package-lock.json'),{force:true});
copyModules(path.join(target,'node_modules'));
fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});fs.symlinkSync(path.join(core,'cli/zylos.js'),path.join(prefix,'bin/zylos'));
fs.symlinkSync(npm,path.join(bin,'npm'));
write(path.join(bin,'claude'),'#!/bin/sh\nprintf "2.1.0 (Claude Code)\\n"\n');
write(path.join(bin,'codex'),'#!/bin/sh\nprintf "codex-cli 0.50.0\\n"\n');
write(path.join(bin,'tmux'),`#!/bin/sh\nexec /usr/bin/tmux -S '${root}/t/s' "$@"\n`);
const flag=path.join(root,'race');
write(path.join(bin,'pm2'),`#!${process.execPath}\nconst {spawnSync}=require('node:child_process'),fs=require('node:fs');const a=process.argv.slice(2);let r=spawnSync(${JSON.stringify(pm2)},a,{stdio:'inherit',env:process.env});if(r.status===0&&a[0]==='stop'&&a[1]==='fixture-extra'&&fs.existsSync(${JSON.stringify(flag)})){r=spawnSync(${JSON.stringify(pm2)},['restart','fixture-extra'],{stdio:'inherit',env:process.env});}process.exit(r.status??1);\n`);
const archive=path.join(root,'release.tar.gz');
// Core dependencies are deliberately bundled in the download too.
run('tar',['czf',archive,'-C',root,'release']);
write(path.join(bin,'curl'),`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2),url=a.at(-1);if(url==='https://api.github.com/repos/zylos-ai/zylos-core/tags?per_page=100'){process.stdout.write(JSON.stringify([{name:'v1.0.0-beta.999'}]));}else if(url.endsWith('/archive/refs/tags/v1.0.0-beta.999.tar.gz')&&a.includes('-o')){fs.copyFileSync(${JSON.stringify(archive)},a[a.indexOf('-o')+1]);}else{console.error('Forbidden nonfixture URL: '+url);process.exit(90);}\n`);
for(const name of fs.readdirSync(bin))if(name!=='npm')fs.chmodSync(path.join(bin,name),0o700);
write(path.join(z,'.zylos/config.json'),'{"runtime":"claude","session_mode":"single"}\n');
write(path.join(z,'.claude/settings.json'),'{}');write(path.join(z,'ZYLOS.md'),'# Private acceptance fixture\n');
write(path.join(z,'components/dashboard/config.json'),JSON.stringify({host:'127.0.0.1',port:dashboardPort,auth:{enabled:false},observer:{enabled:false}}));
assert.equal(JSON.parse(fs.readFileSync(path.join(z,'components/dashboard/config.json'))).port,dashboardPort);
const dashboardScript=path.join(skills,'dashboard/src/index.js');
write(path.join(z,'pm2/ecosystem.config.cjs'),'module.exports='+JSON.stringify({apps:[{name:'zylos-dashboard',script:dashboardScript,cwd:path.dirname(path.dirname(dashboardScript)),env:{HOME:home,ZYLOS_DIR:z,PM2_HOME:env.PM2_HOME,PATH:env.PATH,ZYLOS_PACKAGE_ROOT:core},autorestart:true}]})+';\n');
console.log('Private Dashboard target:',JSON.stringify({config:path.join(z,'components/dashboard/config.json'),port:dashboardPort,script:dashboardScript,pm2Home:env.PM2_HOME}));
const Database=createRequire(path.join(core,'package.json'))('better-sqlite3');
for(const [rel,owner]of [['comm-bridge/c4.db',c4Schema],['scheduler/scheduler.db',schedulerSchema]]){
 const file=path.join(z,rel);fs.mkdirSync(path.dirname(file),{recursive:true});const db=new Database(file);migrateDatabase(db,owner,{allowNew:true,strict:false});db.close();
}
const retired=path.join(z,'web-console/web-console.db');fs.mkdirSync(path.dirname(retired),{recursive:true});
{const db=new Database(retired);db.exec("CREATE TABLE retained(value TEXT);INSERT INTO retained VALUES ('opaque retired database')");db.close();}
const retiredBytes=fs.readFileSync(retired);
const c4=()=>{const db=new Database(path.join(z,'comm-bridge/c4.db'));const result=db.prepare('PRAGMA integrity_check').get();db.close();assert.equal(result.integrity_check,'ok');};
const extra=path.join(skills,'private-extra/service.cjs');write(extra,'setInterval(()=>{},1000);\n');
run(pm2,['start',path.join(z,'pm2/ecosystem.config.cjs')]);
write(path.join(env.PM2_HOME,'module_conf.json'),JSON.stringify({'module-db-v2':{'pm2-logrotate':{fixture:true}}}));
run(pm2,['start',extra,'--name','fixture-extra','--cwd',root]);
const listing=()=>{const s=run(pm2,['jlist']).stdout;return JSON.parse(s.slice(s.search(/(?:^|\n)\s*\[(?:\s*\{|\s*\])/)));};
assert.equal(listing().find(p=>p.name==='fixture-extra').pm2_env.HOME,home);
const {verifyDashboard}=await import('../../cli/lib/dashboard-install.js');
const priorEnv={...process.env};Object.assign(process.env,env);try{const ready=await verifyDashboard({zylosDir:z});assert.equal(ready.state,'ready',JSON.stringify(ready));}finally{for(const k of Object.keys(process.env))if(!Object.hasOwn(priorEnv,k))delete process.env[k];Object.assign(process.env,priorEnv);}
const packed=JSON.parse(run(process.execPath,[npm,'pack','--dry-run','--json'],{cwd:target}).stdout);assert.ok(packed[0].files.some(f=>f.path==='node_modules/better-sqlite3/build/Release/better_sqlite3.node'),'fixture archive must preserve native SQLite addon');
const evidence=process.env.ZYLOS_ACCEPTANCE_EVIDENCE;
const record=(name,value)=>{if(evidence){fs.mkdirSync(evidence,{recursive:true});write(path.join(evidence,scenario+'-'+name+'.json'),JSON.stringify(value,null,2));}};
const cli=(...args)=>run(process.execPath,[path.join(core,'cli/zylos.js'),...args],{failure:true,timeout:240000});
try{
 if(scenario==='stop-race'){assert.equal(fs.existsSync(path.join(skills,'web-console')),false);assert.equal(fs.existsSync(path.join(core,'skills/web-console')),false);}
 if(scenario==='stop-race')write(flag,'restart on every stop');
 const result=cli('upgrade','--self','--version','1.0.0-beta.999','--yes','--json');record('upgrade',result);
 const rows=result.stdout.trim().split('\n').flatMap(s=>{try{return[JSON.parse(s)];}catch{return[];}});
 const report=rows.findLast(r=>typeof r.success==='boolean');assert.ok(report,`${result.stdout}\n${result.stderr}`);
 if(scenario==='stop-race'){
  assert.equal(result.status,1);assert.equal(report.success,false);
  assert.match(report.error,/managed services not confirmed stopped: fixture-extra \(status=online, pid=\d+\)/);
  assert.equal(report.code,'UPGRADE_FAILED');assert.doesNotMatch(report.error,/Cannot find module/);
  const journalRoot=path.join(z,'.backup/self-upgrade');const journalFile=fs.readdirSync(journalRoot).map(n=>path.join(journalRoot,n,'journal.json')).find(f=>fs.existsSync(f));
  const journal=JSON.parse(fs.readFileSync(journalFile));assert.equal(journal.initialIdentity.databases.find(d=>d.source==='web-console/web-console.db').exists,true);record('journal',journal);
  assert.equal(report.recovery_required,false);assert.equal(report.rollback.stage,'aborted_before_install');assert.deepEqual(fs.readFileSync(retired),retiredBytes);
  fs.rmSync(flag);assert.equal(fs.existsSync(path.join(z,'.zylos/upgrade/active.json')),false);const resumed=cli('recovery','resume');record('resume',resumed);assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);assert.deepEqual(JSON.parse(resumed.stdout),{active:false,blocked:false});
  assert.equal(JSON.parse(fs.readFileSync(path.join(core,'package.json'))).version,original);
  assert.deepEqual(fs.readFileSync(retired),retiredBytes);
 }else{assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(report.success,true);assert.equal(report.dashboard?.state,'ready',JSON.stringify(report.dashboard));assert.doesNotMatch(JSON.stringify(report),/Could not locate the bindings|Cannot find module|ENOTCACHED/);assert.deepEqual(report.warnings,[]);
 const native=run(process.execPath,[path.join(import.meta.dirname,'private-sqlite-open.mjs'),path.join(core,'package.json')]);assert.equal(native.stdout.trim(),'1');assert.equal(JSON.parse(fs.readFileSync(path.join(core,'package.json'))).version,pkg.version);}
 const p=listing().find(p=>p.name==='fixture-extra');assert.equal(p.pm2_env.status,'online');assert.ok(p.pid>0);c4();
 const intake=run(process.execPath,[path.join(skills,'comm-bridge/scripts/c4-receive.js'),'--no-reply','--content','private acceptance after recovery','--json']);record('c4-intake',intake);
 const db=new Database(path.join(z,'comm-bridge/c4.db'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE content LIKE ?').get('%private acceptance after recovery%').n,1);db.close();
 record('outcome',{success:true,exclusions:['skill dependency downloads','npm install lifecycle scripts','authenticated runtime and C4 delivery'],original,target:pkg.version,dashboardPort,dashboardConfig:path.join(z,'components/dashboard/config.json'),report,service:{name:p.name,pid:p.pid,status:p.pm2_env.status},retiredBytesPreserved:fs.existsSync(retired)&&fs.readFileSync(retired).equals(retiredBytes)});
 console.log(JSON.stringify({scenario,success:true,error:report.error,version:JSON.parse(fs.readFileSync(path.join(core,'package.json'))).version}));
}finally{try{run(pm2,['kill']);}finally{run('/usr/bin/tmux',['-S',path.join(root,'t/s'),'kill-server'],{failure:true});}}
