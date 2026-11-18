/** Scheduler transport. A receive receipt proves storage, not task completion. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIVE_TIMEOUT_MS = 45000;
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
    replyEndpoint = null, priority = 3, requireIdle = false } = options;
  const args = [receivePath, '--core-source', 'scheduler', '--json'];
  if (!replyChannel) args.push('--no-reply');
  const channel = sessionComponent || replyChannel;
  if (channel) args.push('--channel', channel);
  if (replyChannel && replyEndpoint != null) args.push('--endpoint', replyEndpoint);
  if (sessionComponent && sessionGroupName != null) args.push('--session-group', sessionGroupName);
  if (requireIdle) args.push('--block-queue-until-idle');
  args.push('--priority', String(priority), '--content', message);
  return args;
}

export function classifyReceiveResult(result) {
  let receipt;
  try { receipt = JSON.parse(String(result.stdout ?? '').trim()); } catch { /* unknown */ }
  if (result.status === 0 && receipt?.ok === true) {
    return { ...result, category: 'success', receipt };
  }
  const code = receipt?.error?.code;
  if (COMMITTED.has(code)) return { ...result, category: 'C', code, receipt };
  if (REJECTIONS.has(code)) return { ...result, category: 'R', code, receipt };
  if (RETRYABLE.has(code) && Array.isArray(receipt.error.persisted) && receipt.error.persisted.length === 0) {
    return { ...result, category: 'T', code, receipt };
  }
  return { ...result, category: 'U', code: code || 'RECEIVE_RESULT_UNKNOWN', receipt };
}

export function sendViaC4(message, options = {}, { execute = execFileSync, receivePath } = {}) {
  const args = buildReceiveArgs(message, options, receivePath);
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
