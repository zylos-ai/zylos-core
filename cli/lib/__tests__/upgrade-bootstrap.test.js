import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { test } from 'node:test';
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'core803-bootstrap-'));
  const stable=path.join(root,'.zylos/upgrade');
  fs.mkdirSync(stable,{recursive:true,mode:0o700});
  for(const [source,target] of [['upgrade-bootstrap.cjs','bootstrap.cjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-runtime-args.cjs','runtime-args.cjs']])
    fs.copyFileSync(new URL('../'+source,import.meta.url),path.join(stable,target));
  const output=path.join(root,'runtime-argv.jsonl'),report=path.join(root,'runtime-report.json'),input=path.join(root,'runtime-input.txt'),command=path.join(root,'codex'),delay=path.join(root,'delay');fs.writeFileSync(delay,'0');
  fs.writeFileSync(command,`#!${process.execPath}\nconst fs=require('node:fs');process.stdin.setRawMode(true);process.stdin.on('data',data=>fs.appendFileSync(${JSON.stringify(input)},data));const fd=fs.openSync('/dev/tty','r');fs.closeSync(fd);fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({tty:process.stdin.isTTY,columns:process.stdout.columns,rows:process.stdout.rows,HOME:process.env.HOME,apiPresent:'OPENAI_API_KEY' in process.env,alternateHomePresent:'CODEX_HOME' in process.env}));fs.appendFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2))+'\\n');setTimeout(()=>process.exit(0),Number(fs.readFileSync(${JSON.stringify(delay)},'utf8')));\n`,{mode:0o700});
  const config={formatVersion:1,runtime:{kind:'codex',command,args:[],cwd:root}};
  const configPath=path.join(stable,'capability.json');fs.writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
  const api=createRequire(import.meta.url)(path.join(stable,'bootstrap.cjs'));
  function journal(id='tx',extra={}) {
    const dir=path.join(root,'.backup/self-upgrade',id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(dir,'journal.json'),JSON.stringify({formatVersion:1,transactionId:id,zylosDir:root,phase:'prepared',initialIdentity:{},...extra}),{mode:0o600});return dir;
  }
  function rows(){return fs.existsSync(output)?fs.readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];}
  return {root,api,journal,rows,output,config,configPath,delay,report,input};
}
async function until(predicate) {
  const deadline=Date.now()+5000;
  while(!predicate()){if(Date.now()>deadline)throw Error('fixture deadline exceeded');await new Promise(r=>setTimeout(r,20));}
}
async function launch(f) {
  let child;const result=f.api.bootstrap(f.root,{launchRuntime:true,onChild:c=>{child=c;}});
  await once(child,'exit');return result;
}
test('malformed journal actively launches isolated runtime with diagnostic status entry',async()=>{
  const f=fixture(),dir=f.journal();fs.writeFileSync(path.join(dir,'journal.json'),'{broken');
  const result=await launch(f);assert.equal(result.recovery_required,true);assert.equal(result.launched,true);
  const prompt=f.rows()[0].at(-1);assert.match(prompt,/SYSTEM RECOVERY TASK/);assert.match(prompt,/diagnostics/);assert.match(prompt,/--status/);assert.match(prompt,/Do not query C4/);
  assert.equal(f.api.bootstrap(f.root,{once:true}).recovery_required,true);assert.equal(f.rows().length,1);
});
test('ambiguous transactions launch agent but never execute automatic recovery',async()=>{
  const f=fixture();f.journal('one');f.journal('two');
  const result=await launch(f);assert.equal(result.recovery_required,true);assert.match(result.error,/not unique/);
  const prompt=f.rows()[0].at(-1);assert.match(prompt,/one/);assert.match(prompt,/two/);assert.match(prompt,/preserve isolation/);
  assert.equal(f.api.bootstrap(f.root,{once:true}).recovery_required,true);
});
test('invalid controller material remains visible in active runtime prompt',async()=>{
  const f=fixture(),dir=f.journal();fs.writeFileSync(path.join(dir,'controller.json'),'{broken',{mode:0o600});
  const result=await launch(f);assert.equal(result.launched,true);assert.match(f.rows()[0].at(-1),/controller identity unavailable/);
});
test('unsafe or malformed runtime capability refuses subprocess execution',()=>{
  const f=fixture();f.journal();f.config.runtime.args=[{injected:'command'}];fs.writeFileSync(f.configPath,JSON.stringify(f.config));
  assert.throws(()=>f.api.bootstrap(f.root,{launchRuntime:true}),/invalid saved runtime/);assert.deepEqual(f.rows(),[]);
  f.config.runtime.args=[];fs.writeFileSync(f.configPath,JSON.stringify(f.config));fs.chmodSync(f.configPath,0o644);
  assert.throws(()=>f.api.bootstrap(f.root,{launchRuntime:true}),/private/);assert.deepEqual(f.rows(),[]);
});
test('supervisor discovers transaction created after idle boot and deduplicates live child',async()=>{
  const f=fixture();fs.writeFileSync(f.delay,'250');
  const outputs=[];const stop=f.api.supervise(f.root,{intervalMs:20,write:out=>outputs.push(out)});
  try {
    assert.equal(outputs[0].active,false);f.journal();await until(()=>f.rows().length===1);
    await new Promise(r=>setTimeout(r,80));assert.equal(f.rows().length,1);
    await until(()=>f.rows().length===2);assert.equal(outputs.filter(o=>o.launched).length,2);assert.match(f.rows()[1].at(-1),/tx/);
  }finally{stop();}
});
test('status is file-only and does not spawn even with damaged capability',()=>{
  const f=fixture();f.journal();fs.writeFileSync(f.configPath,'{broken');
  assert.equal(f.api.bootstrap(f.root,{status:true}).active,true);assert.deepEqual(f.rows(),[]);
});


test('boot transport provides real terminal, owner login environment and literal recovery prompt',async()=>{
  const f=fixture();const sentinel=path.join(f.root,'shell-must-not-run');
  const phase="bad'$(touch "+sentinel+")";f.journal('tx',{phase});
  const previous={api:process.env.OPENAI_API_KEY,home:process.env.CODEX_HOME};
  process.env.OPENAI_API_KEY='fixture-must-not-inherit';process.env.CODEX_HOME='/fixture/must-not-inherit';
  try{await launch(f);}finally{
    if(previous.api===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous.api;
    if(previous.home===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous.home;
  }
  const report=JSON.parse(fs.readFileSync(f.report,'utf8'));
  assert.equal(report.tty,true);assert.equal(report.HOME,os.userInfo().homedir);
  assert.equal(report.columns,120);assert.equal(report.rows,40);
  assert.equal(report.apiPresent,false);assert.equal(report.alternateHomePresent,false);
  assert.equal(fs.existsSync(sentinel),false);assert.ok(f.rows()[0].at(-1).includes(phase));
});


test('same live runtime receives changed attribution once and bootstrap restart preserves deduplication',async()=>{
  const f=fixture();fs.writeFileSync(f.delay,'2000');f.journal('one');
  const outputs=[];const stop=f.api.supervise(f.root,{intervalMs:30,write:out=>outputs.push(out)});
  try{
    await until(()=>f.rows().length===1);await new Promise(r=>setTimeout(r,80));
    assert.equal(fs.existsSync(f.input),false);
    // Existing runtime/session keeps the signature in tmux across observers.
    assert.equal(f.api.bootstrap(f.root,{launchRuntime:true}).reprompted,undefined);
    f.journal('two');await until(()=>fs.existsSync(f.input));
    const initial=fs.readFileSync(f.input,'utf8');assert.match(initial,/two/);
    const before=initial.length;await new Promise(r=>setTimeout(r,100));assert.equal(fs.readFileSync(f.input,'utf8').length,before);
    assert.equal(f.api.bootstrap(f.root,{launchRuntime:true}).reprompted,undefined);
    assert.equal(f.rows().length,1);assert.equal(outputs.filter(out=>out.reprompted).length,1);
    const dir=path.join(f.root,'.backup/self-upgrade/one'),j=JSON.parse(fs.readFileSync(path.join(dir,'journal.json'),'utf8'));j.phase='restoring';j.updatedAt='later';fs.writeFileSync(path.join(dir,'journal.json'),JSON.stringify(j));
    await new Promise(r=>setTimeout(r,100));assert.equal(fs.readFileSync(f.input,'utf8').length,before);
  }finally{stop();}
});
