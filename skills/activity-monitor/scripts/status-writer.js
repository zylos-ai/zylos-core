import fs from 'node:fs';
import path from 'node:path';

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function publicHealth(health) {
  if (health === 'ok' || health === 'rate_limited' || health === 'auth_failed') {
    return health;
  }
  return 'unavailable';
}

/** Project the health authority into the stable public status fields. */
export function publicHealthFields(health) {
  const state = publicHealth(health.health);
  const fields = { health: state };
  if (health.health !== 'ok' && health.reason) fields.unavailable_reason = health.reason;
  const budget = health.scheduling ?? health;
  if (health.health === 'rate_limited') {
    fields.cooldown_until = budget.cooldownUntil;
    fields.rate_limit_reset = budget.rateLimitResetTime;
  }
  if (state === 'unavailable' && Number.isSafeInteger(budget.unavailableSince) && budget.unavailableSince > 0) {
    fields.unavailable_since = budget.unavailableSince;
  }
  return fields;
}

/** Publish state and identity together; F10 remains the health authority. */
export function publishSessionStatus({ statusFile, scene, activity, health, proc = null, now = Date.now() }) {
  if (!scene.ready || !scene.runId || !scene.sessionId || activity.sessionId !== scene.sessionId) {
    throw Object.assign(new Error('Cannot publish state without current run/session identity'), { code: 'IDENTITY_UNAVAILABLE' });
  }
  const payload = {
    runId: scene.runId, sessionId: scene.sessionId, runtime: scene.runtime,
    state: activity.state, ...publicHealthFields(health),
    idle_seconds: Math.max(0, Math.floor((now - activity.lastActivityAt) / 1000)),
    last_activity: activity.lastActivityAt, active_tools: activity.tools.length,
    last_api_activity: activity.lastActivityAt, active_tool_details: activity.tools,
    proc, updated_at: now,
  };
  ensureParentDir(statusFile);
  atomicWriteJson(statusFile, payload);
  return payload;
}
