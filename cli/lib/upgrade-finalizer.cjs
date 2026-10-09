'use strict';
// Independent process-group containment. No installed skill or database imports.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
function members(group) {
  const result=cp.spawnSync('ps',['-eo','pid=,pgid=,sid=,stat=,args='],{encoding:'utf8',timeout:10000});
  if(result.error||result.status!==0)throw Error('cannot verify finalizer process exit');
  return result.stdout.split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .filter(row=>Number(row[2])===group&&!row[4].startsWith('Z'));
}
function quiesce(dir,j,{terminate=false,kind='finalizer'}={}) {
  if(!['finalizer','installer'].includes(kind))throw Error('unsupported contained process kind');
  const m=require(path.join(dir,'maintenance.cjs'));
  const execution=j[kind+'Execution'],intent=j[kind+'LaunchIntent'];
  if(execution&&intent&&execution.nonce!==intent.nonce)return {confirmed:false,error:kind+' launch identity conflict'};
  if(!execution){
    if(!intent)return {confirmed:true};
    const parent=intent.parent;
    const currentBoot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    if(parent&&!parent.unsupported&&typeof parent.boot==='string'&&parent.boot!==currentBoot)return {confirmed:true};
    if(m.alive(parent))return {confirmed:false,error:kind+' launcher is still alive'};
    const rows=cp.spawnSync('ps',['-eo','args='],{encoding:'utf8',timeout:10000});
    if(rows.error||rows.status!==0)return {confirmed:false,error:kind+' launch cannot be verified'};
    const nonce=intent.nonce;
    if(typeof nonce!=='string'||! /^[a-f0-9]{32}$/.test(nonce))return {confirmed:false,error:'invalid '+kind+' launch nonce'};
    const wrappers=[path.join(dir,'finalizer.cjs')];
    if(typeof j.zylosDir==='string'&&path.isAbsolute(j.zylosDir)&&typeof j.transactionId==='string')wrappers.push(path.join(j.zylosDir,'.backup','self-upgrade',j.transactionId,'finalizer.cjs'));
    return {confirmed:!rows.stdout.split('\n').some(row=>wrappers.some(wrapper=>row.includes(wrapper))&&row.includes(nonce)),error:kind+' child launch is still active'};
  }
  const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  if(boot!==execution.boot)return {confirmed:true};
  let rows=members(execution.pid);
  if(!rows.length)return {confirmed:true};
  const leader=rows.find(row=>Number(row[1])===execution.pid);
  if((leader&&!m.alive(execution))||rows.some(row=>Number(row[3])!==execution.pid))return {confirmed:false,error:kind+' process group identity conflict'};
  if(!terminate)return {confirmed:false,error:kind+' process group is still active'};
  try{process.kill(-execution.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')return {confirmed:false,error:error.message};}
  const deadline=Date.now()+10000;
  while((rows=members(execution.pid)).length){if(Date.now()>=deadline)return {confirmed:false,error:kind+' process group exit grace exhausted'};Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}
  return {confirmed:true};
}
module.exports={members,quiesce};
if(require.main===module) {
  const argv=process.argv.slice(2),kind=argv[0]==='--installer'?'installer':'finalizer';if(kind==='installer')argv.shift();
  const [script,state,dir,nonce]=argv;
  try {
    const m=require(path.join(dir,'maintenance.cjs')),j=m.read(path.join(dir,'journal.json'));
    const intent=j[kind+'LaunchIntent'];
    if(intent?.nonce!==nonce||!j.installationIntent)throw Error('invalid '+kind+' launch intent');
    const args=kind==='installer'?JSON.parse(state):[state];
    if(kind==='installer'&&(!Array.isArray(args)||JSON.stringify(args)!==JSON.stringify(intent.args)||script!==intent.npmCli||m.hash(script)!==intent.npmCliHash||process.execPath!==intent.nodePath||process.cwd()!==intent.cwd))throw Error('installer launch specification changed');
    const identity=m.identity();if(identity.unsupported)throw Error('contained process identity unsupported');
    m.update(dir,j,{[kind+'Execution']:{...identity,nonce,...(kind==='installer'?{stage:intent.stage}:{})}});
    process.argv=[process.execPath,script,...args];
    import(require('node:url').pathToFileURL(script).href).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
  }catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
