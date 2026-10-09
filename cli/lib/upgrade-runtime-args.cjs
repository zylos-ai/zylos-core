'use strict';
// The stable boot path launches a new interactive session with exactly one
// recovery prompt. Subcommands, existing prompts and resume modes are excluded.
const FLAGS={
  codex:new Set(['--no-daemon','--dangerously-bypass-approvals-and-sandbox','--no-alt-screen']),
  claude:new Set(['--dangerously-skip-permissions','--allow-dangerously-skip-permissions','--verbose']),
};
const VALUES={
  codex:new Set(['--model','-m','--profile','-p','--sandbox','-s','--ask-for-approval','-a']),
  claude:new Set(['--model','--permission-mode','--effort']),
};
function validateRuntimeArgs(kind,args){
  if(!FLAGS[kind]||!Array.isArray(args)||args.length>64)throw Error('invalid runtime launch arguments');
  for(let i=0;i<args.length;i++){
    const arg=args[i];if(typeof arg!=='string'||arg.length>4096||/[\0\r\n]/.test(arg))throw Error('invalid runtime launch arguments');
    if(FLAGS[kind].has(arg))continue;
    if(VALUES[kind].has(arg)){
      const value=args[++i];if(typeof value!=='string'||!value||value.length>4096||value.startsWith('-')||/[\0\r\n]/.test(value))throw Error('invalid runtime flag value');
      continue;
    }
    throw Error('unsupported runtime argument (subcommands and positional prompts are forbidden)');
  }
  return args;
}
function validateRuntimeNetworkEnv(value){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid runtime network environment');
  const out={};
  for(const [key,entry] of Object.entries(value)){
    if(!['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'].includes(key)||typeof entry!=='string'||entry.length>4096||/[\0\r\n]/.test(entry))throw Error('unsupported runtime network environment');
    if(key!=='NO_PROXY'&&entry){const url=new URL(entry);if(!['http:','https:','socks5:','socks5h:'].includes(url.protocol)||url.username||url.password)throw Error('runtime proxy must be a supported credential-free URL');}
    out[key]=entry;
  }
  return out;
}
module.exports={validateRuntimeArgs,validateRuntimeNetworkEnv};
