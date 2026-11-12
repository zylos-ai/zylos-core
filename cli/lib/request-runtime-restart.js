import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readSessionMode, ZYLOS_DIR } from './config.js';
import { submit, lookupRestartRequest } from './am-sock-client.js';

// The single session gets the same short window as each multi-session upgrade check.
export const SINGLE_UPGRADE_CHECK_ACK_DEADLINE_SECONDS = 60;

const installedSkill = relative => path.join(ZYLOS_DIR, '.claude/skills', relative);

function runC4Control(args) {
  return new Promise((resolve, reject) => execFile(process.execPath, [installedSkill('comm-bridge/scripts/c4-control.js'), 'enqueue', ...args, '--json'],
    {encoding:'utf8',timeout:10000}, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout).data)));
}

async function loadSingleUpgradeCheckPrompt() {
  const { SINGLE_UPGRADE_RESTART_CHECK_PROMPT: prompt } = await import(pathToFileURL(installedSkill('activity-monitor/scripts/reclaim-prompts.js')).href);
  if (typeof prompt !== 'string' || !prompt) throw Object.assign(new Error('The single-session upgrade check prompt is not installed'), {code:'CHECK_PROMPT_UNAVAILABLE'});
  return prompt;
}

/** Queue the waiting-work check, then /exit, for the single session; nothing here waits for the session.
 * Both are priority 1 and wait for an idle session, so the dispatcher delivers the check (the older id) first and
 * /exit only after the check's turn. A check not acknowledged within the deadline expires and /exit follows;
 * new activity never removes the queued /exit.
 */
export async function enqueueSingleUpgradeExit({ run = runC4Control, loadPrompt = loadSingleUpgradeCheckPrompt } = {}) {
  const prompt = await loadPrompt();
  const check = await run(['--content', prompt, '--priority', '1', '--block-queue-until-idle',
    '--ack-deadline', String(SINGLE_UPGRADE_CHECK_ACK_DEADLINE_SECONDS)]);
  const exit = await run(['--content', '/exit', '--priority', '1', '--block-queue-until-idle', '--no-ack-suffix']);
  return {checkControlId:check.id, exitControlId:exit.id};
}

/** Select once; never fall back or resubmit after a connected attempt.
 * Only the self-upgrade call after services restart may retry failed connects.
 */
export async function requestRuntimeRestart({ now = Date.now, deadlineAt, afterServiceRestart = false, readMode = readSessionMode,
  readTransition = async () => (await import('../../skills/comm-bridge/scripts/c4-db.js')).getModeTransition(), send = submit, lookup = lookupRestartRequest,
  enqueueExit = enqueueSingleUpgradeExit, requestId = `restart-${Date.now()}-${randomBytes(6).toString('hex')}` } = {}) {
  let deadline = afterServiceRestart ? Infinity : deadlineAt ?? now() + 10000;
  const fail = (code, message, persisted = []) => ({ok:false,error:{code,message: afterServiceRestart && persisted !== null
    ? `${message}. All currently running managed sessions, including Origin, need manual restart.` : message,persisted},requestId});
  if (now() >= deadline) return fail('deadline_exceeded','Restart budget was exhausted before submission');
  const mode = await readMode();
  if (now() >= deadline) return fail('deadline_exceeded','Restart budget was exhausted before submission');
  const transition = await readTransition();
  if (now() >= deadline) return fail('deadline_exceeded','Restart budget was exhausted before submission');
  if (mode.mode === 'single' && !transition) {
    const controls = await enqueueExit();
    return {ok:true,data:{result:'exit_enqueued',mode:'single',...controls}};
  }
  if (afterServiceRestart) deadline = now() + 30000;
  const result = await send({version:1,type:'restart_all',requestId,reason:'upgrade'},{deadlineAt:deadline, ...(afterServiceRestart ? {connectRetryEveryMs:1000} : {})});
  if (result.kind === 'accepted') return {ok:true,data:{result:result.reply.result,requestId,runCount:result.reply.runCount}};
  if (result.kind === 'rejected' || !result.sent) return fail(result.reply?.code ?? result.kind,'Restart was not accepted');
  let observed;
  try { observed = await lookup(requestId,{deadlineAt:deadline,now}); } catch { observed = 'unknown'; }
  if (observed === 'accepted' || observed === 'done') return {ok:true,data:{result:observed,requestId,recoveredByLookup:true}};
  return fail('restart_result_unknown','Restart result is unknown; do not resubmit automatically',null);
}
