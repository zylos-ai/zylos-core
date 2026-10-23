import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const {settleLaunch,executableIdentity}=await import(process.env.P02_LAUNCH_MODULE || '../session-launch.js');
import {shellQuote,writeSessionLaunchScript} from '../session-command.js';
const binary=process.env.TEST_TMUX_BIN || 'tmux';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const scenarios=['create-softdrop','setter-softdrop','target-softdrop','absence-softdrop','first-server','header-missing','header-error','completion-missing','malformed-end','nested-begin','script-replaced','script-disappeared','session-replaced','session-disappeared'];
async function worker(scenario){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"p02-barrier ' #,{x} [$] ` -"));
  const socketPath=path.join(dir,'s'),events=path.join(dir,'events');
  const tmux=(...a)=>execFileSync(binary,['-S',socketPath,...a],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']});
  try {
    if(scenario!=='first-server') tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 30');
    const oldTmp=process.env.TMPDIR; process.env.TMPDIR=dir;
    const generated=writeSessionLaunchScript({command:'/bin/sleep',args:['20'],env:{PATH:'/usr/bin:/bin'},root:dir,multi:false});
    if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;
    const file=generated.file;
    const proxy=path.join(dir,'proxy.mjs');
    await fs.writeFile(proxy,`#!${process.execPath}
import {spawn,execFileSync} from 'node:child_process';import fs from 'node:fs';
const scenario=${JSON.stringify(scenario)},file=${JSON.stringify(file)};
const child=spawn(${JSON.stringify(binary)},process.argv.slice(2),{stdio:['pipe','pipe','pipe']});
const record=v=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(v)+'\\n');
record({spawn:true});process.stdin.on('data',d=>{record({request:d.toString()});child.stdin.write(d)});child.stdin.on('error',()=>{});child.stderr.resume();
let buffer='',frame=[],inside=false,created=false,dropped=false;
child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.startsWith('%begin ')){frame=[line];inside=true;continue;}if(inside){frame.push(line);if(!line.startsWith('%end ')&&!line.startsWith('%error '))continue;inside=false;const body=frame.slice(1,-1).join('\\n');const control=frame[0].endsWith(' 1');record({body,control});
const create=!created && /^\\$\\d+\\t%\\d+\\t/.test(body);if(create){created=true;if(scenario==='script-replaced'){try{fs.renameSync(file,file+'.old')}catch{}fs.mkdirSync(${JSON.stringify(path.dirname(file))},{recursive:true});fs.writeFileSync(file,'replacement');}if(scenario==='script-disappeared'){try{fs.unlinkSync(file)}catch{}}if(scenario.startsWith('session-')){execFileSync(${JSON.stringify(binary)},['-S',${JSON.stringify(socketPath)},'kill-session','-t','=target']);if(scenario==='session-replaced')execFileSync(${JSON.stringify(binary)},['-S',${JSON.stringify(socketPath)},'new-session','-d','-s','target','sleep 20']);}}
if(scenario==='header-error'&&body.startsWith('launch-header:'))frame[frame.length-1]=frame[frame.length-1].replace('%end ','%error ');
if(scenario==='malformed-end'&&create)frame[frame.length-1]+='0';
if(scenario==='nested-begin'&&create)frame.splice(1,0,frame[0]);
const drop=(create && ['create-softdrop','script-replaced','script-disappeared','session-replaced','session-disappeared'].includes(scenario)) || (scenario==='header-missing' && body.startsWith('launch-header:')) || (scenario==='completion-missing' && body.startsWith('launch-complete:')) || (!dropped && control && ((scenario==='setter-softdrop' && body==='') || (scenario==='target-softdrop' && (body.startsWith('launch-proof:') || /^\\$\\d+\\t%\\d+\\t/.test(body))) || (scenario==='absence-softdrop' && body==='-ZYLOS_SESSION_GROUP')));
if(drop){dropped=true;record({dropped:body});continue;}process.stdout.write(frame.join('\\n')+'\\n');}else process.stdout.write(line+'\\n');}});child.on('close',()=>process.exit(0));
`,{mode:0o700});
    let outcome='pending';
    settleLaunch({tmuxName:'target',runId:'barrier-run',launchConfig:{runtime:'claude',mode:'default'},sessionGroup:null,root:dir,script:generated,identity:await executableIdentity('/bin/sleep',process.env),args:['20'],tmux:{binary:proxy,socketPath,configFile:'/dev/null'},noticeMs:50,onNotice(){}}).then(()=>{outcome='success'},e=>{outcome=e.code});
    const positive=['setter-softdrop','target-softdrop','absence-softdrop','first-server'].includes(scenario);
    for(let i=0;i<120;i++){if(positive && outcome==='success')break;await delay(10)}
    assert.equal(outcome,positive?'success':'pending');
    const records=(await fs.readFile(events,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(r=>r.spawn).length,1);
    if(scenario.endsWith('softdrop'))assert.ok(records.some(r=>Object.hasOwn(r,'dropped')),'selected real frame was omitted');
    const requests=records.filter(r=>r.request).map(r=>r.request).join('');
    assert.doesNotMatch(requests,/new-session|send-keys/);
    if(scenario.startsWith('script-') || scenario.startsWith('session-') || ['malformed-end','nested-begin'].includes(scenario))assert.doesNotMatch(requests,/set-environment/,'no binding or mutation from an unproven replacement');
    if(positive)await assert.rejects(fs.stat(file),{code:'ENOENT'});
    if(positive)assert.equal(tmux('show-environment','-t','=target','ZYLOS_SESSION_GROUP').trim(),'-ZYLOS_SESSION_GROUP');
    if(scenario==='session-replaced') assert.doesNotMatch(tmux('show-environment','-t','=target'),/^-ZYLOS_SESSION_GROUP$/m);
    console.log(JSON.stringify({scenario,outcome,softdropModel:scenario.endsWith('softdrop') || ['header-missing','completion-missing'].includes(scenario),requests:requests.split('\n').filter(Boolean).length,oneConnection:true}));
  }finally{try{tmux('kill-server')}catch{}await fs.rm(dir,{recursive:true,force:true});}
}
if(process.env.P02_BARRIER_WORKER){try{await worker(process.env.P02_BARRIER_WORKER);process.exit(0)}catch(e){console.error(e);process.exit(1)}}
else for(const scenario of scenarios)test(`original connection completion: ${scenario}`,async t=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,P02_BARRIER_WORKER:scenario},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill('SIGKILL'),8000);const code=await new Promise(r=>child.on('close',r));clearTimeout(timer);
  assert.equal(code,0,stderr||stdout);t.diagnostic(stdout.trim());
});
