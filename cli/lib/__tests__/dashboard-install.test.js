import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { copyDashboardDb, applyDashboardRegistration, applyDashboardRoute, verifyDashboard, restoreDashboardService } from '../dashboard-install.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-install-'));
 const bin=path.join(dir,'bin'), data=path.join(dir,'components/dashboard'), code=path.join(dir,'.claude/skills/dashboard');
 for(const p of [bin,data,path.dirname(code),path.join(dir,'http'),path.join(dir,'pm2')])fs.mkdirSync(p,{recursive:true});
 fs.symlinkSync(path.join(root,'skills/dashboard'),code,'dir');
 fs.copyFileSync(path.join(root,'templates/pm2/ecosystem.config.cjs'),path.join(dir,'pm2/ecosystem.config.cjs'));
 const prior=Object.fromEntries(['PATH','HOME','PM2_HOME','TMPDIR'].map(key=>[key,process.env[key]]));
 for(const key of ['HOME','PM2_HOME','TMPDIR']){process.env[key]=path.join(dir,key.toLowerCase());fs.mkdirSync(process.env[key]);}
 process.env.PATH=bin+path.delimiter+prior.PATH;
 fs.writeFileSync(path.join(bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const root=process.env.ZYLOS_DIR;const args=process.argv.slice(2);fs.appendFileSync(path.join(root,'pm2-calls'),JSON.stringify(args)+'\\n');if(args[0]==='jlist'){const code=path.join(root,'.claude/skills/dashboard');console.log(JSON.stringify([{name:'zylos-dashboard',pm2_env:{status:'online',pm_exec_path:path.join(code,'src/index.js'),pm_cwd:code}}]));}`,{mode:0o755});
 // A package scope for the fake binaries keeps their syntax unambiguous.
 fs.writeFileSync(path.join(bin,'package.json'),' {"type":"module"}');
 fs.writeFileSync(path.join(bin,'caddy'),`#!${process.execPath}\nprocess.exit(0);`,{mode:0o755});
 fs.writeFileSync(path.join(dir,'http/Caddyfile'),'http://localhost {\n}\n');
 t.after(()=>{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,data,code,bin};
}
test('best-effort copy preserves old main/WAL/SHM and missing does not create tx',t=>{
 const {dir,data}=fixture(t),tx=path.join(dir,'tx');
 assert.deepEqual(copyDashboardDb(dir,tx),{ok:true,error:null});assert.equal(fs.existsSync(tx),false);
 fs.writeFileSync(path.join(data,'dashboard.db-wal'),'orphan wal');
 fs.writeFileSync(path.join(data,'dashboard.db-shm'),'orphan shm');
 assert.deepEqual(copyDashboardDb(dir,tx),{ok:true,error:null});assert.equal(fs.existsSync(tx),false);
 assert.equal(fs.readFileSync(path.join(data,'dashboard.db-wal'),'utf8'),'orphan wal');
 for(const suffix of ['','-wal','-shm'])fs.writeFileSync(path.join(data,'dashboard.db'+suffix),'unchanged'+suffix);
 assert.equal(copyDashboardDb(dir,tx).ok,true);
 for(const suffix of ['','-wal','-shm'])assert.equal(fs.readFileSync(path.join(tx,'dashboard/db-copy/dashboard.db'+suffix),'utf8'),'unchanged'+suffix);
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
test('route retains custom prefix/port and reloads even identical content',t=>{
 const {dir,data}=fixture(t);fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:3999}));
 fs.writeFileSync(path.join(dir,'http/Caddyfile'),'http://localhost {\n# BEGIN zylos-component:dashboard\nhandle /private-observer/* {\nuri strip_prefix /private-observer\nreverse_proxy 127.0.0.1:3999\n}\n# END zylos-component:dashboard\n}\n');
 assert.deepEqual(applyDashboardRoute({zylosDir:dir}),{state:'done'});
 const first=fs.readFileSync(path.join(dir,'http/Caddyfile'),'utf8');
 assert.deepEqual(applyDashboardRoute({zylosDir:dir}),{state:'done'});
 assert.equal(fs.readFileSync(path.join(dir,'http/Caddyfile'),'utf8'),first);
 assert.match(first,/strip_prefix \/private-observer/);assert.match(first,/127.0.0.1:3999/);
 assert.equal(fs.readFileSync(path.join(dir,'pm2-calls'),'utf8').split('\n').filter(l=>l.includes('"reload"')).length,2);
});
test('missing Caddy returns failed instead of claiming manual route done',t=>{
 const {dir,bin}=fixture(t);fs.unlinkSync(path.join(bin,'caddy'));
 const result=applyDashboardRoute({zylosDir:dir});assert.equal(result.state,'failed');assert.equal(result.error.code,'route_failed');
});
test('registration preserves the original password and live session credentials',async t=>{
 const {dir,data}=fixture(t);
 const {Store}=await import('../../../skills/dashboard/src/lib/store.js');
 const {AuthGate,hashPassword}=await import('../../../skills/dashboard/src/lib/auth.js');
 const originalConfig={auth:{enabled:true,password:hashPassword('original-fixture-password')},basePath:'/private-observer'};
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
 fs.writeFileSync(path.join(bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const root=process.env.ZYLOS_DIR;const args=process.argv.slice(2);fs.appendFileSync(path.join(root,'pm2-calls'),JSON.stringify(args)+'\\n');if(args[0]==='start')process.exit(1);if(args[0]==='jlist'){const code=path.join(root,'.claude/skills/dashboard');console.log(JSON.stringify([{name:'zylos-dashboard',pm2_env:{status:'online',pm_exec_path:path.join(code,'src/index.js'),pm_cwd:code}}]));}`,{mode:0o755});
 const result=restoreDashboardService({zylosDir:dir});
 assert.equal(result.state,'done');
 assert.deepEqual(fs.readFileSync(path.join(dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse).map(a=>a[0]),['start','jlist','save']);
 assert.equal(fs.existsSync(path.join(dir,'pm2/ecosystem.config.cjs')),true);
});

function pm2Result(f, entries) {
 fs.writeFileSync(path.join(f.dir,'pm2-result.json'),JSON.stringify(entries));
 fs.writeFileSync(path.join(f.bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const root=process.env.ZYLOS_DIR;const args=process.argv.slice(2);fs.appendFileSync(path.join(root,'pm2-calls'),JSON.stringify(args)+'\\n');if(args[0]==='jlist')process.stdout.write(fs.readFileSync(path.join(root,'pm2-result.json')));`,{mode:0o755});
}
function managedEntry(f) {
 return {name:'zylos-dashboard',pm2_env:{status:'online',pm_exec_path:path.join(f.code,'src/index.js'),pm_cwd:f.code}};
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
 fs.writeFileSync(path.join(f.data,'config.json'),JSON.stringify({port:server.address().port,basePath:'/private-observer',auth:{enabled:true,password:'fixture-hash'}}));
 return {...f,server,requests};
}
function healthy(res) {res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,service:'zylos-dashboard'}));}

test('verification only reads local health without a public domain',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 fs.writeFileSync(path.join(f.data,'dashboard.db'),'unreadable bytes owned by the service');
 fs.writeFileSync(path.join(f.dir,'http/Caddyfile'),'# BEGIN zylos-component:dashboard\nmalformed route');
 const before=fs.readFileSync(path.join(f.data,'config.json'));
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.deepEqual(result,{state:'ready',checks:{health:true},errors:[]});
 assert.deepEqual(f.requests,['/api/health']);
 assert.equal(fs.existsSync(path.join(f.dir,'pm2-calls')),false);
 assert.equal(fs.readFileSync(path.join(f.data,'dashboard.db'),'utf8'),'unreadable bytes owned by the service');
 assert.deepEqual(fs.readFileSync(path.join(f.data,'config.json')),before);
});

test('verification polls local health until the service reports ready',async t=>{
 const f=await healthFixture(t,(_req,res,count)=>{if(count<3){res.writeHead(503);res.end('{"ok":false}');}else healthy(res);});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.state,'ready');assert.equal(f.requests.length,3);
});

test('verification waits for a delayed local listener',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 const port=f.server.address().port;
 await new Promise(resolve=>f.server.close(resolve));
 const timer=setTimeout(()=>f.server.listen(port,'127.0.0.1'),250);t.after(()=>clearTimeout(timer));
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(result.state,'ready');assert.deepEqual(f.requests,['/api/health']);
});

test('public verification makes one health request at the configured prefix',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 let publicHealthy=true;const requests=[];
 const proxy=http.createServer((req,res)=>{requests.push(req.url);if(publicHealthy)healthy(res);else{res.end('{"ok":true,"service":"other"}');}});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
 fs.mkdirSync(path.join(f.dir,'.zylos'),{recursive:true});
 fs.writeFileSync(path.join(f.dir,'.zylos/config.json'),JSON.stringify({domain:'127.0.0.1',protocol:'https',port:proxy.address().port}));
 assert.deepEqual(await verifyDashboard({zylosDir:f.dir}),{state:'ready',checks:{health:true,route:true},errors:[]});
 assert.deepEqual(requests,['/private-observer/api/health']);
 publicHealthy=false;
 const failed=await verifyDashboard({zylosDir:f.dir});
 assert.equal(failed.state,'degraded');assert.equal(failed.checks.health,true);assert.equal(failed.checks.route,false);
 assert.equal(failed.errors[0].code,'route_failed');assert.equal(requests.length,2);
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
 t.mock.method(globalThis,'fetch',async()=>{calls++;now+=30001;return {ok:true,json:async()=>({ok:true,service:'zylos-dashboard'})};});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.equal(calls,1);assert.equal(result.checks.health,true);assert.equal(result.checks.route,false);
 assert.equal(result.errors[0].code,'verify_timeout');
});

test('verification timeout without an observed response is distinct from health failure',async t=>{
 const f=fixture(t);t.mock.method(globalThis,'fetch',async()=>{throw new DOMException('Timed out','TimeoutError');});
 const result=await verifyDashboard({zylosDir:f.dir});
 assert.deepEqual(result.errors.map(error=>error.code),['verify_timeout']);
});

test('restore gives each PM2 child a fresh fixed timeout and checks jlist after start timeout',t=>{
 const f=fixture(t);
 const script=`
  import {mock} from 'node:test';
  import * as childProcess from 'node:child_process';
  const calls=[];
  mock.module('node:child_process',{namedExports:{...childProcess,execFileSync:(command,args,options)=>{
    calls.push({command,args,timeout:options.timeout});
    if(args[0]==='start')throw Object.assign(Error('timed out'),{code:'ETIMEDOUT'});
    return JSON.stringify([{name:'zylos-dashboard',pm2_env:{status:'online',pm_exec_path:${JSON.stringify(path.join(f.code,'src/index.js'))},pm_cwd:${JSON.stringify(f.code)}}}]);
  }}});
  const {restoreDashboardService}=await import(${JSON.stringify(path.join(root,'cli/lib/dashboard-install.js'))});
  const result=restoreDashboardService({zylosDir:${JSON.stringify(f.dir)}});
  process.stdout.write(JSON.stringify({result,calls}));
 `;
 const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',script],{encoding:'utf8',timeout:5000});
 assert.equal(child.status,0,child.stderr);
 const {result,calls}=JSON.parse(child.stdout);assert.deepEqual(result,{state:'done'});
 assert.deepEqual(calls.map(call=>[call.command,call.args[0],call.timeout]),[['pm2','start',30000],['pm2','jlist',30000],['pm2','save',30000]]);
});

test('restore reports save failure after confirming the service is online',t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.bin,'pm2'),`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(f.dir,'pm2-calls'))},JSON.stringify(args)+'\\n');if(args[0]==='jlist')console.log(${JSON.stringify(JSON.stringify([managedEntry(f)]))});if(args[0]==='save')process.exit(18);`,{mode:0o755});
 const result=restoreDashboardService({zylosDir:f.dir});
 assert.equal(result.state,'failed');assert.equal(result.error.code,'registration_failed');
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'pm2-calls'),'utf8').trim().split('\n').map(JSON.parse).map(args=>args[0]),['start','jlist','save']);
});

test('route installation and public health share the retained Caddy prefix without a configured prefix',async t=>{
 const f=await healthFixture(t,(_req,res)=>healthy(res));
 fs.writeFileSync(path.join(f.data,'config.json'),JSON.stringify({port:f.server.address().port}));
 fs.writeFileSync(path.join(f.dir,'http/Caddyfile'),'http://localhost {\n# BEGIN zylos-component:dashboard\nhandle /custom/* {\nuri strip_prefix /custom\nreverse_proxy 127.0.0.1:3470\n}\n# END zylos-component:dashboard\n}\n');
 assert.equal(applyDashboardRoute({zylosDir:f.dir}).state,'done');
 assert.match(fs.readFileSync(path.join(f.dir,'http/Caddyfile'),'utf8'),/strip_prefix \/custom/);
 const requests=[];
 const proxy=http.createServer((req,res)=>{requests.push(req.url);if(req.url==='/custom/api/health')healthy(res);else{res.writeHead(404);res.end('{}');}});
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
 fs.mkdirSync(path.join(f.dir,'.zylos'),{recursive:true});
 fs.writeFileSync(path.join(f.dir,'.zylos/config.json'),JSON.stringify({domain:'127.0.0.1',port:proxy.address().port}));
 assert.deepEqual(await verifyDashboard({zylosDir:f.dir}),{state:'ready',checks:{health:true,route:true},errors:[]});
 assert.deepEqual(requests,['/custom/api/health']);
});
