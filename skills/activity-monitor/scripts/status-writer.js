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
