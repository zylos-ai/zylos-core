import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {settleLaunch,executableIdentity} from '../session-launch.js';
import {validateLaunchConfig,writeSessionLaunchScript,shellQuote} from '../session-command.js';
const binary=process.env.TEST_TMUX_BIN || 'tmux';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const models=['model#[fg=red]','model##[fg=red,bold]','model#[fg=red]#{pid},}#(echo ignored)\t"\n'];
for (const model of models) for (const mismatch of [false,true]) {
  test(`creation literal ${JSON.stringify(model)} mismatch=${mismatch}`,async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-literal-'));
    const socketPath=path.join(dir,'s');
    const tmux=(...a)=>execFileSync(binary,['-S',socketPath,...a],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']});
    let script,pending;
    try {
      tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 30');
      const origin=tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim();
      const config={runtime:'claude',mode:'override',model,effort:'high'};
      assert.equal(validateLaunchConfig('claude',config,' --model MODEL --effort EFFORT '),true);
      const actual=mismatch?{...config,model:model+'-different'}:config;
      const proxy=path.join(dir,'proxy.mjs'),calls=path.join(dir,'calls');
      await fs.writeFile(proxy,`#!${process.execPath}\nimport {spawn} from 'node:child_process';import fs from 'node:fs';\nconst args=process.argv.slice(2);const i=args.findIndex(v=>v.startsWith('ZYLOS_MODEL_CONFIG='));args[i]=${JSON.stringify('ZYLOS_MODEL_CONFIG='+JSON.stringify(actual))};fs.appendFileSync(${JSON.stringify(calls)},'create\\n');const child=spawn(${JSON.stringify(binary)},args,{stdio:['pipe','inherit','inherit']});process.stdin.on('data',d=>{fs.appendFileSync(${JSON.stringify(calls)},'extra-request\\n');child.stdin.write(d)});child.stdin.on('error',()=>{});child.on('close',()=>process.exit(0));\n`,{mode:0o700});
      script=writeSessionLaunchScript({command:'/bin/sleep',args:['20'],env:{PATH:'/usr/bin:/bin'},root:dir,multi:false});
      // Isolate session F2 rejection: keep the runtime image exactly as requested
      // even when the proxy corrupts only the tmux session environment.
      if(mismatch){const body=await fs.readFile(script.file,'utf8');await fs.writeFile(script.file,body.replace('#!/bin/sh\n',`#!/bin/sh\nexport ZYLOS_MODEL_CONFIG=${shellQuote(JSON.stringify(config))}\n`));}
      let outcome='pending';
      pending=settleLaunch({tmuxName:'target',runId:'literal-run',launchConfig:config,sessionGroup:null,root:dir,script,identity:await executableIdentity('/bin/sleep',process.env),args:['20'],tmux:{binary:proxy,socketPath,configFile:'/dev/null'},noticeMs:50,onNotice(){}}).then(()=>{outcome='success'},e=>{outcome=e.code});
      let pid;
      for(let i=0;i<100;i++){try{pid=Number(tmux('list-panes','-t','=target','-F','#{pane_pid}').trim());break}catch{await delay(10)}}
      assert.ok(pid);
      for(let i=0;i<100;i++){try{if(await fs.readlink(`/proc/${pid}/exe`)===await fs.realpath('/bin/sleep'))break}catch{}await delay(10)}
      assert.equal(await fs.readlink(`/proc/${pid}/exe`),await fs.realpath('/bin/sleep'));
      const f2=`ZYLOS_MODEL_CONFIG=${JSON.stringify(actual)}`;
      assert.ok(tmux('show-environment','-t','=target').split('\n').includes(f2));
      assert.ok((await fs.readFile(`/proc/${pid}/environ`,'utf8')).split('\0').includes(`ZYLOS_MODEL_CONFIG=${JSON.stringify(config)}`));
      if(mismatch){
        await delay(150);assert.equal(outcome,'pending');
        tmux('kill-session','-t','=target');await pending;assert.equal(outcome,'LAUNCH_FAILED');
      } else {
        for(let i=0;i<100&&outcome==='pending';i++)await delay(10);
        assert.equal(outcome,'success','correct session/process F2 must confirm the original launch');
        await delay(100);assert.equal(Number(tmux('list-panes','-t','=target','-F','#{pane_pid}').trim()),pid);
      }
      assert.equal(tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim(),origin);
      assert.equal(await fs.readFile(calls,'utf8'),'create\n');
      t.diagnostic(JSON.stringify({model,mismatch,configValidated:true,sessionF2Exact:true,processMatchesRequested:true,outcome,oneCreation:true,noSecondRequest:true,originUnchanged:true}));
    } finally {
      try{tmux('kill-server')}catch{}
      if(pending)await Promise.race([pending,delay(500)]);
      script?.cleanup();await fs.rm(dir,{recursive:true,force:true});
    }
  });
}
