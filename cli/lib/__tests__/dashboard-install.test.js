import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { copyDashboardDb, applyDashboardRegistration, applyDashboardRoute, verifyDashboard, restoreDashboardService, migrateTakeoverDashboardDb } from '../dashboard-install.js';
import Database from '../../../skills/comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../../../skills/dashboard/src/lib/store.js';
import { TARGET_SCHEMA_VERSION } from '../../../skills/dashboard/src/lib/schema.js';
import { migrateSchema13 } from '../../../skills/dashboard/__tests__/fixtures/schema13.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const MANAGED_PID=43210;
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-install-'));
 const bin=path.join(dir,'bin'), data=path.join(dir,'components/dashboard'), code=path.join(dir,'.claude/skills/dashboard');
 for(const p of [bin,data,path.dirname(code),path.join(dir,'http'),path.join(dir,'pm2')])fs.mkdirSync(p,{recursive:true});
 fs.symlinkSync(path.join(root,'skills/dashboard'),code,'dir');
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
test('best-effort copy preserves old main/WAL/SHM/journal and missing does not create tx',t=>{
 const {dir,data}=fixture(t),tx=path.join(dir,'tx');
 assert.deepEqual(copyDashboardDb(dir,tx),{ok:true,error:null});assert.equal(fs.existsSync(tx),false);
 fs.writeFileSync(path.join(data,'dashboard.db-wal'),'orphan wal');
 fs.writeFileSync(path.join(data,'dashboard.db-shm'),'orphan shm');
 assert.deepEqual(copyDashboardDb(dir,tx),{ok:true,error:null});assert.equal(fs.existsSync(tx),false);
 assert.equal(fs.readFileSync(path.join(data,'dashboard.db-wal'),'utf8'),'orphan wal');
 // A hot -journal (Dashboard stopped mid-transaction) belongs to the copy too.
 for(const suffix of ['','-wal','-shm','-journal'])fs.writeFileSync(path.join(data,'dashboard.db'+suffix),'unchanged'+suffix);
 assert.equal(copyDashboardDb(dir,tx).ok,true);
 for(const suffix of ['','-wal','-shm','-journal'])assert.equal(fs.readFileSync(path.join(tx,'dashboard/db-copy/dashboard.db'+suffix),'utf8'),'unchanged'+suffix);
 assert.equal(fs.readFileSync(path.join(data,'dashboard.db'),'utf8'),'unchanged');
});
test('registration uses one managed service, preserves config bytes, never installs hooks',t=>{
 const {dir,data}=fixture(t);const config=JSON.stringify({port:3999,auth:{enabled:true,password:'scrypt:fixture:fixture'},fleet:{agents:[]}});
 fs.writeFileSync(path.join(data,'config.json'),config);
 fs.writeFileSync(path.join(dir,'.claude/settings.json'),' {"hooks":{"Stop":[{"hooks":[{"command":"third-party"}]}]}}');
 assert.deepEqual(applyDashboardRegistration({zylosDir:dir}),{state:'done'});
 assert.deepEqual(applyDashboardRegistration({zylosDir:dir}),{state:'done'});
 assert.equal(fs.readFileSync(path.join(data,'config.json'),'utf8'),config);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'.claude/settings.json'))).hooks.Stop[0].hooks[0].command,'third-party');
 const calls=fs.readFileSync(path.join(dir,'pm2-calls'),'utf8');assert.equal(calls.split('\n').filter(l=>l.includes('"start"')).length,2);
});
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
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
for(const journal of ['wal','delete'])test(`a migration child killed mid-migration (${journal} journal) leaves no sidecar on the restored copy`,t=>{
 const {dir,data,code}=fixture(t),tx=path.join(dir,'tx');
 const file=legacyDashboard(data);
 {const db=new Database(file);db.pragma(`journal_mode = ${journal}`);db.close();}
 assert.equal(copyDashboardDb(dir,tx).ok,true);
 const copy=sha(path.join(tx,'dashboard/db-copy/dashboard.db'));
 // The installed Dashboard is replaced by a fixture schema module: the real
 // inspection, and a migration that writes and then dies without closing,
 // as a killed child would. WAL mode keeps committed frames in -wal; rollback
 // mode keeps a hot -journal.
 fs.unlinkSync(code);fs.mkdirSync(path.join(code,'src/lib'),{recursive:true});
 const driverDir=path.join(dir,'.claude/skills/comm-bridge/scripts');fs.mkdirSync(driverDir,{recursive:true});
 fs.symlinkSync(path.join(root,'skills/comm-bridge/scripts/sqlite-driver.js'),path.join(driverDir,'sqlite-driver.js'));
 fs.writeFileSync(path.join(code,'src/lib/schema.js'),`export {inspectDatabase} from ${JSON.stringify(pathToFileURL(path.join(root,'skills/dashboard/src/lib/schema.js')).href)};
export function migrateDatabase(db){
 db.pragma('wal_autocheckpoint = 0');
 if(${JSON.stringify(journal)}==='wal')db.exec("INSERT INTO schema_migrations(version) VALUES(14)");
 else {db.exec('BEGIN IMMEDIATE');db.exec("INSERT INTO schema_migrations(version) VALUES(14)");}
 process.kill(process.pid,'SIGKILL');
}`);
 assert.throws(()=>migrateTakeoverDashboardDb({zylosDir:dir,transactionDir:tx}),/restored from the takeover copy/);
 for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(file+suffix),false,suffix);
 assert.equal(sha(file),copy);
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
test('takeover leaves an absent or current Dashboard database alone',t=>{
 const {dir,data}=fixture(t);
 assert.deepEqual(migrateTakeoverDashboardDb({zylosDir:dir}),{state:'absent'});
 assert.equal(fs.existsSync(path.join(data,'dashboard.db')),false);
 new Store(path.join(data,'dashboard.db')).close();
 const before=fs.readFileSync(path.join(data,'dashboard.db'));
 assert.deepEqual(migrateTakeoverDashboardDb({zylosDir:dir}),{state:'unchanged'});
 assert.ok(fs.readFileSync(path.join(data,'dashboard.db')).equals(before), `${path.join(data,'dashboard.db')} changed`);
});
test('missing Caddy skips managed routing',t=>{
 const {dir,bin}=fixture(t);fs.unlinkSync(path.join(bin,'caddy'));
 assert.deepEqual(applyDashboardRoute({zylosDir:dir}),{state:'skipped'});
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
 const retained=await fetch(origin+'/api/state',{headers:{cookie}});
 assert.equal(retained.status,200);assert.deepEqual(await retained.json(),{originalSession:true});
 assert.equal((await login()).status,302);
});

test('restore checks actual registration after a failed start without registering or rerouting',t=>{
 const {dir,bin}=fixture(t);
 fs.writeFileSync(path.join(bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const root=process.env.ZYLOS_DIR;const args=process.argv.slice(2);fs.appendFileSync(path.join(root,'pm2-calls'),JSON.stringify(args)+'\\n');if(args[0]==='start')process.exit(1);if(args[0]==='jlist'){const code=path.join(root,'.claude/skills/dashboard');console.log(JSON.stringify([{name:'zylos-dashboard',pid:${MANAGED_PID},pm2_env:{status:'online',pm_exec_path:path.join(code,'src/index.js'),pm_cwd:code}}]));}`,{mode:0o755});
 const result=restoreDashboardService({zylosDir:dir});
 assert.equal(result.state,'done');
 assert.deepEqual(fs.readFileSync(path.join(dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse).map(a=>a[0]),['start','jlist','save']);
 assert.equal(fs.existsSync(path.join(dir,'pm2/ecosystem.config.cjs')),true);
});

function pm2Result(f, entries) {
 fs.writeFileSync(path.join(f.dir,'pm2-result.json'),JSON.stringify(entries));
 fs.writeFileSync(path.join(f.bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const root=process.env.ZYLOS_DIR;const args=process.argv.slice(2);fs.appendFileSync(path.join(root,'pm2-calls'),JSON.stringify(args)+'\\n');if(args[0]==='jlist')process.stdout.write(fs.readFileSync(path.join(root,'pm2-result.json')));`,{mode:0o755});
}
function pm2Sequence(f, results) {
 fs.writeFileSync(path.join(f.dir,'pm2-results.json'),JSON.stringify(results));
 fs.writeFileSync(path.join(f.bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const root=process.env.ZYLOS_DIR;const args=process.argv.slice(2);fs.appendFileSync(path.join(root,'pm2-calls'),JSON.stringify(args)+'\\n');if(args[0]==='jlist'){const file=path.join(root,'pm2-results.json');const results=JSON.parse(fs.readFileSync(file));const current=results.length>1?results.shift():results[0];fs.writeFileSync(file,JSON.stringify(results));console.log(JSON.stringify(current));}`,{mode:0o755});
}
function managedEntry(f) {
 return {name:'zylos-dashboard',pid:MANAGED_PID,pm2_env:{status:'online',pm_exec_path:path.join(f.code,'src/index.js'),pm_cwd:f.code}};
}
test('registration consumes Core ecosystem byte-for-byte and refuses a missing artifact',t=>{
 const f=fixture(t),ecosystem=path.join(f.dir,'pm2/ecosystem.config.cjs');
 const bytes=fs.readFileSync(ecosystem,'utf8')+'\n// user-owned custom setting\n';
 fs.writeFileSync(ecosystem,bytes);
 assert.equal(applyDashboardRegistration({zylosDir:f.dir}).state,'done');
 assert.equal(fs.readFileSync(ecosystem,'utf8'),bytes);
 fs.unlinkSync(ecosystem);
 const calls=fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8');
 assert.equal(applyDashboardRegistration({zylosDir:f.dir}).state,'failed');
 assert.equal(fs.existsSync(ecosystem),false);
 assert.equal(fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8'),calls);
});

test('registration rejects duplicate entries and does not persist them',t=>{
 const f=fixture(t),entry=managedEntry(f);pm2Result(f,[entry,entry]);
 const result=applyDashboardRegistration({zylosDir:f.dir});
 assert.equal(result.state,'failed');assert.equal(result.error.code,'registration_failed');
 const calls=fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls.map(a=>a[0]),['start','jlist']);
});

test('registration rejects wrong entry path and offline status',t=>{
 const f=fixture(t);
 for(const change of [{pm_exec_path:'/wrong/index.js'},{pm_cwd:'/wrong'},{status:'stopped'}]){
  const entry=managedEntry(f);Object.assign(entry.pm2_env,change);pm2Result(f,[entry]);
  assert.equal(applyDashboardRegistration({zylosDir:f.dir}).state,'failed');
 }
 const calls=fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(calls.some(a=>a[0]==='save'),false);
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

async function healthFixture(t, handler) {
 const f=fixture(t), requests=[];
 const server=http.createServer((req,res)=>{requests.push(req.url);handler(req,res,requests.length);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 fs.writeFileSync(path.join(f.data,'config.json'),JSON.stringify({port:server.address().port,auth:{enabled:true,password:'fixture-hash'}}));
 return {...f,server,requests};
}
function healthy(res, pid=MANAGED_PID) {res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:'zylos-dashboard',pid}));}

test('verification only reads local health without a public domain',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 fs.writeFileSync(path.join(f.data,'dashboard.db'),'unreadable bytes owned by the service');
 fs.writeFileSync(path.join(f.dir,'http/Caddyfile'),'# BEGIN zylos-component:dashboard\nmalformed route');
 const before=fs.readFileSync(path.join(f.data,'config.json'));
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.deepEqual(result,{state:'ready',checks:{health:true},errors:[]});
 assert.deepEqual(f.requests,['/api/health']);
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse),[['jlist']]);
 assert.equal(fs.readFileSync(path.join(f.data,'dashboard.db'),'utf8'),'unreadable bytes owned by the service');
 assert.deepEqual(fs.readFileSync(path.join(f.data,'config.json')),before);
});

test('verification polls local health until the service reports ready',async t=>{
 const f=await healthFixture(t,(_req,res,count)=>{if(count<3){res.writeHead(503);res.end('{"ok":false}');}else healthy(res);});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.state,'ready');assert.equal(f.requests.length,3);
});

test('verification recovers when the managed pid appears during the readiness window',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 const missing=managedEntry(f);delete missing.pid;
 pm2Sequence(f,[[missing],[managedEntry(f)]]);
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.state,'ready');assert.deepEqual(f.requests,['/api/health']);
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse),[['jlist'],['jlist']]);
});

test('verification follows a replaced managed process during the readiness window',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 const old=managedEntry(f);old.pid=MANAGED_PID-1;
 pm2Sequence(f,[[old],[managedEntry(f)]]);
 const publicRequests=[];
 const proxy=http.createServer((req,res)=>{publicRequests.push(req.url);healthy(res);});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
 fs.mkdirSync(path.join(f.dir,'.zylos'),{recursive:true});
 fs.writeFileSync(path.join(f.dir,'.zylos/config.json'),JSON.stringify({domain:'127.0.0.1',protocol:'https',port:proxy.address().port}));
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.deepEqual(result,{state:'ready',checks:{health:true,route:true},errors:[]});
 assert.deepEqual(f.requests,['/api/health','/api/health']);assert.deepEqual(publicRequests,['/dashboard/api/health']);
});

test('verification rejects health served by a different process',async t=>{
 let now=1000;
 const f=await healthFixture(t,(_req,res)=>{now+=30001;healthy(res,MANAGED_PID+1);});
 t.mock.method(Date,'now',()=>now);
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.state,'degraded');assert.equal(result.checks.health,false);
 assert.deepEqual(result.errors.map(error=>error.code),['health_failed']);
});

test('verification reports health failure after the readiness window when the managed pid stays unavailable',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 let now=1000;t.mock.method(Date,'now',()=>{now+=10001;return now;});
 const missing=managedEntry(f);delete missing.pid;
 const zero=managedEntry(f);zero.pid=0;
 const negative=managedEntry(f);negative.pid=-1;
 const fractional=managedEntry(f);fractional.pid=1.5;
 const string=managedEntry(f);string.pid=String(MANAGED_PID);
 const valid=managedEntry(f);
 const wrong={...valid,pm2_env:{...valid.pm2_env,pm_exec_path:'/other/dashboard/src/index.js'}};
 for(const entries of [[missing],[zero],[negative],[fractional],[string],[valid,{...valid}],[wrong]]){
  pm2Result(f,entries);
  const result=await verifyDashboard({zylosDir:f.dir});
  assert.equal(result.state,'degraded');assert.deepEqual(result.errors.map(error=>error.code),['health_failed']);
 }
 assert.deepEqual(f.requests,[]);
 pm2Result(f,[wrong,valid]);
 assert.equal((await verifyDashboard({zylosDir:f.dir})).state,'ready');
 assert.deepEqual(f.requests,['/api/health']);
});

test('verification waits for a delayed local listener',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 const port=f.server.address().port;
 await new Promise(resolve=>f.server.close(resolve));
 const timer=setTimeout(()=>f.server.listen(port,'127.0.0.1'),250);t.after(()=>clearTimeout(timer));
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.state,'ready');assert.deepEqual(f.requests,['/api/health']);
});

test('public verification makes one health request at the fixed Dashboard prefix',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 let publicReply='matching';const requests=[];
 const proxy=http.createServer((req,res)=>{
  requests.push(req.url);
  if(publicReply==='service-mismatch'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:'other',pid:MANAGED_PID}));}
  else healthy(res,publicReply==='matching'?MANAGED_PID:MANAGED_PID+1);
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
 fs.mkdirSync(path.join(f.dir,'.zylos'),{recursive:true});
 fs.writeFileSync(path.join(f.dir,'.zylos/config.json'),JSON.stringify({domain:'127.0.0.1',protocol:'https',port:proxy.address().port}));
 assert.deepEqual(await verifyDashboard({zylosDir:f.dir}),{state:'ready',checks:{health:true,route:true},errors:[]});
 assert.deepEqual(requests,['/dashboard/api/health']);
 publicReply='pid-mismatch';
 const failed=await verifyDashboard({zylosDir:f.dir});
 assert.equal(failed.state,'degraded');assert.equal(failed.checks.health,true);assert.equal(failed.checks.route,false);
 assert.equal(failed.errors[0].code,'route_failed');assert.equal(requests.length,2);
 publicReply='service-mismatch';
 const wrongService=await verifyDashboard({zylosDir:f.dir});
 assert.equal(wrongService.state,'degraded');assert.equal(wrongService.errors[0].code,'route_failed');assert.equal(requests.length,3);
});

function redirectFixture(t, { protocol = 'http', replies }) {
 const f=fixture(t), requests=[];
 fs.mkdirSync(path.join(f.dir,'.zylos'),{recursive:true});
 fs.writeFileSync(path.join(f.dir,'.zylos/config.json'),JSON.stringify({domain:'dashboard.example.test',protocol}));
 const healthy=()=>new Response(JSON.stringify({ok:true,service:'zylos-dashboard',pid:MANAGED_PID}));
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(options.redirect,'manual');assert.ok(options.signal instanceof AbortSignal);
  requests.push(String(url));
  if(requests.length===1){assert.match(String(url),/^http:\/\/127\.0\.0\.1:\d+\/api\/health$/);return healthy();}
  assert.ok(requests.length<=replies.length+1,'unexpected extra request');
  return replies[requests.length-2]();
 });
 return {...f,requests,healthy};
}

for(const status of [301,302,307,308])test(`public health follows one HTTP ${status} upgrade and validates its process`,async t=>{
 const f=redirectFixture(t,{replies:[()=>new Response('<html>redirect</html>',{status,headers:{location:'https://dashboard.example.test/dashboard/api/health'}}),
  ()=>f.healthy()]});
 assert.deepEqual(await verifyDashboard({zylosDir:f.dir}),{state:'ready',checks:{health:true,route:true},errors:[]});
 assert.deepEqual(f.requests.slice(1),['http://dashboard.example.test/dashboard/api/health','https://dashboard.example.test/dashboard/api/health']);
});

for(const [label,location,protocol] of [
 ['different host','https://other.example.test/dashboard/api/health','http'],
 ['downgrade','http://dashboard.example.test/dashboard/api/health','https'],
 ['different path','https://dashboard.example.test/login','http'],
 ['different port','https://dashboard.example.test:8443/dashboard/api/health','http'],
 ['query change','https://dashboard.example.test/dashboard/api/health?next=1','http'],
 ['fragment','https://dashboard.example.test/dashboard/api/health#next','http'],
 ['credentials','https://user:password@dashboard.example.test/dashboard/api/health','http'],
 ['same scheme','http://dashboard.example.test/dashboard/api/health','http'],
 ['relative location','/dashboard/api/health','http'],
 ['malformed location','https://[','http'],
 ['missing location',null,'http'],
])test(`public health rejects a redirect with ${label} before parsing HTML`,async t=>{
 const f=redirectFixture(t,{protocol,replies:[()=>{
  const response=new Response('<html>not json</html>',{status:301,headers:location?{location}:{}});
  response.json=()=>assert.fail('non-success body must not be parsed');return response;
 }]});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.state,'degraded');assert.equal(result.checks.health,true);assert.equal(result.checks.route,false);
 assert.equal(result.errors[0].code,'route_failed');assert.equal(result.errors[0].message,'Dashboard health returned HTTP 301');
 assert.equal(f.requests.length,2);
});

test('public health refuses a second redirect without parsing its body',async t=>{
 const f=redirectFixture(t,{replies:[()=>new Response('',{status:308,headers:{location:'https://dashboard.example.test/dashboard/api/health'}}),()=>{
  const response=new Response('<html>redirect again</html>',{status:302,headers:{location:'https://dashboard.example.test/dashboard/api/health'}});
  response.json=()=>assert.fail('second redirect body');return response;
 }]});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.errors[0].code,'route_failed');assert.match(result.errors[0].message,/HTTP 302/);assert.equal(f.requests.length,3);
});

for(const status of [300,303,404,503])test(`public health reports HTTP ${status} without parsing the response`,async t=>{
 const f=redirectFixture(t,{replies:[()=>{
  const response=new Response('<html>failure</html>',{status,headers:{location:'https://dashboard.example.test/dashboard/api/health'}});
  response.json=()=>assert.fail('failed response body');return response;
 }]});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.errors[0].code,'route_failed');assert.match(result.errors[0].message,new RegExp(`HTTP ${status}$`));
 assert.equal(f.requests.length,2);
});

for(const body of [{ok:false,service:'zylos-dashboard',pid:MANAGED_PID},
 {ok:true,service:'other',pid:MANAGED_PID},{ok:true,service:'zylos-dashboard',pid:MANAGED_PID+1}]) {
 test(`redirected public health retains ${body.ok===false?'ok':body.service==='other'?'service':'pid'} validation`,async t=>{
  const f=redirectFixture(t,{replies:[()=>new Response('',{status:301,headers:{location:'https://dashboard.example.test/dashboard/api/health'}}),
   ()=>new Response(JSON.stringify(body))]});
  const result=await verifyDashboard({zylosDir:f.dir});
  assert.equal(result.errors[0].code,'route_failed');assert.equal(result.checks.route,false);assert.equal(f.requests.length,3);
 });
}

test('redirected health uses the remainder of the existing verification deadline',async t=>{
 let now=1000;t.mock.method(Date,'now',()=>now);
 const f=redirectFixture(t,{replies:[()=>{
  now+=30001;return new Response('',{status:301,headers:{location:'https://dashboard.example.test/dashboard/api/health'}});
 }]});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.errors[0].code,'verify_timeout');assert.equal(f.requests.length,2);
});

test('local health reports its HTTP status before parsing HTML',async t=>{
 const f=fixture(t);let now=1000;t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async()=>{
  now+=30001;const response=new Response('<html>not ready</html>',{status:503});
  response.json=()=>assert.fail('failed local body');return response;
 });
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.errors[0].code,'health_failed');assert.match(result.errors[0].message,/HTTP 503/);
});

test('verification omits public routing when managed Caddy is unavailable',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 fs.unlinkSync(path.join(f.bin,'caddy'));
 fs.mkdirSync(path.join(f.dir,'.zylos'),{recursive:true});
 fs.writeFileSync(path.join(f.dir,'.zylos/config.json'),JSON.stringify({domain:'dashboard.example.test'}));
 assert.deepEqual(await verifyDashboard({zylosDir:f.dir}),{state:'ready',checks:{health:true},errors:[]});
 assert.deepEqual(f.requests,['/api/health']);
});

test('health diagnostics retain observed failure when the shared window ends',async t=>{
 const f=fixture(t);let now=1000,calls=0;
 t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async()=>{calls++;now+=30001;return {ok:false,json:async()=>({ok:false})};});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(calls,1);assert.equal(result.errors[0].code,'health_failed');
});

test('both checks share one fixed window without a renewed public allowance',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.dir,'.zylos'),{recursive:true});
 fs.writeFileSync(path.join(f.dir,'.zylos/config.json'),JSON.stringify({domain:'dashboard.example.test'}));
 let now=1000,calls=0;t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async()=>{calls++;now+=30001;return {ok:true,json:async()=>({ok:true,service:'zylos-dashboard',pid:MANAGED_PID})};});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(calls,1);assert.equal(result.checks.health,true);assert.equal(result.checks.route,false);
 assert.equal(result.errors[0].code,'verify_timeout');
});

test('verification timeout without an observed response is distinct from health failure',async t=>{
 const f=fixture(t);t.mock.method(globalThis,'fetch',async()=>{throw new DOMException('Timed out','TimeoutError');});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.deepEqual(result.errors.map(error=>error.code),['verify_timeout']);
});

test('restore reports save failure after confirming the service is online',t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(f.dir,'pm2-calls'))},JSON.stringify(args)+'\\n');if(args[0]==='jlist')console.log(${JSON.stringify(JSON.stringify([managedEntry(f)]))});if(args[0]==='save')process.exit(18);`,{mode:0o755});
 const result=restoreDashboardService({zylosDir:f.dir});
 assert.equal(result.state,'failed');assert.equal(result.error.code,'registration_failed');
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse).map(args=>args[0]),['start','jlist','save']);
});

// PM2 keeps the start path of a service launched through a symlinked HOME or
// ZYLOS_DIR, while the upgrade passes the real installation path.
function linkedEntry(f, link) {
 const entry=managedEntry(f), code=path.join(link,path.relative(f.dir,f.code));
 return {...entry,pm2_env:{...entry.pm2_env,pm_exec_path:path.join(code,'src/index.js'),pm_cwd:code}};
}
test('restore accepts the managed entry recorded through a symlinked installation path',t=>{
 const f=fixture(t),link=path.join(f.dir,'linked-zylos');fs.symlinkSync(f.dir,link,'dir');
 pm2Result(f,[linkedEntry(f,link)]);
 assert.deepEqual(restoreDashboardService({zylosDir:f.dir}),{state:'done'});
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse).map(a=>a[0]),['start','jlist','save']);
});
test('verification follows the managed pid recorded through a symlinked installation path',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res)),link=path.join(f.dir,'linked-zylos');fs.symlinkSync(f.dir,link,'dir');
 pm2Result(f,[linkedEntry(f,link)]);
 assert.deepEqual(await verifyDashboard({zylosDir:f.dir}),{state:'ready',checks:{health:true},errors:[]});
});
test('a symlinked path that resolves to another Dashboard copy is not the managed entry',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res)),other=path.join(f.dir,'other-zylos');
 fs.mkdirSync(path.join(other,'.claude/skills/dashboard/src'),{recursive:true});
 fs.writeFileSync(path.join(other,'.claude/skills/dashboard/src/index.js'),'');
 const link=path.join(f.dir,'linked-other');fs.symlinkSync(other,link,'dir');
 pm2Result(f,[linkedEntry(f,link)]);
 assert.equal(restoreDashboardService({zylosDir:f.dir}).state,'failed');
 let now=1000;t.mock.method(Date,'now',()=>{now+=10001;return now;});
 assert.equal((await verifyDashboard({zylosDir:f.dir})).state,'degraded');
 assert.deepEqual(f.requests,[]);
});
