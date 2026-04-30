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
  if (health === 'rate_limited') {
    extra.rate_limit_reset = healthEngine.rateLimitResetTime || null;
    extra.cooldown_until = healthEngine.cooldownUntil || null;
  }
  if (healthEngine.healthReason) {
    extra.unavailable_reason = healthEngine.healthReason;
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
