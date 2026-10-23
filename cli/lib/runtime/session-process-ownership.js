import fs from 'node:fs/promises';
import path from 'node:path';

const missing = error => ['ENOENT','ESRCH'].includes(error.code);
const changed = () => Object.assign(new Error('Process incarnation changed during ownership observation'), {code:'PROCESS_IDENTITY_CHANGED'});
function identity(text,pid) {
  const end=text.lastIndexOf(')');
  const fields=text.slice(end+2).trim().split(/\s+/);
  if (!text.startsWith(`${pid} (`) || end<0 || !/^[A-Za-z]$/.test(fields[0]) || !/^\d+$/.test(fields[19])) throw new Error('Incomplete process ownership identity');
  return {start:fields[19],zombie:fields[0]==='Z'};
}

/** Exact UID/run ownership with an incarnation bracketing the environment read.
 * This is observation, not a handle. Signal callers must pin the target before
 * using this observation as authorization; a subsequent numeric kill is unsafe.
 */
export async function readOwnedProcess(pid,runId,{procRoot='/proc',platform=process.platform,uid=process.getuid?.(),filesystem=fs}={}) {
  if (platform!=='linux' || uid===undefined || !Number.isSafeInteger(pid) || pid<=0) throw new Error('Process ownership observation unavailable');
  const dir=path.join(procRoot,String(pid));
  const gone=async error=>{
    if(!missing(error))return false;
    const root=await filesystem.stat(procRoot);
    if(!root.isDirectory())throw new Error('Process root unavailable');
    return true;
  };
  let before;
  try {
    if((await filesystem.stat(dir)).uid!==uid)return null;
    before=identity(await filesystem.readFile(path.join(dir,'stat'),'utf8'),pid);
  } catch(error) {if(await gone(error))return null;throw error;}
  if(before.zombie)return null;
  let env,readError;
  try {env=await filesystem.readFile(path.join(dir,'environ'));}catch(error){readError=error;}
  let after,owner;
  try {
    after=identity(await filesystem.readFile(path.join(dir,'stat'),'utf8'),pid);
    owner=(await filesystem.stat(dir)).uid;
  } catch(error){if(await gone(error))return null;throw error;}
  if(after.start!==before.start || owner!==uid)throw changed();
  if(after.zombie)return null;
  if(readError)throw readError;
  return env.toString().split('\0').includes(`ZYLOS_RUN_ID=${runId}`) ? {pid,start:before.start} : null;
}
