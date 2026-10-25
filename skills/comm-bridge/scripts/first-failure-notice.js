import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDb, close, finishStatusNotice } from './c4-db.js';
import { reserveStatusNotice, sendStatusNotice, logStatusNotice } from './status-notice.js';
import { messageForStatus } from './status-notice-templates.js';
import { readDeliveryIdentity } from './runtime-delivery.js';
import { runtimeRoot } from '../../activity-monitor/scripts/runtime-generation.js';
import { readHealthQuota } from '../../activity-monitor/scripts/health-quota.js';
import { currentOutageNotice } from '../../activity-monitor/scripts/outage-notice.js';

export const FIRST_NOTICE_QUOTA_WAIT_MS = 750;

// Called before the atomic health write; this endpoint cannot change afterwards.
export function freezeFirstFailureNotice(database, { runtime, identity, event, result, sessionGroup = null }) {
  if (event.event !== 'stop_failure' || result.status !== 'processed' || result.verify || !result.notice?.eligible ||
      !identity?.session_id || !Number.isSafeInteger(identity.claude_pid) || identity.claude_pid<=0) return null;
  const target = database.prepare(`SELECT id, channel, endpoint_id FROM conversations
    WHERE direction='in' AND status IN ('running','delivered') AND endpoint_id IS NOT NULL AND endpoint_id!=''
    AND channel NOT IN ('void','system','internal','control') AND session_group IS ? ORDER BY id DESC LIMIT 1`).get(sessionGroup ?? '');
  if (!target) return null;
  return { event_id:event.event_id, runtime, session_group:sessionGroup, session_id:identity.session_id,
    claude_pid:identity.claude_pid, conversation_id:target.id, channel:target.channel, endpoint:target.endpoint_id,
    health:event.error === 'rate_limit' ? 'rate_limited' : event.error === 'authentication_failed' ? 'auth_failed' : 'unavailable',
    reason:result.notice.reason || event.error, error:event.error, created_at:event.received_at, notice:result.notice, status:'pending' };
}

function sameScope(intent, identity) {
  return !!identity && intent.runtime === identity.runtime && intent.session_id === identity.session_id &&
    intent.claude_pid === identity.claude_pid;
}

// Only the child performs blocking channel I/O; AM remains the sole state writer.
export function sendNoticeWorker(claim, message, route, { zylosDir = runtimeRoot(), spawnWorker = spawn } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = (result, workerExitCode = null, workerSignal = null) => {
      if (done) return;
      done = true;
      logStatusNotice(claim, route, result.outcome, { status:result.exitCode, signal:result.signal,
        workerExitCode, workerSignal }, {zylosDir});
      resolve(result);
    };
    let child;
    try { child = spawnWorker(process.execPath, [fileURLToPath(import.meta.url), '--send'], {
      env:{...process.env, ZYLOS_DIR:zylosDir}, stdio:['pipe','pipe','ignore'], timeout:35000, killSignal:'SIGKILL',
    }); } catch (error) {
      finish({outcome:['ENOENT','EACCES'].includes(error.code)?'failed':'uncertain'});
      return;
    }
    let output = '';
    let workerError;
    child.stdout.on('data', chunk => { if (output.length < 8192) output += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', error => { workerError = error; });
    child.once('close', (code, signal) => {
      if (workerError) {
        finish({outcome:['ENOENT','EACCES'].includes(workerError.code) && !child.pid ? 'failed':'uncertain'},code,signal);
        return;
      }
      try {
        const result = code === 0 && !signal ? JSON.parse(output) : null;
        if (!['sent','failed','uncertain'].includes(result?.outcome)) throw new Error('Invalid worker result');
        finish(result,code,signal);
      } catch { finish({outcome:'uncertain'},code,signal); }
    });
    child.stdin.end(JSON.stringify({claim,message,route}));
  });
}

export async function processFirstFailureNotices({ store, database = getDb(), identity = readDeliveryIdentity,
  reserve = reserveStatusNotice, send = sendNoticeWorker, now = Date.now,
  quota = current => readHealthQuota({identity:current,nowMs:now()}), quotaWaitMs = 0, zylosDir = runtimeRoot(), sessionGroup = 'origin', mutate = operation => operation() } = {}) {
  const intent = store.read(sessionGroup).pending_notice;
  if (!intent || intent.status !== 'pending') return 0;
  const finish = status => mutate(() => store.updatePending(intent.event_id, {status, updated_at:now()},sessionGroup));
  const current = await identity();
  if (!sameScope(intent,current)) { await finish('stale'); return 1; }
  const target = database.prepare('SELECT status FROM conversations WHERE id=?').get(intent.conversation_id);
  if (!['running','delivered'].includes(target?.status)) { await finish('suppressed'); return 1; }
  let notice = intent.notice;
  if (intent.error === 'rate_limit') {
    const state = store.read(sessionGroup);
    if (state.evidence_id === intent.event_id && state.health === 'rate_limited') {
      const enriched = currentOutageNotice(state,current,quota(current),now());
      if (enriched.annotation) notice = enriched.notice;
      if (!enriched.annotation && notice?.noticeCode !== 'quota_exhausted_reset' && now()-intent.created_at < Math.min(quotaWaitMs,FIRST_NOTICE_QUOTA_WAIT_MS)) return 0;
    }
  }
  const route = {sessionGroup:intent.session_group ?? sessionGroup,runtime:intent.runtime,health:intent.health, reason:intent.reason, context:'failure',noticeKind:'first-failure',noticeCode:notice?.noticeCode,resetAt:notice?.resetAt};
  let claim;
  try { claim = reserve(intent.channel,intent.endpoint,route); }
  catch { await finish('failed'); return 1; }
  if (claim.suppressed) { await finish('suppressed'); return 1; }
  if (!sameScope(intent,await identity())) {
    finishStatusNotice(claim,'failed',{now:Math.floor(now()/1000)},database);
    await finish('stale'); return 1;
  }
  // A restart after this point must never resend this same pending intent.
  if (!await mutate(() => store.updatePending(intent.event_id,{status:'sending',updated_at:now()},sessionGroup))) {
    finishStatusNotice(claim,'failed',{now:Math.floor(now()/1000)},database);
    return 0;
  }
  let outcome = 'uncertain';
  try { outcome = (await send(claim,messageForStatus(route),route,{zylosDir})).outcome; }
  catch { /* The channel might have accepted the send. Keep its reservation. */ }
  finishStatusNotice(claim,outcome,{now:Math.floor(now()/1000)},database);
  await finish(outcome);
  return 1;
}

const draining = new WeakMap();
export function drainFirstFailureNotices(options = {}) {
  if(!options.store)return Promise.resolve();
  const group=options.sessionGroup ?? 'origin';
  let groups=draining.get(options.store);if(!groups){groups=new Map();draining.set(options.store,groups);}
  if(groups.has(group))return groups.get(group);
  if (options.store.read(group).pending_notice?.status !== 'pending') return Promise.resolve();
  const pending = (async () => {
    await processFirstFailureNotices({...options,quotaWaitMs:FIRST_NOTICE_QUOTA_WAIT_MS});
    if (options.store.read(group).pending_notice?.status === 'pending') {
      await new Promise(resolve => setTimeout(resolve,FIRST_NOTICE_QUOTA_WAIT_MS));
      await processFirstFailureNotices(options);
    }
  })().finally(() => {groups.delete(group);});
  groups.set(group,pending);return pending;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--send') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const {claim,message,route} = JSON.parse(input);
    process.stdout.write(JSON.stringify(sendStatusNotice(claim,message,route,{diagnostic:false})));
  } finally { close(); }
}
