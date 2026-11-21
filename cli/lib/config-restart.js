import { randomUUID } from 'node:crypto';
import { submit } from './am-sock-client.js';

export async function requestConfigRestart({ sessionGroup, runId }, send = submit) {
  if (!runId) return { status: 'not_restarted', reason: 'identity_unavailable' };
  try {
    const result = await send({ version: 1, type: 'manual_restart', requestId: randomUUID(),
      sessionGroup, expectedRunId: runId }, { deadlineAt: Date.now() + 10000 });
    if (result.kind === 'accepted' && ['accepted', 'already_accepted'].includes(result.reply.result)) {
      return { status: 'accepted' };
    }
    const reason = result.reply?.reason ?? result.reply?.code ?? result.reply?.result ?? result.kind;
    return { status: result.sent && !result.reply ? 'unknown' : 'not_restarted', reason };
  } catch (error) {
    return { status: 'unknown', reason: error.code ?? error.message };
  }
}
