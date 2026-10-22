import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialHealthEvidence, reduceHealthEvidence, sanitizeHealthEvent, safeHealthReason } from './health-evidence.js';
import { durableJson, runtimeRoot, syncDirectory } from './runtime-generation.js';
import { currentOutageNotice } from './outage-notice.js';

export const ENGINE_DEFAULTS = Object.freeze({ cooldownUntil:0, rateLimitResetTime:'', unavailableSince:0,
  recoveringStartedAt:0, restartFailureCount:0, lastRecoveryAt:0, lastDownCheckAt:0, lastUserMessageRecoveryAt:0 });
const STATES = new Set(['ok','rate_limited','auth_failed','unavailable','recovering','down']);
const camel = key => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const snakeKeys = ['schema_version','session_id','prompt_id','received_at','claude_pid','process_start','observed_at',
  'rate_limits','five_hour','seven_day','used_percentage','resets_at','evidence_id','screen_fingerprint',
  'last_hook','hook_ok','outage_quota','last_notice_outcome','event_id','updated_at'];
const snake = Object.fromEntries(snakeKeys.map(key => [camel(key),key]));
function mapKeys(value, keyMap) {
  if (Array.isArray(value)) return value.map(item => mapKeys(item,keyMap));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key,item]) => [keyMap(key),mapKeys(item,keyMap)]));
}
const encode = value => mapKeys(value,camel);
const decode = value => mapKeys(value,key => snake[key] || key);

function toFile(state, runtime, updatedAt) {
  const {version,health,reason,scheduling,pending_notice,last_processed,hook_failure,hook_pid,hook_process_start,hook_prompt,...bookkeeping}=state;
  const hook=encode(bookkeeping);
  if(last_processed) { hook.lastProcessedAt=last_processed.received_at; hook.lastProcessedEventId=last_processed.event_id; }
  if(hook_failure)hook.lastFailure=encode(hook_failure);
  if(hook_pid!==undefined)hook.pid=hook_pid;
  if(hook_prompt!==undefined)hook.promptId=hook_prompt;
  const record={v:1,runtime,health,reason:safeHealthReason(health,reason),...Object.fromEntries(Object.entries(ENGINE_DEFAULTS)
    .map(([key,fallback])=>[key,scheduling?.[key]??fallback])),updatedAt,hook};
  if(pending_notice) {
    const p=pending_notice;
    record.pendingNotice={eventId:p.event_id,conversationId:p.conversation_id,channel:p.channel,endpoint:p.endpoint,
      health:p.health,reason:p.reason,notice:encode(p.notice),createdAt:p.created_at};
    hook.pendingAttempt={sessionId:p.session_id,pid:p.claude_pid,error:p.error,
      status:p.status,...(p.updated_at===undefined?{}:{updatedAt:p.updated_at})};
  }
  return record;
}

function fromFile(record,runtime) {
  if(record?.v!==1||record.runtime!==runtime||!STATES.has(record.health)||typeof record.reason!=='string'||
      !Number.isSafeInteger(record.updatedAt)||record.updatedAt<0||!record.hook||typeof record.hook!=='object'||Array.isArray(record.hook)) throw new Error('Invalid health file layout');
  for(const [key,fallback] of Object.entries(ENGINE_DEFAULTS)) {
    if(typeof fallback==='string' ? typeof record[key]!=='string' : !Number.isFinite(record[key])||record[key]<0) throw new Error(`Invalid health field: ${key}`);
  }
  if(!Number.isSafeInteger(record.restartFailureCount))throw new Error('Invalid restart counter');
  for(const key of ['lastProcessedAt','revision','episode']) {
    if(record.hook[key]!==undefined&&(!Number.isSafeInteger(record.hook[key])||record.hook[key]<0))throw new Error(`Invalid hook field: ${key}`);
  }
  const {lastProcessedAt,lastProcessedEventId,lastFailure,pid,processStart,promptId,pendingAttempt,...bookkeeping}=record.hook;
  const state={...initialHealthEvidence(),...decode(bookkeeping),health:record.health,reason:safeHealthReason(record.health,record.reason),
    scheduling:Object.fromEntries(Object.keys(ENGINE_DEFAULTS).map(key=>[key,record[key]]))};
  if(lastProcessedAt!==undefined)state.last_processed={received_at:lastProcessedAt,event_id:lastProcessedEventId};
  if(lastFailure)state.hook_failure=decode(lastFailure);
  if(pid!==undefined)state.hook_pid=pid;
  if(promptId!==undefined)state.hook_prompt=promptId;
  if(record.pendingNotice) {
    const p=record.pendingNotice;
    state.pending_notice={event_id:p.eventId,conversation_id:p.conversationId,channel:p.channel,endpoint:p.endpoint,
      health:p.health,reason:p.reason,notice:decode(p.notice),created_at:p.createdAt,runtime,
      session_id:pendingAttempt?.sessionId,claude_pid:pendingAttempt?.pid,
      error:pendingAttempt?.error,status:pendingAttempt?.status||'pending',
      ...(pendingAttempt?.updatedAt===undefined?{}:{updated_at:pendingAttempt.updatedAt})};
  }
  return state;
}

// AM is the only writer. Health, replay marker and pending reply commit together.
export class HealthStore {
  constructor({ runtime = 'claude', zylosDir = runtimeRoot(), now = Date.now, freezeNotice = () => null, log = () => {} } = {}) {
    this.runtime = runtime; this.now = now; this.freezeNotice = freezeNotice; this.log=log; this.loaded=false;
    this.file = path.join(zylosDir, 'activity-monitor', 'runtime-health', `${runtime}.json`);
    this.initial = {...initialHealthEvidence(),scheduling:{...ENGINE_DEFAULTS}};
  }
  read() {
    try {
      const state = fromFile(JSON.parse(fs.readFileSync(this.file, 'utf8')),this.runtime);
      if(!this.loaded&&state.pending_notice?.status==='sending') {
        state.last_notice_outcome={event_id:state.pending_notice.event_id,status:'uncertain',observed_at:this.now()};
        delete state.pending_notice;
        this.loaded=true;
        this.write(state);
      }
      this.loaded=true;
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if(!(error instanceof SyntaxError)&&!(error.message.startsWith('Invalid ')))throw error;
        let stamp=this.now();
        while(fs.existsSync(`${this.file}.corrupt-${stamp}`))stamp++;
        const quarantine=`${this.file}.corrupt-${stamp}`;
        fs.renameSync(this.file,quarantine);
        syncDirectory(path.dirname(this.file));
        this.log(`Warning: invalid ${this.runtime} health file quarantined; starting from ok`);
      }
      this.loaded=true;
      return structuredClone(this.initial);
    }
  }
  write(state) { durableJson(this.file, toFile(state,this.runtime,this.now())); this.loaded=true; }
  currentNotice({ identity, quota } = {}) {
    const state = this.read();
    const result = currentOutageNotice(state, identity, quota, this.now());
    if (result.annotation && JSON.stringify(result.annotation) !== JSON.stringify(state.outage_quota)) this.write({ ...state, outage_quota: result.annotation });
    return result.notice;
  }
  saveScheduling(scheduling, expectedRevision) {
    const state = this.read();
    if (state.revision !== expectedRevision) return false;
    this.write({ ...state, scheduling });
    return true;
  }
  updatePending(eventId, patch) {
    const state = this.read();
    if (state.pending_notice?.event_id !== eventId) return false;
    if(patch.status&&!['pending','sending'].includes(patch.status)) {
      state.last_notice_outcome={event_id:eventId,status:patch.status,observed_at:patch.updated_at??this.now()};
      delete state.pending_notice;
      this.write(state);
    } else this.write({ ...state, pending_notice: { ...state.pending_notice, ...patch } });
    return true;
  }
  consume(raw, { identity, quota, fallbackId } = {}) {
    const event = sanitizeHealthEvent(raw, fallbackId);
    const prior = this.read();
    if (!['stop', 'stop_failure'].includes(event.event)) return { state: prior, status: 'ignored', reason: 'nonterminal_event' };
    if (event.received_at <= (prior.last_processed?.received_at ?? 0)) return { state: prior, status: 'ignored', reason: 'replay' };
    const result = reduceHealthEvidence(prior, event, { identity, quota, now: this.now() });
    if (result.status !== 'processed') return result;
    const healthChanged = result.state !== prior;
    result.state = { ...result.state, revision: prior.revision + (healthChanged ? 1 : 0),
      last_processed: { received_at: event.received_at, event_id: event.event_id },
      last_hook: { event_id: event.event_id, event: event.event, error: event.error, observed_at: event.received_at,
        session_id:event.session_id, claude_pid:event.claude_pid } };
    const pending = this.freezeNotice({ runtime: this.runtime, state: result.state, identity, event, result });
    if (pending) result.state.pending_notice = pending;
    this.write(result.state);
    return result;
  }
  transition(health, reason, { identity, kind = 'screen', expectedRevision, screenFingerprint = null } = {}) {
    const prior = this.read();
    if (expectedRevision !== undefined && expectedRevision !== prior.revision) return { accepted: false, state: prior };
    const currentHook = prior.source === 'hook' && prior.session_id === identity?.session_id && prior.hook_pid === identity?.claude_pid;
    if (kind === 'screen' && currentHook && (!prior.hook_ok || health === 'rate_limited')) return { accepted: false, state: prior };
    const next = { ...prior, health, reason: safeHealthReason(health, reason), session_id: identity?.session_id ?? prior.session_id,
      hook_pid:identity?.claude_pid ?? prior.hook_pid,
      source: kind, evidence_id: randomUUID(), revision: prior.revision + 1 };
    delete next.notice;
    if (health !== prior.health) delete next.scheduling;
    if (health !== 'ok' && prior.health === 'ok') next.episode++;
    if (kind === 'recovery') next.recovered = { session_id: next.session_id, revision: next.revision, evidence_id: prior.evidence_id, screen_fingerprint: screenFingerprint, observed_at:this.now() };
    this.write(next);
    return { accepted: true, state: next };
  }
}
