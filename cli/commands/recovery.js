import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {ZYLOS_DIR} from '../lib/config.js';
import {deployUpgradeBootstrap,maintenance} from '../lib/upgrade-protection.js';
import {verifyUpgradeBootCapability,validateRuntimeNetworkEnv} from '../lib/upgrade-boot-capability.js';
const require=createRequire(import.meta.url);
function literal(value){
 if(/[\0\r\n$%\\"]/.test(value))throw Error('unsupported literal systemd path');
 return '"'+value+'"';
}
export function recoveryConfiguration({root=ZYLOS_DIR,runtime,command,home=os.homedir(),nodePath=process.execPath,networkEnv}){
 root=fs.realpathSync(root);
 if(!['codex','claude'].includes(runtime)||!path.isAbsolute(command)||path.basename(command)!==runtime)throw Error('select an absolute codex or claude executable');
 const st=fs.statSync(fs.realpathSync(command));
 if(!st.isFile()||!(st.mode&0o111)||(st.mode&0o022)||![0,process.getuid?.()].includes(st.uid))throw Error('unsafe runtime executable');
 const bootstrap=path.join(root,'.zylos','upgrade','bootstrap.cjs');
 const capability={formatVersion:1,supervisor:{kind:'systemd',scope:'user',unit:'zylos-upgrade-recovery.service'},runtime:{kind:runtime,command,cwd:root,args:runtime==='codex'?['--dangerously-bypass-approvals-and-sandbox']:['--dangerously-skip-permissions'],...(networkEnv?{networkEnv:validateRuntimeNetworkEnv(networkEnv)}:{})}};
 const unit='[Unit]\nDescription=Zylos file-only upgrade recovery\n\n[Service]\nType=simple\nExecStart='+[nodePath,bootstrap,'--root',root,'--launch-runtime'].map(literal).join(' ')+'\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n';
 return {capability,unit,unitPath:path.join(home,'.config','systemd','user','zylos-upgrade-recovery.service'),capabilityPath:path.join(root,'.zylos','upgrade','capability.json'),root};
}
export async function recoveryCommand(args){
 const sub=args[0]||'status';
 if(args.includes('--help')||args.includes('-h')){console.log('Usage: zylos recovery status | verify | configure --runtime codex|claude [--command /absolute/path] [--inherit-proxy] [--write]\nconfigure previews files by default; --write saves them but does not enable or start services.');return;}
 if(sub==='status'){
  const entry=path.join(ZYLOS_DIR,'.zylos','upgrade','bootstrap.cjs');
  console.log(JSON.stringify(fs.existsSync(entry)?require(entry).bootstrap(ZYLOS_DIR,{status:true}):{active:false,bootstrapDeployed:false},null,2));return;
 }
 if(sub==='verify'){console.log(JSON.stringify(verifyUpgradeBootCapability({zylosDir:ZYLOS_DIR,nodePath:process.execPath,bootstrapPath:path.join(ZYLOS_DIR,'.zylos','upgrade','bootstrap.cjs')}),null,2));return;}
 if(sub!=='configure')throw Error('unknown recovery command');
 const runtimePos=args.indexOf('--runtime');
 const runtime=runtimePos>=0?args[runtimePos+1]:null;
 if(!['codex','claude'].includes(runtime))throw Error('configure requires --runtime codex or --runtime claude');
 const pos=args.indexOf('--command');
 const command=pos>=0?args[pos+1]:execFileSync('which',[runtime],{encoding:'utf8',timeout:10000}).trim();
 const networkEnv=args.includes('--inherit-proxy')?Object.fromEntries(['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])):undefined;
 const config=recoveryConfiguration({runtime,command,networkEnv});
 if(args.includes('--write')){
  const discovered=maintenance.discover(ZYLOS_DIR);
  if(discovered.marker||discovered.candidates.length||discovered.diagnostics.length)throw Error('cannot configure during unresolved upgrade');
  for(const [file,text] of [[config.unitPath,config.unit],[config.capabilityPath,JSON.stringify(config.capability,null,2)+'\n']]){
   if(fs.existsSync(file)){maintenance.privatePath(file);if(fs.readFileSync(file,'utf8')!==text)throw Error('existing recovery configuration differs; review it before replacing');}
  }
  deployUpgradeBootstrap(ZYLOS_DIR);
  maintenance.durable(config.capabilityPath,config.capability);
  fs.mkdirSync(path.dirname(config.unitPath),{recursive:true});
  const fd=fs.openSync(config.unitPath,'w',0o600);try{fs.writeFileSync(fd,config.unit);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}maintenance.fsyncDir(path.dirname(config.unitPath));
 }
 const preview={...config,capability:{...config.capability,runtime:{...config.capability.runtime,...(networkEnv?{networkEnv:Object.fromEntries(Object.keys(networkEnv).map(key=>[key,'[configured]']))}:{})}}};
 console.log(JSON.stringify({...preview,written:args.includes('--write'),nextCommands:['systemctl --user daemon-reload','systemctl --user enable --now zylos-upgrade-recovery.service','loginctl enable-linger '+os.userInfo().username,'zylos recovery verify']},null,2));
}
