import fs from 'node:fs';
import path from 'node:path';
import { getClaudePid } from './claude-pid.js';
import { durableJson, readRuntimeGeneration, readProcessStart, runtimeRoot, syncDirectory } from './runtime-generation.js';

export const HEALTH_QUOTA_MAX_AGE_MS = 60000;
const uuid=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(value);
const proof=value=>typeof value==='string'&&/^[0-9a-f-]{36}:\d+$/.test(value);
const scopeKeys=['runtime','runtime_generation','session_id','claude_pid','process_start'];
function validIdentity(identity) {
  return identity?.runtime==='claude'&&uuid(identity.runtime_generation)&&id(identity.session_id)&&Number.isSafeInteger(identity.claude_pid)&&identity.claude_pid>0&&proof(identity.process_start);
}
function windows(raw, nowMs) {
  const result={};
  for(const name of ['five_hour','seven_day']) {
    const value=raw?.[name];
    if(typeof value?.used_percentage!=='number'||!Number.isFinite(value.used_percentage)||value.used_percentage<0||value.used_percentage>100)continue;
    const reset=value.resets_at;
    // A declared expired or malformed reset invalidates that window, rather
    // than preserving an apparently exhausted window after its reset.
    if(reset!==undefined&&(!Number.isSafeInteger(reset)||reset<=nowMs/1000||reset>nowMs/1000+8*86400))continue;
    result[name]={used_percentage:value.used_percentage,...(reset===undefined?{}:{resets_at:reset})};
  }
  return result;
}

export function sanitizeHealthQuota(snapshot,{identity,nowMs=Date.now(),maxAgeMs=HEALTH_QUOTA_MAX_AGE_MS}={}) {
  if(!validIdentity(identity)||snapshot?.schema_version!==1||snapshot.source!=='statusline'||!scopeKeys.every(key=>snapshot[key]===identity[key])||!Number.isSafeInteger(snapshot.observed_at)||snapshot.observed_at>nowMs||nowMs-snapshot.observed_at>maxAgeMs)return null;
  const rate_limits=windows(snapshot.rate_limits,nowMs);
  if(!Object.keys(rate_limits).length)return null;
  return {schema_version:1,source:'statusline',...Object.fromEntries(scopeKeys.map(key=>[key,identity[key]])),observed_at:snapshot.observed_at,rate_limits};
}

export function writeHealthQuota(status,{zylosDir=runtimeRoot(),env=process.env,nowMs=Date.now(),pid=getClaudePid(),processStart=readProcessStart(pid)}={}) {
  const generation=readRuntimeGeneration(zylosDir);
  if(generation?.runtime!=='claude'||env.ZYLOS_RUNTIME_ID!=='claude'||env.ZYLOS_RUNTIME_GENERATION!==generation.runtime_generation)return null;
  const identity={runtime:'claude',runtime_generation:generation.runtime_generation,session_id:status?.session_id,claude_pid:pid,process_start:processStart};
  if(!validIdentity(identity)||!Number.isSafeInteger(nowMs))return null;
  let foreground;
  try {foreground=JSON.parse(fs.readFileSync(path.join(zylosDir,'activity-monitor','foreground-session.json'),'utf8'));}catch{return null;}
  if(!scopeKeys.filter(key=>key!=='runtime').every(key=>foreground[key]===identity[key]))return null;
  const snapshot={schema_version:1,source:'statusline',...identity,observed_at:nowMs,rate_limits:windows(status?.rate_limits,nowMs)};
  const directory=path.join(zylosDir,'activity-monitor','health-quota');
  durableJson(path.join(directory,`${identity.runtime_generation}.json`),snapshot);
  // Only exact generated filenames are eligible. Cleanup order is not evidence
  // order; neither this ordering nor file timestamps authorize quota use.
  const old=fs.readdirSync(directory).filter(name=>/^[0-9a-f-]{36}\.json$/.test(name)&&name!==`${identity.runtime_generation}.json`).sort();
  for(const name of old.slice(0,Math.max(0,old.length-3)))fs.unlinkSync(path.join(directory,name));
  // Canceled statusLine children can leave unpublished atomic-write files.
  // Their age controls garbage collection only, never evidence validity.
  let removedTemp=false;
  for(const name of fs.readdirSync(directory)) {
    if(!/^[0-9a-f-]{36}\.json\.[0-9a-f-]{36}\.tmp$/.test(name))continue;
    const file=path.join(directory,name);
    try {
      const stat=fs.lstatSync(file);
      if(stat.isFile()&&stat.mtimeMs<Date.now()-60000) {fs.unlinkSync(file);removedTemp=true;}
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(old.length>3||removedTemp)syncDirectory(directory);
  return snapshot;
}

export function readHealthQuota({identity,zylosDir=runtimeRoot(),nowMs=Date.now(),maxAgeMs=HEALTH_QUOTA_MAX_AGE_MS,processStart=readProcessStart}={}) {
  if(!validIdentity(identity))return null;
  const generation=readRuntimeGeneration(zylosDir);
  if(generation?.runtime!=='claude'||generation.runtime_generation!==identity.runtime_generation||processStart(identity.claude_pid)!==identity.process_start)return null;
  try {
    const file=path.join(zylosDir,'activity-monitor','health-quota',`${identity.runtime_generation}.json`);
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.size>2048)return null;
    return sanitizeHealthQuota(JSON.parse(fs.readFileSync(file,'utf8')),{identity,nowMs,maxAgeMs});
  } catch {return null;}
}
