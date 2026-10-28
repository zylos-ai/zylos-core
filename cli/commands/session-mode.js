import { randomUUID } from 'node:crypto';
import { submit, lookupModeSwitch } from '../lib/am-sock-client.js';

const failure = (code, message, persisted = []) => ({ ok: false, error: { code, message, persisted } });

/** A switch submits once. A lost response can only be resolved by observation. */
export async function executeSessionMode(args, {
  send = submit, lookup = lookupModeSwitch, now = Date.now, requestId = randomUUID,
  deadlineAt,
} = {}) {
  const jsonFlags = args.filter(arg => arg === '--json').length;
  const positional = args.filter(arg => arg !== '--json');
  const [command, target] = positional;
  if (jsonFlags > 1 || command !== 'switch' || positional.length !== 2 || !['single', 'multi'].includes(target)) {
    return failure('INVALID_ARGUMENT', 'Usage: zylos session-mode switch <single|multi> [--json]');
  }
  const deadline = deadlineAt ?? now() + 10000;
  let response;
  try {
    response = await send({ version: 1, type: 'mode_switch', requestId: requestId(), target }, { deadlineAt: deadline });
  } catch (error) {
    // A transport exception cannot establish whether a request reached M4.
    return failure(error.code ?? 'no_reply', `Switch result unknown: ${error.message}`, null);
  }
  if (response.kind === 'accepted') {
    const { result, runId } = response.reply;
    return { ok: true, data: { target, result, ...(runId ? { runId } : {}) } };
  }
  if (response.kind === 'rejected') {
    const { code, runId, target: openTarget } = response.reply;
    const result = failure(code, `Mode switch rejected: ${code}`);
    if (code === 'transition_open') Object.assign(result.error, { runId, target: openTarget });
    return result;
  }
  if (!response.sent) return failure(response.kind, 'Mode switch was not submitted');
  try {
    const observed = await lookup(target, { deadlineAt: deadline });
    if (observed === 'accepted' || observed === 'done') {
      // This reports current authoritative facts, not a claim that our request committed.
      return { ok: true, data: { target, observed: observed === 'accepted' ? 'transition_open' : 'target_mode' } };
    }
  } catch { /* Failure to observe leaves the original submission uncertain. */ }
  return failure(response.kind, 'Mode switch result unknown; inspect session-mode status before taking further action', null);
}

export async function sessionModeCommand(args, dependencies) {
  const result = await executeSessionMode(args, dependencies);
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else if (!result.ok) console.error(`Error [${result.error.code}]: ${result.error.message}`);
  else if (result.data.observed) console.log(`OK: observed ${result.data.observed} for ${result.data.target}`);
  else console.log(`OK: mode switch ${result.data.result}${result.data.runId ? ` (${result.data.runId})` : ''}`);
  if (!result.ok) process.exitCode = 1;
  return result;
}
