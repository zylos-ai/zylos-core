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
      hook.process_start === evidence.hook_process_start && ['stop', 'stop_failure'].includes(hook.event) &&
      typeof hook.event_id === 'string' && hook.event_id.length <= 200 &&
      Number.isSafeInteger(hook.claude_pid) && hook.claude_pid > 0 && typeof hook.process_start === 'string' &&
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
