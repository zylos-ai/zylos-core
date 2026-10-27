import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from '../../../skills/web-console/node_modules/better-sqlite3/lib/index.js';
import WebSocket from '../../../skills/web-console/node_modules/ws/wrapper.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }

test('Console HTTP, initial WebSocket and polling share current session response', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-status-'));
  const zylos = path.join(root, 'zylos'), pkg = path.join(root, 'package'), fixture = path.join(root, 'sample.json');
  fs.mkdirSync(path.join(zylos, 'comm-bridge'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'cli/lib'), { recursive: true });
  fs.symlinkSync(path.resolve('cli/lib/runtime'), path.join(pkg, 'cli/lib/runtime'));
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(pkg, 'cli/lib/config.js'), `export * from ${JSON.stringify(new URL('../config.js', import.meta.url).href)};`);
  fs.writeFileSync(path.join(pkg, 'cli/lib/session-state-reader.js'), `import fs from 'node:fs'; export async function readSessionState(group, options) { const sample = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8')); fs.appendFileSync(${JSON.stringify(path.join(root,'calls'))}, JSON.stringify({group,options})+'\\n'); if(sample.throw) throw Error(sample.throw); return sample; }`);
  const db = new Database(path.join(zylos, 'comm-bridge/c4.db')); db.exec(fs.readFileSync('skills/comm-bridge/init-db.sql','utf8')); db.close();
  fs.mkdirSync(path.join(zylos, 'activity-monitor'));
  fs.writeFileSync(path.join(zylos, 'activity-monitor/agent-status.json'), '{"state":"WRONG_GLOBAL"}');
  fs.writeFileSync(fixture, JSON.stringify({identity:{present:true,runId:'R'},status:{valid:true,value:{state:'busy',extra:'preserved'}}}));
  const bound = await port();
  const child = spawn(process.execPath, ['skills/web-console/scripts/server.js'], { env: { ...process.env, HOME: root, ZYLOS_DIR: zylos, ZYLOS_PACKAGE_ROOT: pkg, WEB_CONSOLE_PORT: String(bound), WEB_CONSOLE_BIND: '127.0.0.1' }, stdio:['ignore','pipe','pipe'] });
  let output=''; child.stdout.on('data', b=>output+=b); child.stderr.on('data',b=>output+=b);
  t.after(async()=>{child.kill('SIGTERM'); if(child.exitCode===null) await once(child,'exit'); fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${bound}`;
  let ready=false;
  for(let n=0;n<100;n++){if(child.exitCode!==null) throw Error(output); try{ready=(await fetch(base+'/api/health')).ok;}catch{} if(ready)break; await pause(50);}
  assert(ready, output);
  const expected={state:'busy',extra:'preserved',sessionGroup:null,runId:'R'};
  assert.deepEqual(await (await fetch(base+'/api/status')).json(),expected);
  const ws = new WebSocket(`ws://127.0.0.1:${bound}`); t.after(()=>ws.terminate());
  const messages=[]; ws.on('message',data=>messages.push(JSON.parse(data)));
  for(let n=0;n<30&&!messages.length;n++)await pause(20);
  assert.deepEqual(messages.find(m=>m.type==='status')?.data,expected);
  fs.writeFileSync(fixture, JSON.stringify({identity:{present:true,runId:'R2'},status:{valid:false,reason:'identity_changed'}}));
  for(let n=0;n<50&&!messages.some(m=>m.data?.reason==='identity_changed');n++)await pause(20);
  const unknown={state:'unknown',reason:'identity_changed',sessionGroup:null};
  assert.deepEqual(messages.find(m=>m.data?.reason==='identity_changed')?.data,unknown);
  assert.deepEqual(await (await fetch(base+'/api/status')).json(),unknown);
  fs.writeFileSync(fixture, JSON.stringify({throw:'reader unavailable'}));
  assert.deepEqual(await (await fetch(base+'/api/status')).json(),{state:'error',message:'reader unavailable'});
  const calls=fs.readFileSync(path.join(root,'calls'),'utf8').trim().split('\n').map(JSON.parse);
  assert(calls.every(c=>c.group===null&&c.options.freshnessMs===5000));
  const writable = new Database(path.join(zylos, 'comm-bridge/c4.db'));
  writable.prepare('INSERT INTO channel_namespaces(namespace,component_name) VALUES(?,?)').run('clone-console', 'web-console'); writable.close();
  fs.mkdirSync(path.join(zylos,'.zylos'), { recursive:true });
  fs.writeFileSync(path.join(zylos,'.zylos/config.json'), JSON.stringify({session_mode:'multi'}));
  fs.writeFileSync(fixture, JSON.stringify({identity:{present:false},status:{valid:false,reason:'not_running'}}));
  assert.deepEqual(await (await fetch(base+'/api/status')).json(), {state:'not_running',reason:'not_running',sessionGroup:'clone-console'});
  for(const reason of ['stale','unparseable']) {
    fs.writeFileSync(fixture,JSON.stringify({identity:{present:true},status:{valid:false,reason}}));
    assert.deepEqual(await (await fetch(base+'/api/status')).json(), {state:'unknown',reason,sessionGroup:'clone-console'});
  }
  const lastCall=JSON.parse(fs.readFileSync(path.join(root,'calls'),'utf8').trim().split('\n').at(-1));
  assert.equal(lastCall.group,'clone-console');
  assert(!JSON.stringify(messages).includes('WRONG_GLOBAL'));
  ws.terminate();
});
