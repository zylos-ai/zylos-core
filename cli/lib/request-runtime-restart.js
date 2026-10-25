import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readSessionMode, ZYLOS_DIR } from './config.js';
import { getModeTransition } from '../../skills/comm-bridge/scripts/c4-db.js';
import { submit, lookupRestartRequest } from './am-sock-client.js';

function enqueueSingleExit() {
  const script = path.join(ZYLOS_DIR, '.claude/skills/comm-bridge/scripts/c4-control.js');
  return new Promise((resolve, reject) => execFile(process.execPath, [script, 'enqueue', '--content', '/exit', '--priority', '1',
    '--block-queue-until-idle', '--no-ack-suffix'], {encoding:'utf8',timeout:10000}, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}

/** T07: select once; never fall back from an uncertain or rejected submission. */
export async function requestRuntimeRestart({ now = Date.now, deadlineAt, readMode = readSessionMode,
  readTransition = getModeTransition, send = submit, lookup = lookupRestartRequest,
  enqueueExit = enqueueSingleExit, requestId = `restart-${Date.now()}-${randomBytes(6).toString('hex')}` } = {}) {
  const deadline = deadlineAt ?? now() + 10000;
  const fail = (code, message, persisted = []) => ({ok:false,error:{code,message,persisted},requestId});
  if (now() >= deadline) return fail('deadline_exceeded','Restart budget was exhausted before submission');
  const mode = await readMode();
  if (now() >= deadline) return fail('deadline_exceeded','Restart budget was exhausted before submission');
  const transition = await readTransition();
  if (now() >= deadline) return fail('deadline_exceeded','Restart budget was exhausted before submission');
  if (mode.mode === 'single' && !transition) {
    const output = await enqueueExit();
    return {ok:true,data:{result:'exit_enqueued',mode:'single',output}};
  }
  const result = await send({version:1,type:'restart_all',requestId,reason:'upgrade'},{deadlineAt:deadline});
  if (result.kind === 'accepted') return {ok:true,data:{result:result.reply.result,requestId,runCount:result.reply.runCount}};
  if (result.kind === 'rejected' || !result.sent) return fail(result.reply?.code ?? result.kind,'Restart was not accepted');
  let observed;
  try { observed = await lookup(requestId,{deadlineAt:deadline,now}); } catch { observed = 'unknown'; }
  if (observed === 'accepted' || observed === 'done') return {ok:true,data:{result:observed,requestId,recoveredByLookup:true}};
  return fail('restart_result_unknown','Restart result is unknown; do not resubmit automatically',null);
}
