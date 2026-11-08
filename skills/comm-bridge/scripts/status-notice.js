import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILLS_DIR, DATA_DIR } from './c4-config.js';
import { reserveStatusNoticeCooldown, clearStatusNoticeCooldownReservation } from './c4-db.js';
import { normalizeStatusEndpoint } from './status-endpoint.js';
import { validateChannel, validateEndpoint } from './c4-validate.js';
import { parseSessionGroup } from './c4-session-group.js';
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
      ...(result.stdout ? { stdout: result.stdout } : {}),
      ...(result.stderr ? { stderr: result.stderr } : {}),
      ...(result.workerExitCode !== undefined || result.workerSignal !== undefined ? {
        workerExitCode: result.workerExitCode ?? null, workerSignal: result.workerSignal ?? null,
      } : {}) }) + '\n');
    if (fs.statSync(file).size > 100 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n'));
    }
  } catch { /* Diagnostics must not change send outcomes. */ }
}

export async function sendStatusNotice(claim, message, route = {}, { spawn = spawnChild, diagnostic = true, timeoutMs = 30000 } = {}) {
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
  const result = await new Promise(resolve => {
    let child, error, timer, exited = false, stdout = '', stderr = '';
    const closeReaders = () => { child.stdout.destroy(); child.stderr.destroy(); };
    const finish = (status = null, signal = null) => {
      clearTimeout(timer);
      resolve({ status, signal, error, pid: child?.pid, stdout, stderr });
    };
    try {
      const groupName = parseSessionGroup(claim.sessionGroup ?? route.sessionGroup)?.groupName;
      child = spawn(process.execPath, [script, claim.channel, ...(claim.endpoint ? [claim.endpoint] : ['--stdin']),
        ...(groupName ? ['--session-group', groupName] : [])], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Keep draining both pipes after the diagnostic prefix is full.
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(0, 8192); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 8192); });
      child.once('error', failure => { error = failure; });
      child.once('exit', (status, signal) => {
        exited = true;
        // Descendants can retain pipe writers after the direct sender exits.
        if (error || status !== 0 || signal) closeReaders();
      });
      child.once('close', (status, signal) => finish(status, signal));
      child.stdin.on('error', failure => { error ??= failure; });
      // Keep the deadline until pipe completion, even after a zero direct exit.
      timer = setTimeout(() => {
        error ??= Object.assign(new Error('Status notice send timed out'), { code: 'ETIMEDOUT' });
        if (exited) closeReaders();
        else child.kill('SIGKILL');
      }, timeoutMs);
      child.stdin.end(message);
    } catch (failure) {
      error = failure;
      // Once started, settle only on close so no sender outlives its caller.
      if (child?.pid) child.kill('SIGKILL');
      else finish();
    }
  });
  const outcome = result.status === 0 && !result.error && !result.signal ? 'sent'
    : result.error && ['ENOENT', 'EACCES'].includes(result.error.code) && !result.pid ? 'failed' : 'uncertain';
  if (outcome === 'failed') clearOwn();
  if (diagnostic) logStatusNotice(claim, route, outcome, result);
  return { outcome, code: outcome === 'sent' ? undefined : `NOTICE_SEND_${outcome.toUpperCase()}`,
    exitCode: result.status ?? null, signal: result.signal ?? null };
}
