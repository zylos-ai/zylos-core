import fs from 'node:fs';
import path from 'node:path';
import { HOOK_ERRORS } from './health-evidence.js';

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function readInitialStatus({ statusFile }) {
  try {
    if (!fs.existsSync(statusFile)) return { health: 'ok' };
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (status && typeof status.health === 'string') {
      return status;
    }
  } catch {
    // Fall through to fail-open health.
  }
  return { health: 'ok' };
}

export function publicHealth(health) {
  if (health === 'ok' || health === 'rate_limited' || health === 'auth_failed') {
    return health;
  }
  return 'unavailable';
}

export function buildStatusPayload({ statusObj, healthEngine }) {
  const health = publicHealth(healthEngine.health);
  const extra = {};
  const evidence=healthEngine.evidence?.store.read();
  if (evidence) {
    extra.health_episode = `${healthEngine.evidence.store.runtime}:${evidence.episode}`;
    extra.health_revision = evidence.revision;
    const notice = healthEngine.evidence.notice?.() ?? evidence.notice;
    if (notice && evidence.health === health) {
      extra.health_notice = { noticeCode:notice.noticeCode, resetAt:notice.resetAt };
    }
    const hook = evidence.last_hook;
    if (hook && hook.session_id === evidence.session_id && hook.claude_pid === evidence.hook_pid &&
      typeof hook.session_id === 'string' && hook.session_id.length > 0 && ['stop', 'stop_failure'].includes(hook.event) &&
      typeof hook.event_id === 'string' && hook.event_id.length <= 200 &&
      Number.isSafeInteger(hook.claude_pid) && hook.claude_pid > 0 &&
      Number.isSafeInteger(hook.observed_at)) {
      extra.last_hook = {
        event_id: hook.event_id,
        event: hook.event,
        error: hook.event === 'stop_failure' ? (HOOK_ERRORS.has(hook.error) ? hook.error : 'unknown') : null,
        observed_at: hook.observed_at,
      };
    }
  }
  if (health === 'rate_limited') {
    extra.rate_limit_reset = healthEngine.rateLimitResetTime || null;
    extra.cooldown_until = healthEngine.cooldownUntil || null;
  }
  if (healthEngine.healthReason) {
    extra.unavailable_reason = evidence?.reason ?? healthEngine.healthReason;
  }
  if (health === 'unavailable' && healthEngine.unavailableSince) {
    extra.unavailable_since = healthEngine.unavailableSince;
  }
  return { ...statusObj, ...extra, health };
}

export function writeStatus({ statusFile, statusObj, healthEngine }) {
  try {
    ensureParentDir(statusFile);
    atomicWriteJson(statusFile, buildStatusPayload({ statusObj, healthEngine }));
    return true;
  } catch {
    return false;
  }
}

/** Publish state and identity together; F10 remains the health authority. */
export function publishSessionStatus({ statusFile, scene, activity, health, proc = null, now = Date.now() }) {
  if (!scene.ready || !scene.runId || !scene.sessionId || activity.sessionId !== scene.sessionId) {
    throw Object.assign(new Error('Cannot publish state without current run/session identity'), { code: 'IDENTITY_UNAVAILABLE' });
  }
  const payload = {
    runId: scene.runId, sessionId: scene.sessionId, runtime: scene.runtime,
    state: activity.state, health: publicHealth(health.health),
    idle_seconds: Math.max(0, Math.floor((now - activity.lastActivityAt) / 1000)),
    last_activity: activity.lastActivityAt, active_tools: activity.tools.length,
    last_api_activity: activity.lastActivityAt, active_tool_details: activity.tools,
    proc, updated_at: now,
  };
  if (health.health !== 'ok' && health.reason) payload.unavailable_reason = health.reason;
  const budget = health.scheduling ?? health;
  if (health.health === 'rate_limited') {
    payload.cooldown_until = budget.cooldownUntil;
    payload.rate_limit_reset = budget.rateLimitResetTime;
  }
  ensureParentDir(statusFile);
  atomicWriteJson(statusFile, payload);
  return payload;
}
