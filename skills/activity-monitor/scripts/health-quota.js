import path from 'node:path';
import { loadCoreModule } from './core-modules.js';

const { runtimesWith } = await loadCoreModule('runtime/descriptors.js');

export const HEALTH_QUOTA_MAX_AGE_MS = 60000;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(value);
const scopeKeys=['runtime','session_id','claude_pid'];
export function healthQuotaRuntime(runtime) {
  return runtimesWith('hookHealth').includes(runtime) && runtimesWith('accountQuota').includes(runtime);
}

function validIdentity(identity) {
  return healthQuotaRuntime(identity?.runtime)&&id(identity.session_id)&&Number.isSafeInteger(identity.claude_pid)&&identity.claude_pid>0;
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

/** Read the current group's F5 directly; no separate quota snapshot or cross-group fallback. */
export function readScopedHealthQuota({runDir,runId,identity,nowMs=Date.now(),maxAgeMs=HEALTH_QUOTA_MAX_AGE_MS,read}={}) {
  if(!validIdentity(identity) || typeof runDir!=='string' || !path.isAbsolute(runDir) || typeof runId!=='string' || !runId)return null;
  if(typeof read!=='function')return null;
  const raw=read({runDir,runId,sessionId:identity.session_id});
  if(!raw)return null;
  return sanitizeHealthQuota({schema_version:1,source:'statusline',...Object.fromEntries(scopeKeys.map(key=>[key,identity[key]])),
    observed_at:raw.observedAt,rate_limits:raw.rateLimits},{identity,nowMs,maxAgeMs});
}
