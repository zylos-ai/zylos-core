import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILLS_DIR, DATA_DIR } from './c4-config.js';
import { reserveStatusNoticeCooldown, clearStatusNoticeCooldownReservation } from './c4-db.js';
import { normalizeStatusEndpoint } from './status-endpoint.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
export { normalizeStatusEndpoint } from './status-endpoint.js';

export const STATUS_NOTICE_TTL_SECONDS = 600;
function validateTarget(channel, endpoint) {
  if (typeof channel !== 'string' || !channel || channel === '--stdin') throw new Error('Invalid notice channel');
  validateChannel(channel, true);
  if (endpoint != null && endpoint !== '') {
    validateEndpoint(endpoint);
    if (endpoint === '--stdin' || endpoint.includes('\0')) throw new Error('Invalid notice endpoint');
  }
}
export function statusNoticeKey(channel, endpoint, health = 'unavailable', reason, sessionGroup, runtime) {
  return 'v2:' + JSON.stringify([channel, normalizeStatusEndpoint(endpoint), sessionGroup, runtime, health || 'unavailable', reason || health || 'unavailable']);
}
export function reserveStatusNotice(channel, endpoint, route = {}, { reserve = reserveStatusNoticeCooldown } = {}) {
  validateTarget(channel, endpoint);
  const health = route.health || 'unavailable';
  const reason = route.reason || health;
  if (!route.sessionGroup || !route.runtime) throw new TypeError('Status notice requires committed sessionGroup and target runtime');
  const claim = reserve({ cooldownKey: statusNoticeKey(channel, endpoint, health, reason, route.sessionGroup, route.runtime), statusType: health, reason,
    channel, endpoint: normalizeStatusEndpoint(endpoint), ttl: STATUS_NOTICE_TTL_SECONDS });
  return { ...claim, channel, endpoint, health, reason, sessionGroup: route.sessionGroup, runtime: route.runtime };
}

export function logStatusNotice(claim, route, outcome, result = {}, { zylosDir = path.dirname(DATA_DIR) } = {}) {
  try {
    const file = path.join(zylosDir, 'activity-monitor', 'status-notices.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), channel: claim.channel,
      endpoint: normalizeStatusEndpoint(claim.endpoint), health: route.health || claim.health || 'unavailable',
      reason: route.reason || claim.reason || 'unavailable', kind: route.noticeKind || route.kind || 'inbound',
      outcome, exitCode: result.status ?? null, signal: result.signal ?? null,
      ...(result.workerExitCode !== undefined || result.workerSignal !== undefined ? {
        workerExitCode: result.workerExitCode ?? null, workerSignal: result.workerSignal ?? null,
      } : {}) }) + '\n');
    if (fs.statSync(file).size > 100 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n'));
    }
  } catch { /* Diagnostics must not change send outcomes. */ }
}

export function sendStatusNotice(claim, message, route = {}, { spawn = spawnSync, diagnostic = true } = {}) {
  validateTarget(claim.channel, claim.endpoint);
  const script = fileURLToPath(new URL('./c4-send.js', import.meta.url));
  const channelScript = path.join(SKILLS_DIR, claim.channel, 'scripts', 'send.js');
  // Only a failure before starting a child proves that no channel send ran.
  const clearOwn = () => { try { clearStatusNoticeCooldownReservation(claim.key, claim.reservedAt); } catch { console.error('status notice: failed to clear own cooldown reservation'); } };
  if (!fs.existsSync(script) || !fs.existsSync(channelScript)) {
    clearOwn();
    if (diagnostic) logStatusNotice(claim, route, 'failed');
    return { outcome: 'failed', code: 'NOTICE_SEND_UNAVAILABLE' };
  }
  let result;
  try {
    result = spawn(process.execPath, [script, claim.channel, ...(claim.endpoint ? [claim.endpoint] : ['--stdin'])], {
      input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL',
    });
  } catch (error) {
    result = { error };
  }
  const outcome = result.status === 0 && !result.error && !result.signal ? 'sent'
    : result.error && ['ENOENT', 'EACCES'].includes(result.error.code) && !result.pid ? 'failed' : 'uncertain';
  if (outcome === 'failed') clearOwn();
  if (diagnostic) logStatusNotice(claim, route, outcome, result);
  return { outcome, code: outcome === 'sent' ? undefined : `NOTICE_SEND_${outcome.toUpperCase()}`,
    exitCode: result.status ?? null, signal: result.signal ?? null };
}
