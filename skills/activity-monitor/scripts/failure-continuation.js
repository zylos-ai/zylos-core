import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
const { EventLogReader, appendEvent } = await loadCoreModule('event-log.js');

export const FAILURE_RETRY_DELAYS = [30000, 120000, 300000];
export const RETRYABLE_FAILURES = new Set(['server_error', 'overloaded', 'network_error']);

// Consult the persisted hook stream at the delivery boundary, even when AM has
// not consumed its latest batch. Rotated logs use the shared recovery reader.
export function continuationActivity(runDir, retry, {throughEventId, includeEnd = true} = {}) {
  const reader = new EventLogReader(path.join(runDir, 'events.jsonl'));
  let boundary = false;
  try {
    const rows = reader.recoverTail(row => {
      if (row.event_id === retry.eventId) { boundary = true; return {done:true}; }
      return {keep:true};
    });
    if (!boundary) return {cancelled:false,attempted:false,submitted:false,readable:false};
    let attempted = false, ownPrompt = false, cancelled = false;
    const end=throughEventId ? rows.findIndex(row=>row.event_id===throughEventId) : -1;
    for (const row of end<0 ? rows : rows.slice(0,end+(includeEnd?1:0))) {
      if (row.type === 'failure_continue' && row.failure_event_id === retry.eventId && row.run_id === retry.runId) attempted = true;
      if(row.type==='runtime_health' && row.session_id===retry.sessionId && row.claude_pid===retry.pid &&
         row.event==='stop_failure') cancelled=true;
      if (row.type !== 'runtime_health' || row.event !== 'prompt_submit' || row.runtime !== 'claude' ||
          row.session_id !== retry.sessionId || row.claude_pid !== retry.pid || row.agent_id) continue;
      if (attempted && !ownPrompt) ownPrompt = true;
      // Prompt hooks alone do not establish a new round: queued input can
      // report them while the old round is still running.
    }
    return {cancelled,attempted,submitted:attempted && ownPrompt,readable:true};
  } catch {
    return {cancelled:false,attempted:false,submitted:false,readable:false};
  } finally { reader.close(); }
}

export function markContinuationSubmission(runDir, retry, now = Date.now()) {
  appendEvent(path.join(runDir, 'events.jsonl'), {v:1,type:'failure_continue',failure_event_id:retry.eventId,run_id:retry.runId,ts:now});
}

export function reduceFailureContinuation(state, {runtime, event, identity, runId, pending, activity, eligible}) {
  if (runtime !== 'claude' || !runId) return false;
  let retry = state.failure_retry;
  if (retry && (retry.runId !== runId || retry.sessionId !== identity.session_id || retry.pid !== identity.claude_pid)) {
    delete state.failure_retry; retry = null;
  }
  if (event.event === 'stop') {
    // An old round's late Stop is not a new-round start. An accepted Continue
    // followed by Stop resets its budget; AM observes spontaneous new rounds.
    if(activity?.submitted) {
      delete state.failure_retry;delete state.pending_notice;
    }
    return false;
  }
  if (event.event !== 'stop_failure') return false;
  if (!RETRYABLE_FAILURES.has(event.error) || !eligible || (event.notice_match && !['temporary','warning'].includes(event.notice_match.kind))) { delete state.failure_retry; return false; }
  if(retry?.status==='exhausted' && !activity?.cancelled) { delete state.pending_notice; return true; }
  const attempts = retry && activity?.submitted && !activity.cancelled ? retry.attempts + 1 : 1;
  const continuing=retry && activity?.submitted && !activity.cancelled;
  const frozen = (continuing ? retry.notice : null) ?? pending;
  const notice = frozen ? {...frozen,event_id:event.event_id} : null;
  if (attempts > 3) {
    if(notice) state.pending_notice = {...notice, notice:{...notice.notice, noticeCode:'service_error_retries_exhausted'}};
    state.failure_retry={...retry,eventId:event.event_id,status:'exhausted'};
  } else {
    state.failure_retry = {runId,sessionId:identity.session_id,pid:identity.claude_pid,eventId:event.event_id,
      failedAt:event.received_at,attempts,dueAt:event.received_at+FAILURE_RETRY_DELAYS[attempts-1],notice};
    delete state.pending_notice;
  }
  return true;
}

// Called in AM's existing serialized health-writer section. Enqueue is
// idempotent across the DB commit / health write crash boundary.
export async function processFailureContinuation({store,scene,identity,bindTarget,insertControl,sessionGroup=scene.sessionGroup ?? 'origin',scope=scene.sessionGroup,readNativeActivity=()=>null,getPending=()=>null,getControl,expireControl=()=>{},now=Date.now}) {
  const state = store.read(sessionGroup), retry = state.failure_retry;
  if (!retry) return;
  const current = await identity();
  if (!current?.ready || current.runId !== retry.runId || current.sessionId !== retry.sessionId || current.runtime !== 'claude') {
    delete state.failure_retry; store.write(state,sessionGroup); return;
  }
  if(retry.controlId && getControl) {
    const row=getControl(retry.controlId);
    if(!row || ['timeout','superseded','failed','cancelled'].includes(row.status)) {
      delete state.failure_retry;store.write(state,sessionGroup);return;
    }
  }
  const activity = continuationActivity(scene.runDir,retry);
  let native;try{native=readNativeActivity();}catch{/* No observed start; do not infer missing round history. */}
  const resumed=!activity.attempted && Number.isFinite(native?.turnStartedAt) && native.turnStartedAt>retry.failedAt;
  const pending=now()>=retry.dueAt && getPending(scope===null?undefined:{sessionGroups:[scope]});
  if(activity.cancelled || resumed || pending) {
    if(retry.controlId)await expireControl(retry.controlId);
    delete state.failure_retry;delete state.pending_notice;store.write(state,sessionGroup);return;
  }
  if(retry.status==='exhausted' || retry.controlId || activity.attempted)return;
  const binding = await bindTarget();
  const row = insertControl('Continue',{sessionGroup:scope,
    targetBinding:{...binding,expectedSessionId:retry.sessionId,failureContinue:{eventId:retry.eventId,failedAt:retry.failedAt,pid:retry.pid}},
    priority:0,requireIdle:true,bypassState:false,appendAckSuffix:false,availableAt:Math.ceil(retry.dueAt/1000)});
  state.failure_retry = {...retry,controlId:row.id};
  store.write(state,sessionGroup);
}
