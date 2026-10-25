/** Scheduler transport. A receive receipt proves storage, not task completion. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIVE_TIMEOUT_MS = 45000;
const ACTIONS = new Set(['queued', 'auth_rejected', 'delivered', 'suppressed']);
const REJECTIONS = new Set(['INVALID_ARGS', 'SESSION_GROUP_INVALID', 'SESSION_GROUP_TOO_LONG']);
const RETRYABLE = new Set(['DB_BUSY', 'INTERNAL_ERROR']);
const COMMITTED = new Set(['UNHEALTHY_NOTIFY_FAILED', 'UNHEALTHY_NOTIFY_UNCERTAIN']);

export function findC4ReceivePath() {
  const root = process.env.ZYLOS_DIR || join(homedir(), 'zylos');
  const installed = join(root, '.claude/skills/comm-bridge/scripts/c4-receive.js');
  if (existsSync(installed)) return installed;
  return join(dirname(fileURLToPath(import.meta.url)), '../../comm-bridge/scripts/c4-receive.js');
}

export function buildReceiveArgs(message, options = {}, receivePath = findC4ReceivePath()) {
  const { sessionComponent = null, sessionGroupName = null, replyChannel = null,
    replyEndpoint = null, priority = 3, blockQueueUntilIdle = false, requireIdle = false } = options;
  if (sessionComponent && replyChannel && sessionComponent !== replyChannel) {
    throw Object.assign(new Error('Saved component and reply channel differ'), { code: 'INVALID_ARGS' });
  }
  const args = [receivePath, '--core-source', 'scheduler', '--json'];
  if (!replyChannel) args.push('--no-reply');
  const channel = sessionComponent || replyChannel;
  if (channel) args.push('--channel', channel);
  if (replyChannel && replyEndpoint != null) args.push('--endpoint', replyEndpoint);
  if (sessionComponent && sessionGroupName != null) args.push('--session-group', sessionGroupName);
  if (blockQueueUntilIdle || requireIdle) args.push('--block-queue-until-idle');
  args.push('--priority', String(priority), '--content', message);
  return args;
}

export function classifyReceiveResult(result) {
  // Never infer a retry from a human-readable error, an exit code alone, or a
  // malformed/partial receipt. The caller resolves these against committed D1.
  let receipt;
  try { receipt = JSON.parse(String(result.stdout ?? '').trim()); } catch { /* unknown */ }
  const uncertain = { ...result, category: 'U', code: 'RECEIVE_RESULT_UNKNOWN', receipt };
  if (result.signal || result.spawnCode || !Number.isInteger(result.status)) return uncertain;
  if (result.status === 0 && receipt?.ok === true && ACTIONS.has(receipt.action)
      && Number.isSafeInteger(receipt.id) && receipt.id > 0
      && typeof receipt.sessionGroup === 'string' && receipt.sessionGroup.length > 0
      && ['claude', 'codex', 'unknown'].includes(receipt.runtime)
      && (receipt.action !== 'auth_rejected' || typeof receipt.reasonLogged === 'boolean')) {
    return { ...result, category: 'success', receipt };
  }
  const error = receipt?.error;
  if (result.status === 0 || receipt?.ok !== false || !error
      || typeof error.code !== 'string' || typeof error.message !== 'string'
      || !(error.persisted === null || (Array.isArray(error.persisted)
        && error.persisted.every(value => typeof value === 'string')))) return uncertain;
  const zero = Array.isArray(error.persisted) && error.persisted.length === 0;
  if (COMMITTED.has(error.code) && Array.isArray(error.persisted) && error.persisted.length > 0) {
    return { ...result, category: 'C', code: error.code, receipt };
  }
  if (zero && REJECTIONS.has(error.code)) return { ...result, category: 'R', code: error.code, receipt };
  if (zero && RETRYABLE.has(error.code)) return { ...result, category: 'T', code: error.code, receipt };
  return { ...uncertain, code: error.code };
}

export function sendViaC4(message, options = {}, { execute = execFileSync, receivePath } = {}) {
  let args;
  try { args = buildReceiveArgs(message, options, receivePath); }
  catch (error) { return { category: 'R', code: error.code || 'INVALID_ARGS', status: null, stdout: '', stderr: '', notStarted: true }; }
  let result;
  try {
    const stdout = execute(process.execPath, args, { encoding: 'utf8', stdio: 'pipe', timeout: RECEIVE_TIMEOUT_MS });
    result = { status: 0, stdout: String(stdout ?? ''), stderr: '', signal: null, spawnCode: null };
  } catch (error) {
    // execFileSync returns/throws only after the direct child has exited,
    // including timeout termination. Preserve the evidence for readback.
    result = { status: error.status ?? null, stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''), signal: error.signal ?? null, spawnCode: error.code ?? null };
  }
  return classifyReceiveResult(result);
}
