import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {SessionAdapter} from '../session-adapter.js';
import {readProcessImage} from '../session-process-observation.js';

export const providerRoot=process.env.P02_REAL_A_ROOT || new URL('../../../../',import.meta.url).pathname;
export const actualDependencies={
 ...(await import(pathToFileURL(path.join(providerRoot,'cli/lib/runtime/tmux-connection.js')))),
 ...(await import(pathToFileURL(path.join(providerRoot,'cli/lib/runtime/session-target.js')))),
};
export const {LEGACY_TMUX_NAMES}=await import(pathToFileURL(path.join(providerRoot,'cli/lib/session-group-paths.js')));
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(read,check) {
  let value;
  for(let attempt=0;attempt<100;attempt++){try{value=await read();if(check(value))return value;}catch{}await delay(20)}
  assert.fail(`Fixture observation did not become ready: ${JSON.stringify(value)}`);
}
export async function fixture(t,{origin=true}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-tmux-stop-')),socketPath=path.join(dir,'s'),cleanup=[];
  const binary=process.env.TEST_TMUX_BIN || 'tmux';
  const command=(...args)=>execFileSync(binary,['-S',socketPath,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:3000}).trim();
  t.after(async()=>{for(const close of cleanup)await close();try{command('kill-server')}catch{}await fs.rm(dir,{recursive:true,force:true})});
  if(origin)command('-f','/dev/null','new-session','-d','-s','origin','-e','ZYLOS_RUN_ID=outside-origin','sleep 60');
  const snapshot=name=>command('display-message','-p','-t',`=${name}:`,'#{session_id}:#{pane_id}:#{pane_pid}:#{ZYLOS_RUN_ID}');
  return {dir,command,snapshot,cleanup,origin:origin?snapshot('origin'):null,
    adapter:new SessionAdapter({dependencies:actualDependencies,tmux:{binary,socketPath,sessionName:origin?'origin':undefined}})};
}
export async function service(f,key) {
  const file=path.join(f.dir,'heartbeat.json'),script=path.join(f.dir,'service.mjs');
  await fs.writeFile(script,`import {writeFileSync} from 'node:fs';let tick=0;const signals=[];
for(const signal of ['SIGHUP','SIGTERM','SIGINT'])process.on(signal,()=>signals.push(signal));
const beat=()=>writeFileSync(${JSON.stringify(file)},JSON.stringify({pid:process.pid,tick:++tick,signals}));beat();setInterval(beat,20);`);
  const child=spawn(process.execPath,[script],{detached:true,stdio:'ignore',env:{HOME:f.dir,ZYLOS_RUN_ID:key}});
  const exited=once(child,'exit');await once(child,'spawn');
  f.cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited});
  const before=await until(async()=>JSON.parse(await fs.readFile(file,'utf8')),value=>value.pid===child.pid);
  const image=await readProcessImage(child.pid);assert.equal(image.uncertain,undefined);assert.ok(image.env.includes(`ZYLOS_RUN_ID=${key}`));
  return {child,before,image,async verify(){
    const checkpoint=JSON.parse(await fs.readFile(file,'utf8'));
    const after=await until(async()=>JSON.parse(await fs.readFile(file,'utf8')),value=>value.tick>checkpoint.tick+1);
    const current=await readProcessImage(child.pid);assert.equal(current.start,image.start);assert.equal(current.exe,image.exe);
    assert.deepEqual(after.signals,[]);assert.equal(child.signalCode,null);
    return {pid:child.pid,start:current.start,beforeTick:before.tick,checkpointTick:checkpoint.tick,afterTick:after.tick,signals:after.signals};
  }};
}
