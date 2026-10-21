import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILLS_DIR } from './c4-config.js';
import { claimStatusNotice, startStatusNotice, finishStatusNotice } from './c4-db.js';
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
export function statusNoticeKey(channel, endpoint) {
  return JSON.stringify([channel, normalizeStatusEndpoint(endpoint)]);
}
export function reserveStatusNotice(channel, endpoint, route = {}) {
  validateTarget(channel, endpoint);
  const episode = typeof route.healthEpisode === 'string' && route.healthEpisode.length <= 256 ? route.healthEpisode : 'legacy:unverified';
  return claimStatusNotice({ key: statusNoticeKey(channel, endpoint), attemptId: randomUUID(),
    episode, channel, endpoint, normalizedEndpoint: normalizeStatusEndpoint(endpoint) });
}

export function sendStatusNotice(claim, message, route = {}, { spawn = spawnSync, now = () => Math.floor(Date.now() / 1000) } = {}) {
  validateTarget(claim.channel, claim.endpoint);
  const script = fileURLToPath(new URL('./c4-send.js', import.meta.url));
  const channelScript = path.join(SKILLS_DIR, claim.channel, 'scripts', 'send.js');
  // Only a failure before starting a child proves that no channel send ran.
  if (!fs.existsSync(script) || !fs.existsSync(channelScript)) {
    finishStatusNotice(claim, 'failed', { now: now() });
    return { outcome: 'failed', code: 'NOTICE_SEND_UNAVAILABLE' };
  }
  if (!startStatusNotice(claim, now())) return { outcome: 'uncertain', code: 'NOTICE_CLAIM_LOST' };
  let result;
  try {
    result = spawn(process.execPath, [script, claim.channel, ...(claim.endpoint ? [claim.endpoint] : ['--stdin'])], {
      input: message, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, killSignal: 'SIGKILL',
    });
  } catch {
    finishStatusNotice(claim, 'uncertain', { now: now() });
    return { outcome: 'uncertain', code: 'NOTICE_SEND_UNCERTAIN' };
  }
  const outcome = result.status === 0 && !result.error && !result.signal ? 'sent'
    : result.error && ['ENOENT', 'EACCES'].includes(result.error.code) && !result.pid ? 'failed' : 'uncertain';
  finishStatusNotice(claim, outcome, { now: now(), ttl: STATUS_NOTICE_TTL_SECONDS,
    health: route.health || 'unavailable', reason: route.reason || 'unavailable' });
  return { outcome, code: outcome === 'sent' ? undefined : `NOTICE_SEND_${outcome.toUpperCase()}` };
}
