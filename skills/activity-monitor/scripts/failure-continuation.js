export const FAILURE_RETRY_DELAYS = [30000, 120000, 300000];
export const RETRYABLE_FAILURES = new Set(['server_error', 'overloaded', 'network_error']);

export function reduceFailureContinuation(state, {runtime, event, identity, runId, pending, control, eligible}) {
  if (runtime !== 'claude' || !runId) return false;
  let retry=state.failure_retry;
  if(retry && (retry.runId!==runId || retry.sessionId!==identity.session_id || retry.pid!==identity.claude_pid)) {
    delete state.failure_retry;retry=null;control=null;
  }
  if(control?.status==='failed') {
    if(retry?.notice)state.pending_notice=retry.notice;
    delete state.failure_retry;return true;
  }
  const submitted=control?.status==='done' && retry && event.received_at>=retry.dueAt;
  if(event.event==='stop') {
    if(submitted) {delete state.failure_retry;delete state.pending_notice;}
    return false;
  }
  if(event.event!=='stop_failure')return false;
  if(!RETRYABLE_FAILURES.has(event.error) || !eligible || (event.notice_match && !['temporary','warning'].includes(event.notice_match.kind))) {
    delete state.failure_retry;return false;
  }
  const continuing=retry && submitted;
  const attempts=continuing ? retry.attempts+1 : 1;
  const frozen=(continuing ? retry.notice : null) ?? pending;
  const notice=frozen ? {...frozen,event_id:event.event_id} : null;
  const next={runId,sessionId:identity.session_id,pid:identity.claude_pid,eventId:event.event_id,
    failedAt:event.received_at,attempts,notice};
  if(attempts>3) {
    if(notice)state.pending_notice=notice;
    delete state.failure_retry;
  } else {
    state.failure_retry={...next,dueAt:event.received_at+FAILURE_RETRY_DELAYS[attempts-1]};
    delete state.pending_notice;
  }
  return true;
}

// Use the existing control lifecycle. Running means claimed, not confirmed sent.
export async function processFailureContinuation({store,scene,identity,bindTarget,insertControl,
  sessionGroup=scene.sessionGroup ?? 'origin',scope=scene.sessionGroup,readNativeActivity=()=>null,
  getPending=()=>null,getControl,expireControl=()=>{},now=Date.now}) {
  const state=store.read(sessionGroup),retry=state.failure_retry;
  if(!retry)return;
  const current=await identity();
  if(!current?.ready || current.runId!==retry.runId || current.sessionId!==retry.sessionId || current.runtime!=='claude') {
    delete state.failure_retry;store.write(state,sessionGroup);return;
  }
  const control=retry.controlId ? getControl(retry.controlId) : null;
  if(retry.controlId && (!control || ['timeout','superseded','failed'].includes(control.status))) {
    if(control?.status==='failed' && retry.notice)state.pending_notice=retry.notice;
    delete state.failure_retry;store.write(state,sessionGroup);return;
  }
  let native;try{native=readNativeActivity();}catch{/* Do not infer unobserved round history. */}
  const ownDelivery=control && ['running','done'].includes(control.status);
  const resumed=!ownDelivery && Number.isFinite(native?.turnStartedAt) && native.turnStartedAt>retry.failedAt;
  const pending=now()>=retry.dueAt && (!control || control.status==='pending') &&
    getPending(scope===null?undefined:{sessionGroups:[scope]});
  if(resumed || pending) {
    if(retry.controlId)await expireControl(retry.controlId);
    delete state.failure_retry;delete state.pending_notice;store.write(state,sessionGroup);return;
  }
  if(retry.controlId)return;
  const binding=await bindTarget();
  const row=insertControl('Continue',{sessionGroup:scope,
    targetBinding:{...binding,expectedSessionId:retry.sessionId},priority:0,requireIdle:true,
    bypassState:false,appendAckSuffix:false,availableAt:Math.ceil(retry.dueAt/1000)});
  state.failure_retry={...retry,controlId:row.id};store.write(state,sessionGroup);
}
