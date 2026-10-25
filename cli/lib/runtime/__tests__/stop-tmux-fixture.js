import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {SessionAdapter} from '../session-adapter.js';
import * as tmuxConnection from '../tmux-connection.js';
import * as sessionTarget from '../session-target.js';
export {LEGACY_TMUX_NAMES} from '../../session-group-paths.js';

export const actualDependencies={...tmuxConnection,...sessionTarget};
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(read,check) {
  let value;
  for(let attempt=0;attempt<100;attempt++){try{value=await read();if(check(value))return value;}catch{}await delay(20)}
  assert.fail(`Fixture observation did not become ready: ${JSON.stringify(value)}`);
}
export async function fixture(t,{origin=true}={}) {
  const cleanup=[];
  const {dir,socketPath,binary,tmux:command}=isolatedTmux(t,{prefix:'p02-tmux-stop-',
    beforeCleanup:async()=>{for(const close of cleanup)await close();}});
  if(origin)command('-f','/dev/null','new-session','-d','-s','origin','-e','ZYLOS_RUN_ID=outside-origin','sleep 60');
  const snapshot=name=>command('display-message','-p','-t',`=${name}:`,'#{session_id}:#{pane_id}:#{pane_pid}:#{ZYLOS_RUN_ID}');
  return {dir,command,snapshot,cleanup,origin:origin?snapshot('origin'):null,
    adapter:new SessionAdapter({dependencies:actualDependencies,tmux:{binary,socketPath,sessionName:origin?'origin':undefined}})};
}
export function interceptCommand(f, intercept) {
  f.adapter.options.dependencies={...actualDependencies,openTmuxConnection:async options=>{
    const connection=await actualDependencies.openTmuxConnection(options);
    const command=connection.command.bind(connection);
    connection.command=(args,guard)=>intercept(args,(next=args)=>command(next,guard),connection);
    return connection;
  }};
}
export async function service(f,key) {
  const file=path.join(f.dir,'heartbeat.json'),script=path.join(f.dir,'service.mjs');
  await fs.writeFile(script,`import {writeFileSync,renameSync} from 'node:fs';import {randomUUID} from 'node:crypto';let tick=0;const signals=[],start=randomUUID();
for(const signal of ['SIGHUP','SIGTERM','SIGINT'])process.on(signal,()=>signals.push(signal));
// Publish one complete snapshot; readers must never observe a truncated file.
const beat=()=>{writeFileSync(${JSON.stringify(file+'.tmp')},JSON.stringify({pid:process.pid,start,exe:process.execPath,runId:process.env.ZYLOS_RUN_ID,tick:++tick,signals}));renameSync(${JSON.stringify(file+'.tmp')},${JSON.stringify(file)});};beat();setInterval(beat,20);`);
  const child=spawn(process.execPath,[script],{detached:true,stdio:'ignore',env:{HOME:f.dir,ZYLOS_RUN_ID:key}});
  const exited=once(child,'exit');await once(child,'spawn');
  f.cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited});
  const before=await until(async()=>JSON.parse(await fs.readFile(file,'utf8')),value=>value.pid===child.pid);
  assert.equal(before.runId,key);assert.equal(before.exe,process.execPath);assert.ok(before.start);
  return {child,before,async verify(){
    const checkpoint=JSON.parse(await fs.readFile(file,'utf8'));
    const after=await until(async()=>JSON.parse(await fs.readFile(file,'utf8')),value=>value.tick>checkpoint.tick+1);
    assert.equal(after.pid,child.pid);assert.equal(after.start,before.start);assert.equal(after.exe,before.exe);assert.equal(after.runId,key);
    assert.deepEqual(after.signals,[]);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
    return {pid:child.pid,start:after.start,beforeTick:before.tick,checkpointTick:checkpoint.tick,afterTick:after.tick,signals:after.signals};
  }};
}
