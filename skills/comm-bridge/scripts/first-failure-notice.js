import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDb, close, finishStatusNotice } from './c4-db.js';
import { reserveStatusNotice, sendStatusNotice } from './status-notice.js';
import { messageForStatus } from './status-notice-templates.js';
import { readDeliveryIdentity, cleanupFailureNoticeHistory } from './runtime-delivery.js';
export { cleanupFailureNoticeHistory } from './runtime-delivery.js';
import { runtimeRoot } from '../../activity-monitor/scripts/runtime-generation.js';
import { readHealthQuota } from '../../activity-monitor/scripts/health-quota.js';
import { currentOutageNotice, restoreOutageAnchor } from '../../activity-monitor/scripts/outage-notice.js';

export const FIRST_NOTICE_QUOTA_WAIT_MS = 750;

// Called by AM inside the same transaction that consumes the terminal event.
// Selection is frozen at event consumption; future deliveries cannot retarget it.
export function enqueueFirstFailureNotice(database, { runtime, state, identity, event, result }) {
  if (event?.event !== 'stop_failure' || result?.status !== 'processed' || result.verify ||
      ['unordered_failure','missing_prompt','duplicate'].includes(result.reason) ||
      !identity?.runtime_generation || !identity.session_id || !identity.process_start ||
      event.runtime_generation !== identity.runtime_generation || event.session_id !== identity.session_id ||
      event.process_start !== identity.process_start) return false;
  // A factual failure reply is separate from persistent runtime health.
  if (!result.notice?.eligible) return false;
  const delivery = database.prepare(`SELECT * FROM runtime_deliveries WHERE runtime_id=?
    AND runtime_generation=? AND session_id=? AND process_start=? AND started_at<=?
    ORDER BY id DESC LIMIT 1`).get(runtime,identity.runtime_generation,identity.session_id,identity.process_start,event.received_at);
  // Freeze an in-flight candidate too: a fast failure can arrive before the
  // dispatcher's verification finishes. Never fall back to an older message.
  if (!delivery || !['delivered','submitting'].includes(delivery.status)) return false;
  const health = event.error === 'rate_limit' ? 'rate_limited' : event.error === 'authentication_failed' ? 'auth_failed' : 'unavailable';
  const episode = state.health !== 'ok' ? `${runtime}:${state.episode}` : `failure:${event.event_id}`;
  return database.prepare(`INSERT OR IGNORE INTO runtime_notice_intents
    (event_id,runtime_id,runtime_generation,session_id,process_start,conversation_id,delivery_id,channel,endpoint,
     health,reason,health_episode,created_at,updated_at,notice_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(event.event_id,runtime,identity.runtime_generation,identity.session_id,identity.process_start,
      delivery.conversation_id,delivery.id,delivery.channel,delivery.endpoint,health,event.error,episode,event.received_at,event.received_at,JSON.stringify(result.notice)).changes === 1;
}

function sameScope(intent, identity) {
  return !!identity && intent.runtime_id === identity.runtime && intent.runtime_generation === identity.runtime_generation &&
    intent.session_id === identity.session_id && intent.process_start === identity.process_start;
}

export function processFirstFailureNotices({ database = getDb(), identity = readDeliveryIdentity,
  reserve = reserveStatusNotice, send = sendStatusNotice, now = Date.now, limit = 8,
  quota = current => readHealthQuota({identity:current,nowMs:now()}), quotaWaitMs = 0 } = {}) {
  const intents = database.prepare("SELECT * FROM runtime_notice_intents WHERE status='pending' ORDER BY created_at,event_id LIMIT ?").all(limit);
  const finish = (intent,status) => database.prepare("UPDATE runtime_notice_intents SET status=?,updated_at=? WHERE event_id=? AND status='pending'")
    .run(status,now(),intent.event_id);
  for (const intent of intents) {
    const current = identity();
    if (!current?.session_id || !current.process_start) continue;
    if (!sameScope(intent,current)) { finish(intent,'stale'); continue; }
    const delivery = database.prepare('SELECT * FROM runtime_deliveries WHERE id=?').get(intent.delivery_id);
    if (!delivery || delivery.runtime_generation !== intent.runtime_generation || delivery.session_id !== intent.session_id ||
        delivery.process_start !== intent.process_start || delivery.started_at > intent.created_at || delivery.status === 'uncertain') {
      finish(intent,'suppressed'); continue;
    }
    if (delivery.status === 'submitting') {
      if (now() - intent.created_at > 60000) finish(intent,'suppressed');
      continue;
    }
    if (delivery.submitted_at > intent.created_at + 60000) { finish(intent,'suppressed'); continue; }
    if (intent.claim_key && intent.attempt_id) {
      const previous = database.prepare('SELECT status FROM status_notice_attempts WHERE notice_key=? AND attempt_id=?')
        .get(intent.claim_key,intent.attempt_id);
      if (previous && ['sent','failed','uncertain'].includes(previous.status)) {
        finish(intent,previous.status); continue;
      }
    }
    let notice = {};
    try { notice = JSON.parse(intent.notice_json || '{}'); } catch { /* Neutral template on malformed metadata. */ }
    if (intent.reason === 'rate_limit') {
      const row = database.prepare('SELECT state_json FROM runtime_health_state WHERE runtime_id=?').get(intent.runtime_id);
      const state = row ? restoreOutageAnchor(JSON.parse(row.state_json),database) : null;
      if (state?.evidence_id === intent.event_id && state.health === 'rate_limited') {
        const enriched = currentOutageNotice(state,current,quota(current),now());
        if (enriched.annotation) notice = enriched.notice;
        // Only the isolated sender waits, never the monitor or Hook collector.
        if (!enriched.annotation && notice?.noticeCode !== 'quota_exhausted_reset' &&
            now() - intent.created_at < Math.min(quotaWaitMs,FIRST_NOTICE_QUOTA_WAIT_MS)) continue;
      }
    }
    const route = { health:intent.health, reason:intent.reason, healthEpisode:intent.health_episode, context:'failure',
      noticeCode:notice?.noticeCode, resetAt:notice?.resetAt };
    let claim;
    try { claim = reserve(intent.channel,intent.endpoint,route); }
    catch { finish(intent,'failed'); continue; }
    if (claim.suppressed) {
      // A concurrent worker or a crashed worker's live lease still owns this
      // intent. Let its outcome, or the durable lease expiry, decide the result.
      if (!['claimed','sending'].includes(claim.reason)) finish(intent,claim.reason === 'uncertain'?'uncertain':'suppressed');
      continue;
    }
    database.prepare("UPDATE runtime_notice_intents SET claim_key=?,attempt_id=?,updated_at=? WHERE event_id=? AND status='pending'")
      .run(claim.key,claim.attemptId,now(),intent.event_id);
    if (!sameScope(intent,identity())) {
      finishStatusNotice(claim,'failed',{now:Math.floor(now()/1000)},database);
      finish(intent,'stale'); continue;
    }
    claim.intentEventId = intent.event_id;
    try { finish(intent,send(claim,messageForStatus(route),route).outcome); }
    catch {
      finishStatusNotice(claim,'uncertain',{now:Math.floor(now()/1000)},database);
      finish(intent,'uncertain');
    }
  }
  cleanupFailureNoticeHistory(database,identity(),now());
  return intents.length;
}

let draining = null;
// Keep the AM event loop responsive while a channel sender waits on I/O.
// A killed worker leaves the durable send claim to resolve as uncertain.
export function drainFirstFailureNotices({ identity, zylosDir = runtimeRoot() } = {}) {
  if (draining) return draining;
  if (!identity?.runtime_generation || !identity.session_id || !identity.process_start) return Promise.resolve();
  if (!getDb().prepare("SELECT 1 FROM runtime_notice_intents WHERE status='pending' LIMIT 1").get()) return Promise.resolve();
  draining = new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[fileURLToPath(import.meta.url),'--drain'], {
      env:{...process.env,ZYLOS_DIR:zylosDir}, stdio:'ignore', timeout:35000, killSignal:'SIGKILL',
    });
    child.once('error',reject);
    child.once('exit',(code,signal) => code === 0 ? resolve() : reject(new Error(`Notice worker stopped (${signal || code})`)));
  }).finally(() => { draining = null; });
  return draining;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--drain') {
  try {
    processFirstFailureNotices({quotaWaitMs:FIRST_NOTICE_QUOTA_WAIT_MS});
    if (getDb().prepare("SELECT 1 FROM runtime_notice_intents WHERE status='pending' LIMIT 1").get()) {
      await new Promise(resolve => setTimeout(resolve,FIRST_NOTICE_QUOTA_WAIT_MS));
      processFirstFailureNotices();
    }
  } finally { close(); }
}
