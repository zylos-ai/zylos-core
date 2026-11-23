import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { copyDashboardDb, applyDashboardRegistration, migrateTakeoverDashboardDb } from '../dashboard-install.js';
import Database from '../../../skills/comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../../../skills/dashboard/src/lib/store.js';
import { TARGET_SCHEMA_VERSION } from '../../../skills/dashboard/src/lib/schema.js';
import { migrateSchema13 } from '../../../skills/dashboard/__tests__/fixtures/schema13.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const MANAGED_PID=43210;
const BOOT_ID='b7abed88-ae31-4f20-a515-64fa8278b8ee';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-install-'));
 const bin=path.join(dir,'bin'), data=path.join(dir,'components/dashboard'), code=path.join(dir,'.claude/skills/dashboard');
 for(const p of [bin,data,path.dirname(code),path.join(dir,'http'),path.join(dir,'pm2')])fs.mkdirSync(p,{recursive:true});
 fs.symlinkSync(path.join(root,'skills/dashboard'),code,'dir');
 fs.writeFileSync(path.join(data,'health-process.json'),JSON.stringify({pid:MANAGED_PID,bootId:BOOT_ID}),{mode:0o600});
 fs.copyFileSync(path.join(root,'templates/pm2/ecosystem.config.cjs'),path.join(dir,'pm2/ecosystem.config.cjs'));
 const prior=Object.fromEntries(['PATH','HOME','PM2_HOME','TMPDIR'].map(key=>[key,process.env[key]]));
 for(const key of ['HOME','PM2_HOME','TMPDIR']){process.env[key]=path.join(dir,key.toLowerCase());fs.mkdirSync(process.env[key]);}
 process.env.PATH=bin+path.delimiter+prior.PATH;
 fs.writeFileSync(path.join(bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const root=process.env.ZYLOS_DIR;const args=process.argv.slice(2);fs.appendFileSync(path.join(root,'pm2-calls'),JSON.stringify(args)+'\\n');if(args[0]==='jlist'){const code=path.join(root,'.claude/skills/dashboard');console.log(JSON.stringify([{name:'zylos-dashboard',pid:${MANAGED_PID},pm2_env:{status:'online',pm_exec_path:path.join(code,'src/index.js'),pm_cwd:code}}]));}`,{mode:0o755});
 // A package scope for the fake binaries keeps their syntax unambiguous.
 fs.writeFileSync(path.join(bin,'package.json'),' {"type":"module"}');
 fs.writeFileSync(path.join(bin,'caddy'),`#!${process.execPath}\nprocess.exit(0);`,{mode:0o755});
 fs.writeFileSync(path.join(dir,'http/Caddyfile'),'http://localhost {\n}\n');
 t.after(()=>{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,data,code,bin};
}
// First takeover: a legacy standalone Dashboard database is migrated here, before
// the service starts, with the cutoff copy as rollback material.
function legacyDashboard(data, {failAt}={}) {
 const file=path.join(data,'dashboard.db'), db=new Database(file);
 migrateSchema13(db);
 db.exec("INSERT INTO runtime_events(id,ingest_id,event_seq,timestamp,event_type,category) VALUES('retained','retained',1,'2026-01-01','prompt','activity')");
 if(failAt)db.exec(`CREATE TRIGGER reject_migration BEFORE INSERT ON schema_migrations WHEN NEW.version=${failAt} BEGIN SELECT RAISE(ABORT,'fixture migration failed'); END;`);
 db.close();
 return file;
}
const pm2Starts=dir=>fs.existsSync(path.join(dir,'pm2-calls'))?fs.readFileSync(path.join(dir,'pm2-calls'),'utf8').split('\n').filter(l=>l.includes('"start"')).length:0;
const version=file=>{const db=new Database(file,{readonly:true});try{return db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;}finally{db.close();}};
test('first takeover migrates a legacy Dashboard database before starting the service',t=>{
 const {dir,data}=fixture(t),tx=path.join(dir,'tx');
 const file=legacyDashboard(data);
 assert.throws(()=>new Store(file),error=>error.code==='SCHEMA_UPGRADE_REQUIRED');
 assert.equal(copyDashboardDb(dir,tx).ok,true);
 assert.deepEqual(applyDashboardRegistration({zylosDir:dir,transactionDir:tx}),{state:'done'});
 assert.equal(pm2Starts(dir),1);
 assert.equal(version(file),TARGET_SCHEMA_VERSION);
 const store=new Store(file);
 try{assert.equal(store.db.prepare('SELECT id FROM runtime_events').get().id,'retained');}finally{store.close();}
 // A retried registration sees a current database and changes nothing.
 assert.deepEqual(migrateTakeoverDashboardDb({zylosDir:dir,transactionDir:tx}),{state:'unchanged'});
});
test('a failed takeover migration restores the cutoff copy and does not start the service',t=>{
 const {dir,data}=fixture(t),tx=path.join(dir,'tx');
 const file=legacyDashboard(data,{failAt:TARGET_SCHEMA_VERSION});
 assert.equal(copyDashboardDb(dir,tx).ok,true);
 const copy=fs.readFileSync(path.join(tx,'dashboard/db-copy/dashboard.db'));
 const result=applyDashboardRegistration({zylosDir:dir,transactionDir:tx});
 assert.equal(result.state,'failed');
 assert.equal(result.error.code,'dashboard_migration_failed');
 assert.match(result.error.message,/restored from the takeover copy/);
 assert.match(result.error.message,/fixture migration failed/);
 assert.equal(pm2Starts(dir),0);
 assert.ok(fs.readFileSync(file).equals(copy), `${file} changed`);
 for(const suffix of ['-wal','-shm'])assert.equal(fs.existsSync(file+suffix),false);
 assert.equal(version(file),13);
});
test('takeover refuses to migrate a legacy Dashboard database without the cutoff copy',t=>{
 const {dir,data}=fixture(t),tx=path.join(dir,'tx');
 const file=legacyDashboard(data),before=fs.readFileSync(file);
 for(const transactionDir of [undefined,tx]){
  const result=applyDashboardRegistration({zylosDir:dir,transactionDir});
  assert.equal(result.state,'failed');
  assert.equal(result.error.code,'dashboard_migration_failed');
  assert.match(result.error.message,/copy is missing; the database was not migrated/);
 }
 assert.equal(pm2Starts(dir),0);
 assert.ok(fs.readFileSync(file).equals(before), `${file} changed`);
 assert.equal(version(file),13);
});
test('registration preserves the original password and live session credentials',async t=>{
 const {dir,data}=fixture(t);
 const {Store}=await import('../../../skills/dashboard/src/lib/store.js');
 const {AuthGate,hashPassword}=await import('../../../skills/dashboard/src/lib/auth.js');
 const originalConfig={auth:{enabled:true,password:hashPassword('original-fixture-password')}};
 const bytes=JSON.stringify(originalConfig);
 fs.writeFileSync(path.join(data,'config.json'),bytes);
 const store=new Store(path.join(data,'dashboard.db'));
 const gate=new AuthGate(originalConfig,store);
 const server=http.createServer(async(req,res)=>{
   if(await gate.handle(req,res,new URL(req.url,'http://localhost')))return;
   res.setHeader('content-type','application/json');res.end('{"originalSession":true}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));clearInterval(gate._cleanupTimer);store.close();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const login=()=>fetch(origin+'/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','X-Forwarded-Prefix':'/private-observer'},body:new URLSearchParams({password:'original-fixture-password'}),redirect:'manual'});
 const originalLogin=await login();assert.equal(originalLogin.status,302);
 const cookie=originalLogin.headers.get('set-cookie').split(';')[0];
 const sessionsBefore=store.db.prepare('SELECT token_hash,created_at FROM auth_sessions').all();
 assert.equal(applyDashboardRegistration({zylosDir:dir}).state,'done');
 assert.equal(fs.readFileSync(path.join(data,'config.json'),'utf8'),bytes);
 assert.deepEqual(store.db.prepare('SELECT token_hash,created_at FROM auth_sessions').all(),sessionsBefore);
 const retained=await fetch(origin+'/api/instance',{headers:{cookie}});
 assert.equal(retained.status,200);assert.deepEqual(await retained.json(),{originalSession:true});
 assert.equal((await login()).status,302);
});


test('post-install failure retains safe exit diagnostics without forwarding secret output',t=>{
 const f=fixture(t);
 fs.unlinkSync(f.code);fs.mkdirSync(path.join(f.code,'hooks'),{recursive:true});
 fs.writeFileSync(path.join(f.code,'package.json'),'{"type":"module"}');
 fs.writeFileSync(path.join(f.code,'hooks/post-install.js'),"console.error('Error: SECRET-FIXTURE-CREDENTIAL');console.log('SECRET-FIXTURE-CREDENTIAL');process.exit(17);");
 const result=applyDashboardRegistration({zylosDir:f.dir});
 assert.equal(result.state,'failed');assert.match(result.error.message,/exit 17/);
 assert.equal(JSON.stringify(result).includes('SECRET-FIXTURE-CREDENTIAL'),false);
 assert.equal(fs.existsSync(path.join(f.dir,'pm2-calls')),false);
});
