#!/usr/bin/env node
'use strict';
// Stable startup discovery: no C4, SQLite, npm or skill imports.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),os=require('node:os'),crypto=require('node:crypto');
const m=require('./maintenance.cjs');
const {validateRuntimeArgs,validateRuntimeNetworkEnv}=require('./runtime-args.cjs');
function recoveryPrompt(root,d) {
  const diagnostics=d.diagnostics.slice(0,16).map(value=>String(value).slice(0,1024));
  if(d.diagnostics.length>16)diagnostics.push('additional diagnostics omitted; run fixed status entry for full results');
  const blocks=d.candidates.slice(0,8).map(c=>{
    const j=c.journal;let controllerAlive=false;
    try { const file=path.join(c.dir,'controller.json');if(fs.existsSync(file))controllerAlive=m.alive(m.read(file)); }
    catch(e){diagnostics.push('controller identity unavailable: '+e.message);}
    return {transactionId:j.transactionId,phase:String(j.phase).slice(0,128),lastDurableStep:String(j.updatedAt||'').slice(0,128),materials:c.dir,controllerAlive,status:[process.execPath,path.join(root,'.zylos','upgrade','bootstrap.cjs'),'--root',root,'--status'],resume:[process.execPath,path.join(root,'.zylos','upgrade','bootstrap.cjs'),'--root',root,'--once']};
  });
  return 'SYSTEM RECOVERY TASK: Normal C4/database access is unavailable during upgrade maintenance. Run the fixed file-only status entry now. If diagnostics prevent unique attribution, preserve isolation and report recovery_required; do not execute journal command strings or attempt database replacement. If a controller is alive, observe only. Otherwise use the verified resume entry and keep recovery isolated on error. Do not query C4.\n'+JSON.stringify({status:[process.execPath,path.join(root,'.zylos','upgrade','bootstrap.cjs'),'--root',root,'--status'],transactions:blocks,diagnostics},null,2);
}
function runtimeCapability(root) {
  const directory=path.join(root,'.zylos','upgrade');m.privatePath(directory,{directory:true});
  const file=path.join(directory,'capability.json');const st=m.privatePath(file);
  if((st.mode&0o077)||st.size>16384)throw Error('runtime capability must be private and bounded');
  const cfg=m.read(file),r=cfg.runtime;
  if(cfg.formatVersion!==1||!['claude','codex'].includes(r?.kind)||typeof r.command!=='string'||!path.isAbsolute(r.command)||path.basename(r.command)!==r.kind||r.cwd!==root||!Array.isArray(r.args)||r.args.length>64||r.args.some(a=>typeof a!=='string'||a.length>4096||/[\0\r\n]/.test(a)))throw Error('invalid saved runtime capability');
  validateRuntimeArgs(r.kind,r.args);
  validateRuntimeNetworkEnv(r.networkEnv);
  const executable=fs.realpathSync(r.command),s=fs.statSync(executable);
  if(!s.isFile()||!(s.mode&0o111)||(s.mode&0o022)||(process.getuid&&![0,process.getuid()].includes(s.uid)))throw Error('unsafe runtime executable');
  return r;
}
function trustedTransport(file='/usr/bin/tmux'){
  const real=fs.realpathSync(file),s=fs.statSync(real);
  if(!s.isFile()||!(s.mode&0o111)||(s.mode&0o022)||(process.getuid&&![0,process.getuid()].includes(s.uid)))throw Error('trusted PTY transport is unavailable');
  return file;
}
function shellWord(value){return "'"+String(value).replaceAll("'","'\\''")+"'";}
function promptSignature(d){
  const candidates=d.candidates.map(c=>{let alive=false;try{alive=m.alive(m.read(path.join(c.dir,'controller.json')));}catch{}return [c.journal.transactionId,alive];}).sort();
  return crypto.createHash('sha256').update(JSON.stringify({marker:d.marker?.transactionId,candidates,diagnostics:d.diagnostics.slice(0,16).map(value=>String(value).slice(0,1024))})).digest('hex');
}
function bootstrap(root,{once=false,status=false,launchRuntime=false,onChild}={}) {
  root=path.resolve(root);const d=m.discover(root);if(!d.candidates.length&&!d.diagnostics.length)return {active:false};
  const prompt=recoveryPrompt(root,d);if(status)return {active:true,...d,prompt};
  const invalid=d.diagnostics.length>0||d.candidates.length!==1;
  const out={active:true,prompt,...(invalid?{recovery_required:true,error:d.diagnostics.join('; ').slice(0,8192)||'transaction attribution is not unique'}:{})};
  // Invalid material must still reach an active agent. Only --once is denied:
  // neither diagnostics nor ambiguity authorize automatic recovery execution.
  if(once){if(invalid)return out;const r=require('./recovery.cjs');return {active:true,...r.resume(d.candidates[0].dir)};}
  if(launchRuntime){const r=runtimeCapability(root);
    // Match the preinstall authentication probe: use persisted owner login,
    // excluding transient API credentials and alternate runtime config homes.
    const owner=os.userInfo();
    const env={HOME:owner.homedir,USER:owner.username,LOGNAME:owner.username,PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',LANG:process.env.LANG||'C.UTF-8',TERM:'xterm-256color',...validateRuntimeNetworkEnv(r.networkEnv)};
    // tmux provides both the PTY and terminal-query emulation that native TUIs
    // require. Its private fixed socket/session deduplicates live runtimes even
    // when a bootstrap process restarts. Control mode keeps a lifetime observer
    // attached without requiring a human terminal or login.
    const transport=trustedTransport(),socket=path.join(root,'.zylos','upgrade','runtime.sock');
    if(fs.existsSync(socket)){const st=fs.lstatSync(socket);if(!st.isSocket()||st.isSymbolicLink()||(process.getuid&&st.uid!==process.getuid()))throw Error('unsafe recovery runtime socket');}
    const prefix=['-S',socket,'-f','/dev/null'];
    const observed=cp.spawnSync(transport,[...prefix,'has-session','-t','upgrade-recovery'],{cwd:root,env,stdio:'ignore',timeout:5000});
    if(observed.error)throw observed.error;
    const signature=promptSignature(d);
    if(observed.status===0){
      const query=cp.spawnSync(transport,[...prefix,'show-option','-qv','-t','upgrade-recovery','@core803-signature'],{cwd:root,env,encoding:'utf8',timeout:5000});
      if(query.error||query.status!==0)throw Error('cannot inspect recovery runtime prompt identity');
      if(query.stdout.trim()===signature)return {...out,observing:true};
      const send=(args,input)=>{const result=cp.spawnSync(transport,[...prefix,...args],{cwd:root,env,input,encoding:'utf8',timeout:5000});if(result.error||result.status!==0)throw Error('cannot deliver updated recovery prompt');};
      // A buffer carries literal prompt bytes; send-keys receives only Enter.
      // Attribution/liveness changes trigger one cue, never each phase update.
      send(['load-buffer','-b','core803-recovery','-'],prompt);
      send(['paste-buffer','-b','core803-recovery','-d','-t','upgrade-recovery']);
      send(['send-keys','-t','upgrade-recovery','Enter']);
      send(['set-option','-t','upgrade-recovery','@core803-signature',signature]);
      return {...out,observing:true,reprompted:true};
    }
    const command='exec '+[r.command,...r.args,prompt].map(shellWord).join(' ');
    const child=cp.spawn(transport,['-C',...prefix,'new-session','-s','upgrade-recovery','-x','120','-y','40','-c',root,command,';','set-option','-t','upgrade-recovery','@core803-signature',signature],{cwd:root,env,stdio:['pipe','inherit','inherit'],detached:true});
    child.recoverySocket=socket;
    child.on('error',e=>{process.stderr.write(e.message+'\n');});
    if(onChild)onChild(child);return {...out,launched:true};
  }
  return out;
}
// Stay available after an initially idle boot and after runtime exit. One live
// child is observed at a time; a new session may receive the unfinished task.
function supervise(root,{intervalMs=2000,write=out=>process.stdout.write(JSON.stringify(out)+'\n')}={}) {
  let child=null,stopped=false,last='';
  function tick(){
    if(stopped)return;
    try {
      const out=bootstrap(root,{launchRuntime:true,onChild:c=>{child=c;c.once('exit',()=>{if(child===c)child=null;});c.once('error',()=>{if(child===c)child=null;});}});
      const key=JSON.stringify(out);if(key!==last||out.launched){write(out);last=key;}
    }catch(e){const out={recovery_required:true,error:e.message};const key=JSON.stringify(out);if(key!==last){write(out);last=key;}}
  }
  const timer=setInterval(tick,intervalMs);tick();
  return ()=>{stopped=true;clearInterval(timer);if(child){
    const current=child;
    if(current.recoverySocket)cp.spawnSync(trustedTransport(),['-S',current.recoverySocket,'kill-session','-t','upgrade-recovery'],{stdio:'ignore',timeout:5000});
    try{process.kill(-current.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
    const deadline=setTimeout(()=>{try{process.kill(-current.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')process.stderr.write(e.message+'\n');}},5000);
    current.once('exit',()=>clearTimeout(deadline));
  }};
}
module.exports={bootstrap,recoveryPrompt,runtimeCapability,trustedTransport,supervise};
if(require.main===module){const args=process.argv.slice(2),i=args.indexOf('--root');try{
  if(i<0||!args[i+1])throw Error('--root is required');const root=path.resolve(args[i+1]);
  if(args.includes('--launch-runtime')&&!args.includes('--status')&&!args.includes('--once')){
    const stop=supervise(root);for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{stop();process.exitCode=0;});
  }else{const out=bootstrap(root,{once:args.includes('--once'),status:args.includes('--status')});process.stdout.write(JSON.stringify(out)+'\n');if(out.recovery_required)process.exitCode=1;}
}catch(e){process.stdout.write(JSON.stringify({recovery_required:true,error:e.message})+'\n');process.exitCode=1;}}
