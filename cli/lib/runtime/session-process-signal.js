import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const unavailable = (message, detail, cause='error') => Object.assign(new Error(message),
  {code:'PROCESS_SIGNAL_UNAVAILABLE',cause},detail ? {detail} : {});
/** Pin before inspecting ownership. Only this helper ever sends target signals.
 * The private pipe controls a kernel pidfd; no numeric-PID fallback is allowed.
 * Missing build output and unsupported/denied syscalls fail closed.
 */
export async function pinProcess(pid, {binary=fileURLToPath(new URL(`./native/pidfd-signal-${process.arch}`,import.meta.url)),
  platform=process.platform, timeoutMs=3000}={}) {
  if (platform!=='linux' || !Number.isSafeInteger(pid) || pid<=0) throw unavailable('Identity-bound signalling unavailable');
  const child=spawn(binary,[String(pid)],{stdio:['pipe','pipe','ignore'],env:{}});
  let pending, failure, ended=false, buffer='';
  let resolveExit;
  const exited=new Promise(resolve=>{resolveExit=resolve;});
  const fail=error=>{
    failure ||= error;
    if(pending) {const slot=pending;pending=undefined;clearTimeout(slot.timer);slot.reject(failure);}
  };
  const waitLine=()=>new Promise((resolve,reject)=>{
    if(failure || ended) {reject(failure || unavailable('Signal helper has exited'));return;}
    if(pending) {reject(unavailable('Concurrent signal helper request'));return;}
    const timer=setTimeout(()=>{fail(unavailable('Signal helper response unavailable',undefined,'timeout'));child.stdin.destroy();child.kill('SIGKILL');},timeoutMs);
    pending={resolve,reject,timer};
  });
  child.on('error',error=>fail(unavailable('Cannot start identity-bound signal helper',error)));
  child.stdin.on('error',error=>fail(unavailable('Signal helper input unavailable',error)));
  child.on('close',()=>{ended=true;fail(unavailable('Signal helper closed before response'));resolveExit();});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',data=>{
    buffer+=data;
    if(buffer.length>1024) {fail(unavailable('Invalid signal helper response'));child.kill('SIGKILL');return;}
    let end;
    while((end=buffer.indexOf('\n'))!==-1) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      const slot=pending;
      if(!slot) {fail(unavailable('Unsolicited signal helper response'));child.kill('SIGKILL');return;}
      pending=undefined;clearTimeout(slot.timer);slot.resolve(line);
    }
  });
  const close=async()=>{
    if(ended)return;
    child.stdin.end();
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
    try {await exited;} finally {clearTimeout(timer);}
  };
  try {
    const ready=await waitLine();
    if(ready==='GONE') {await close();return null;}
    if(ready!=='READY') throw unavailable(`Cannot acquire process handle: ${ready}`);
    return {
      async signal(signal) {
        const command={SIGTERM:'TERM\n',SIGKILL:'KILL\n'}[signal];
        if(!command)throw unavailable('Unsupported process signal');
        const response=waitLine();
        if(!failure && !ended) {
          try {child.stdin.write(command);} catch(error) {fail(unavailable('Signal helper input unavailable',error));}
        }
        const line=await response;
        if(line==='GONE')return false;
        if(line==='OK')return true;
        throw unavailable(`Identity-bound signal failed: ${line}`);
      },
      close,
    };
  } catch(error) {await close();throw error;}
}
