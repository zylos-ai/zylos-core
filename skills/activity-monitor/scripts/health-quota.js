import fs from 'node:fs';
import path from 'node:path';
import { getClaudePid } from './claude-pid.js';
import { durableJson, runtimeRoot } from './runtime-generation.js';
import { readDeliveryIdentity } from '../../comm-bridge/scripts/runtime-delivery.js';

export const HEALTH_QUOTA_MAX_AGE_MS = 60000;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(value);
const scopeKeys=['runtime','session_id','claude_pid'];
function validIdentity(identity) {
  return identity?.runtime==='claude'&&id(identity.session_id)&&Number.isSafeInteger(identity.claude_pid)&&identity.claude_pid>0;
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

export function writeHealthQuota(status,{zylosDir=runtimeRoot(),nowMs=Date.now(),pid=getClaudePid(),managedIdentity=()=>readDeliveryIdentity({zylosDir})}={}) {
  const identity={runtime:'claude',session_id:status?.session_id,claude_pid:pid};
  if(!validIdentity(identity)||!Number.isSafeInteger(nowMs))return null;
  const foreground=managedIdentity();
  if(!foreground||!scopeKeys.every(key=>foreground[key]===identity[key]))return null;
  const snapshot={schema_version:1,source:'statusline',...identity,observed_at:nowMs,rate_limits:windows(status?.rate_limits,nowMs)};
  const directory=path.join(zylosDir,'activity-monitor','health-quota');
  durableJson(path.join(directory,'claude.json'),snapshot);
  return snapshot;
}

export function readHealthQuota({identity,zylosDir=runtimeRoot(),nowMs=Date.now(),maxAgeMs=HEALTH_QUOTA_MAX_AGE_MS}={}) {
  if(!validIdentity(identity))return null;
  try {
    const file=path.join(zylosDir,'activity-monitor','health-quota','claude.json');
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.size>2048)return null;
    return sanitizeHealthQuota(JSON.parse(fs.readFileSync(file,'utf8')),{identity,nowMs,maxAgeMs});
  } catch {return null;}
}

/** Read the current group's F5 directly; no separate quota snapshot or cross-group fallback. */
export function readScopedHealthQuota({runDir,runId,identity,nowMs=Date.now(),maxAgeMs=HEALTH_QUOTA_MAX_AGE_MS}={}) {
  if(!validIdentity(identity) || typeof runDir!=='string' || !path.isAbsolute(runDir) || typeof runId!=='string' || !runId)return null;
  try {
    const file=path.join(runDir,'statusline.json'),stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.size>1024*1024)return null;
    const sample=JSON.parse(fs.readFileSync(file,'utf8'));
    if(sample?.session_id!==identity.session_id || sample.zylos?.v!==1 || sample.zylos.runId!==runId)return null;
    // F5 identifies its producing run/session; the supplied process identity is
    // the caller's independently observed current scene, not a PID inferred here.
    return sanitizeHealthQuota({schema_version:1,source:'statusline',...Object.fromEntries(scopeKeys.map(key=>[key,identity[key]])),observed_at:sample.zylos.capturedAt,rate_limits:sample.rate_limits},{identity,nowMs,maxAgeMs});
  } catch {return null;}
}
