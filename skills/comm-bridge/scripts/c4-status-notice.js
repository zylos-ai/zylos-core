import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as defaultDb from './c4-db.js';
import { normalizeStatusEndpoint } from './status-endpoint.js';
import { parseSessionGroup } from './c4-session-group.js';
import { messageForStatus } from './status-notice-templates.js';
import { logStatusNotice } from './status-notice.js';

export { normalizeStatusEndpoint } from './status-endpoint.js';
export const STATUS_NOTICE_TTL_SECONDS = 600;
const sendScript = fileURLToPath(new URL('./c4-send.js', import.meta.url));

export function statusNoticeKey(record, route = {}) {
  const health = route.health || 'unavailable';
  return 'v2:' + JSON.stringify([record.channel, normalizeStatusEndpoint(record.endpoint_id),
    record.session_group ?? null, route.runtime || 'unknown', health, route.reason || health]);
}

/** Shared post-commit receipt sender. It never changes the conversation row. */
export function createStatusNoticeSender({ db = defaultDb, spawn = spawnChild,
  now = () => Math.floor(Date.now() / 1000), render = messageForStatus,
  diagnostic = logStatusNotice, log = message => console.error(message), timeoutMs = 30000,
  script = sendScript } = {}) {
  const warn = (stage, record, error) => { try { log(`Status notice ${stage} conversation=${record.id}: ${error?.message ?? error}`); } catch {} };
  return async function sendStatusNotice(record, route = {}) {
    if (!record.endpoint_id || route.decision === 'pending') return { outcome: 'skipped' };
    const normalized = { ...route, health: route.health || 'unavailable' };
    normalized.reason ||= normalized.health;
    normalized.runtime ||= 'unknown';
    let message;
    // Render/validate before reservation: no child can have started here.
    try {
      if (typeof record.channel !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(record.channel) ||
          typeof record.endpoint_id !== 'string' || record.endpoint_id.includes('\0') ||
          record.endpoint_id === '--stdin') throw Error('Invalid notice target');
      message = render(normalized);
    } catch (error) { warn('prepare', record, error); return { outcome: 'failed', code: 'UNHEALTHY_NOTIFY_FAILED' }; }
    let claim;
    try {
      claim = db.reserveStatusNoticeCooldown({ cooldownKey: statusNoticeKey(record, normalized), channel: record.channel,
        endpoint: normalizeStatusEndpoint(record.endpoint_id), statusType: normalized.health, reason: normalized.reason,
        ttl: STATUS_NOTICE_TTL_SECONDS, now: now() });
    } catch (error) { warn('reserve', record, error); return { outcome: 'failed', code: 'UNHEALTHY_NOTIFY_FAILED' }; }
    if (claim.suppressed) return { outcome: 'suppressed', key: claim.key };
    const argv = [script, record.channel, record.endpoint_id];
    const group = parseSessionGroup(record.session_group);
    if (record.channel !== 'internal' && group?.groupName) argv.push('--session-group', group.groupName);
    const result = await new Promise(resolve => {
      let child, done = false, started = false, timer;
      const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
      const stop = () => { try { child.kill('SIGKILL'); } catch {} };
      try {
        child = spawn(process.execPath, argv, { stdio: ['pipe', 'ignore', 'ignore'] });
        started = Boolean(child.pid);
        child.once('spawn', () => { started = true; });
        child.once('error', error => {
          // With no pid/spawn event, the operating system never started a child.
          if (!started && !child.pid) finish({ outcome: 'failed', error });
          // A started child must settle before the caller proceeds; close below
          // classifies its observable result.
        });
        child.once('close', (exitCode, signal) => finish({ outcome: exitCode === 0 ? 'sent' : 'uncertain', exitCode, signal }));
        child.stdin.on('error', () => {}); // close determines the send outcome.
        timer = setTimeout(stop, timeoutMs);
        child.stdin.end(message);
      } catch (error) {
        // If stdin fails after spawn, still wait for close. Returning early
        // would leave an untracked sender running after the lane has settled.
        if (started || child?.pid) stop();
        else finish({ outcome: 'failed', error });
      }
    });
    if (result.outcome === 'failed') {
      try { db.clearStatusNoticeCooldownReservation(claim.key, claim.reservedAt); }
      catch (error) { warn('clear', record, error); }
    }
    try { diagnostic({ ...claim, channel: record.channel, endpoint: record.endpoint_id }, normalized,
      result.outcome, { status: result.exitCode, signal: result.signal }); } catch {}
    return { outcome: result.outcome, key: claim.key, exitCode: result.exitCode ?? null, signal: result.signal ?? null,
      ...(result.outcome === 'sent' ? {} : { code: `UNHEALTHY_NOTIFY_${result.outcome.toUpperCase()}` }) };
  };
}
