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

const GROUP_FIELDS = ['last_processed', 'pending_notice', 'last_notice_outcome'];
function encodeGroup(state) {
  const group = {};
  if (state.last_processed) {
    group.lastProcessedAt = state.last_processed.received_at;
    group.lastProcessedEventId = state.last_processed.event_id;
  }
  if (state.last_notice_outcome) group.lastNoticeOutcome = encode(state.last_notice_outcome);
  if (state.pending_notice) {
    const p = state.pending_notice;
    group.pendingNotice = {eventId:p.event_id,conversationId:p.conversation_id,channel:p.channel,endpoint:p.endpoint,
      health:p.health,reason:p.reason,notice:encode(p.notice),createdAt:p.created_at};
    group.pendingAttempt = {sessionId:p.session_id,pid:p.claude_pid,error:p.error,status:p.status,
      ...(p.updated_at===undefined?{}:{updatedAt:p.updated_at})};
  }
  return group;
}
function decodeGroup(group, runtime, sessionGroup) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error('Invalid health group');
  if (group.lastProcessedAt !== undefined && (!Number.isSafeInteger(group.lastProcessedAt) || group.lastProcessedAt < 0)) throw new Error('Invalid group marker');
  const state = {};
  if (group.lastProcessedAt !== undefined) state.last_processed = {received_at:group.lastProcessedAt,event_id:group.lastProcessedEventId};
  if (group.lastNoticeOutcome) state.last_notice_outcome = decode(group.lastNoticeOutcome);
  if (group.pendingNotice) {
    const p = group.pendingNotice, attempt = group.pendingAttempt;
    state.pending_notice = {session_group:sessionGroup,event_id:p.eventId,conversation_id:p.conversationId,channel:p.channel,endpoint:p.endpoint,
      health:p.health,reason:p.reason,notice:decode(p.notice),created_at:p.createdAt,runtime,
      session_id:attempt?.sessionId,claude_pid:attempt?.pid,error:attempt?.error,status:attempt?.status || 'pending',
      ...(attempt?.updatedAt===undefined?{}:{updated_at:attempt.updatedAt})};
  }
  return state;
}
function toFile(state, runtime, updatedAt, sessionGroup) {
  const {version,health,reason,scheduling,rateLimitActive,groups={},pending_notice,last_processed,last_notice_outcome,
    hook_failure,hook_pid,hook_process_start,hook_prompt,...bookkeeping}=state;
  const hook=encode(bookkeeping);
  hook.groups = Object.fromEntries(Object.entries(groups).map(([key,value]) => [key,encodeGroup(value)]));
  const selected = encodeGroup({pending_notice,last_processed,last_notice_outcome});
  if (Object.keys(selected).length || Object.hasOwn(groups,sessionGroup)) hook.groups[sessionGroup] = selected;
  if(hook_failure)hook.lastFailure=encode(hook_failure);
  if(hook_pid!==undefined)hook.pid=hook_pid;
  if(hook_prompt!==undefined)hook.promptId=hook_prompt;
  return {v:1,runtime,health,reason:safeHealthReason(health,reason),rateLimitActive:health==='rate_limited' || (health!=='ok' && Boolean(rateLimitActive)),
    ...Object.fromEntries(Object.entries(ENGINE_DEFAULTS).map(([key,fallback])=>[key,scheduling?.[key]??fallback])),updatedAt,hook};
}
function fromFile(record,runtime,sessionGroup) {
  if(record?.v!==1||record.runtime!==runtime||!STATES.has(record.health)||typeof record.reason!=='string'||
      !Number.isSafeInteger(record.updatedAt)||record.updatedAt<0||!record.hook||typeof record.hook!=='object'||Array.isArray(record.hook)) throw new Error('Invalid health file layout');
  for(const [key,fallback] of Object.entries(ENGINE_DEFAULTS)) {
    if(typeof fallback==='string' ? typeof record[key]!=='string' : !Number.isSafeInteger(record[key])||record[key]<0) throw new Error(`Invalid health field: ${key}`);
  }
  if(record.rateLimitActive!==undefined && typeof record.rateLimitActive!=='boolean') throw new Error('Invalid rate limit fact');
  for(const key of ['lastProcessedAt','revision','episode']) {
    if(record.hook[key]!==undefined&&(!Number.isSafeInteger(record.hook[key])||record.hook[key]<0))throw new Error(`Invalid hook field: ${key}`);
  }
  const {groups,lastProcessedAt,lastProcessedEventId,lastNoticeOutcome,lastFailure,pid,processStart,promptId,pendingAttempt,...bookkeeping}=record.hook;
  if (groups !== undefined && (!groups || typeof groups !== 'object' || Array.isArray(groups))) throw new Error('Invalid health groups');
  const rawGroups = groups ?? {origin:{lastProcessedAt,lastProcessedEventId,lastNoticeOutcome,pendingAttempt,pendingNotice:record.pendingNotice}};
  const decodedGroups = Object.fromEntries(Object.entries(rawGroups).map(([key,value])=>[key,decodeGroup(value,runtime,key)]));
  const state={...initialHealthEvidence(),...decode(bookkeeping),health:record.health,reason:safeHealthReason(record.health,record.reason),
    rateLimitActive:record.health==='rate_limited'||(record.health!=='ok'&&Boolean(record.rateLimitActive)),groups:decodedGroups,
    ...decodedGroups[sessionGroup],scheduling:Object.fromEntries(Object.keys(ENGINE_DEFAULTS).map(key=>[key,record[key]]))};
  if(lastFailure)state.hook_failure=decode(lastFailure);
  if(pid!==undefined)state.hook_pid=pid;
  if(promptId!==undefined)state.hook_prompt=promptId;
  return state;
}

// AM is the only writer. Health, replay marker and pending reply commit together.
export class HealthStore {
  constructor({ runtime = 'claude', zylosDir = runtimeRoot(), now = Date.now, freezeNotice = () => null, log = () => {} } = {}) {
    this.runtime = runtime; this.now = now; this.freezeNotice = freezeNotice; this.log=log; this.loaded=false;
    this.file = path.join(zylosDir, 'activity-monitor', 'runtime-health', `${runtime}.json`);
    this.initial = {...initialHealthEvidence(),rateLimitActive:false,groups:{},scheduling:{...ENGINE_DEFAULTS}};
  }
  read(sessionGroup = 'origin') {
    try {
      const record = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const state = fromFile(record,this.runtime,sessionGroup);
      let changed = !Object.hasOwn(record.hook,'groups');
      if (!this.loaded) for (const group of Object.values(state.groups)) {
        if (group.pending_notice?.status !== 'sending') continue;
        group.last_notice_outcome={event_id:group.pending_notice.event_id,status:'uncertain',observed_at:this.now()};
        delete group.pending_notice;
        changed = true;
      }
      for (const key of GROUP_FIELDS) delete state[key];
      Object.assign(state,state.groups[sessionGroup]);
      if (changed) this.write(state,sessionGroup);
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
  write(state, sessionGroup = 'origin') { durableJson(this.file, toFile(state,this.runtime,this.now(),sessionGroup)); this.loaded=true; }
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
  updatePending(eventId, patch, sessionGroup = 'origin') {
    const state = this.read(sessionGroup);
    if (state.pending_notice?.event_id !== eventId) return false;
    if(patch.status&&!['pending','sending'].includes(patch.status)) {
      state.last_notice_outcome={event_id:eventId,status:patch.status,observed_at:patch.updated_at??this.now()};
      delete state.pending_notice;
      this.write(state,sessionGroup);
    } else this.write({ ...state, pending_notice: { ...state.pending_notice, ...patch } },sessionGroup);
    return true;
  }
  consume(raw, { identity, quota, fallbackId, sessionGroup = 'origin' } = {}) {
    const event = sanitizeHealthEvent(raw, fallbackId);
    const prior = this.read(sessionGroup);
    if (!['stop', 'stop_failure'].includes(event.event)) return { state: prior, status: 'ignored', reason: 'nonterminal_event' };
    if (event.received_at <= (prior.last_processed?.received_at ?? 0)) return { state: prior, status: 'ignored', reason: 'replay' };
    const result = reduceHealthEvidence(prior, event, { identity, quota, now: this.now() });
    if (result.status !== 'processed') return result;
    const healthChanged = result.state !== prior;
    result.state = { ...result.state, revision: prior.revision + (healthChanged ? 1 : 0),
      last_processed: { received_at: event.received_at, event_id: event.event_id },
      last_hook: { event_id: event.event_id, event: event.event, error: event.error, observed_at: event.received_at,
        session_id:event.session_id, claude_pid:event.claude_pid } };
    const pending = this.freezeNotice({ runtime: this.runtime, state: result.state, identity, event, result, sessionGroup });
    if (pending) result.state.pending_notice = pending;
    result.state.rateLimitActive = result.state.health === 'rate_limited' || (result.state.health !== 'ok' && prior.rateLimitActive);
    this.write(result.state,sessionGroup);
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
    next.rateLimitActive = health === 'rate_limited' || (health !== 'ok' && prior.rateLimitActive);
    if (health !== 'ok' && prior.health === 'ok') next.episode++;
    if (kind === 'recovery') next.recovered = { session_id: next.session_id, revision: next.revision, evidence_id: prior.evidence_id, screen_fingerprint: screenFingerprint, observed_at:this.now() };
    this.write(next);
    return { accepted: true, state: next };
  }
}
