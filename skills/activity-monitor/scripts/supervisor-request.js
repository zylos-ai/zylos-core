#!/usr/bin/env node
import { loadCoreModule } from './core-modules.js';
import { randomUUID } from 'node:crypto';
import { isMainModule } from './is-main-module.js';
const { submit } = await loadCoreModule('am-sock-client.js');
const { assertSessionGroup } = await loadCoreModule('session-group-paths.js');

export async function readyForConfigReclaim({ env = process.env, send = submit } = {}) {
  const sessionGroup = env.ZYLOS_SESSION_GROUP; const expectedRunId = env.ZYLOS_RUN_ID;
  if (!sessionGroup || !expectedRunId) return { ok: false, error: { code: 'NO_SESSION_ENV', message: 'A session group and run identity are required', persisted: [] } };
  try { assertSessionGroup(sessionGroup); }
  catch { return { ok: false, error: { code: 'NO_SESSION_ENV', message: 'Invalid session group', persisted: [] } }; }
  const result = await send({ version: 1, type: 'ready_for_config_reclaim', requestId: `cfg-${randomUUID()}`, sessionGroup, expectedRunId });
  if (result.kind === 'accepted') return { ok: true, data: { result: result.reply.result, sessionGroup, expectedRunId } };
  const code = result.reply?.code ?? result.reply?.reason ?? result.kind;
  return { ok: false, error: { code,
    message: result.sent && !result.reply
      ? 'Submission result is unknown; keep the handoff and do not exit'
      : code === 'requests_unreadable'
        ? 'Keep the completed handoff and current run; repair the supervisor restart-request state, retry this request, and do not exit'
        : 'Configuration reclaim was not accepted',
    persisted: result.sent && !result.reply ? null : [] } };
}

export async function deferReclaim({ minutes, reason, env = process.env, send = submit } = {}) {
  const sessionGroup = env.ZYLOS_SESSION_GROUP, expectedRunId = env.ZYLOS_RUN_ID;
  try {
    if (!sessionGroup || !expectedRunId) throw new Error('Missing session identity');
    assertSessionGroup(sessionGroup);
  } catch {
    return { ok: false, error: { code: 'NO_SESSION_ENV', message: 'A valid session group and run identity are required', persisted: [] } };
  }
  if (!Number.isFinite(minutes) || typeof reason !== 'string' || !reason.trim()) {
    return { ok: false, error: { code: 'INVALID_ARGS', message: 'Expected finite minutes and a nonempty reason', persisted: [] } };
  }
  const response = await send({ version: 1, type: 'defer_reclaim', requestId: `defer-${randomUUID()}`,
    sessionGroup, expectedRunId, minutes, reason });
  if (response.kind === 'accepted') return { ok: true, data: { result: response.reply.result,
    deferUntil: response.reply.deferUntil, sessionGroup, expectedRunId } };
  const maxMinutes = response.reply?.reason === 'minutes_out_of_range' ? response.reply.maxMinutes : undefined;
  return { ok: false, error: { code: response.reply?.reason ?? response.reply?.code ?? response.kind,
    message: maxMinutes !== undefined ? `Reclaim deferral minutes must be between 1 and ${maxMinutes}`
      : response.sent && !response.reply ? 'Submission result is unknown; do not assume reclaim was deferred' : 'Reclaim deferral was not accepted',
    ...(maxMinutes !== undefined ? { maxMinutes } : {}),
    persisted: response.sent && !response.reply ? null : [] } };
}

function printResult(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.ok) process.stdout.write(`OK: ${result.data.result}\n`);
  else process.stderr.write(`Error [${result.error.code}]: ${result.error.message}\n`);
  if (!result.ok) process.exitCode = 1;
}
async function main(argv) {
  const json = argv.includes('--json') || argv[0] === 'defer-reclaim';
  if (argv[0] === 'defer-reclaim') {
    const args = argv.slice(1).filter(arg => arg !== '--json');
    const values = {};
    while (args.length) {
      const flag = args.shift();
      if (!['--minutes', '--reason'].includes(flag) || values[flag] !== undefined || !args.length) {
        printResult({ok:false,error:{code:'INVALID_ARGS',message:'Expected defer-reclaim --minutes N --reason TEXT [--json]',persisted:[]}},json); return;
      }
      values[flag] = args.shift();
    }
    try { printResult(await deferReclaim({ minutes: Number(values['--minutes']), reason: values['--reason'] }), json); }
    catch (error) { printResult({ok:false,error:{code:error.code ?? 'REQUEST_FAILED',message:error.message,persisted:[]}},json); }
    return;
  }
  if (argv[0] !== 'ready-for-config-reclaim' || argv.slice(1).some(arg => arg !== '--json')) {
    printResult({ok:false,error:{code:'INVALID_ARGS',message:'Expected ready-for-config-reclaim [--json]',persisted:[]}},json);return;
  }
  try { printResult(await readyForConfigReclaim(), json); }
  catch (error) { printResult({ok:false,error:{code:error.code ?? 'REQUEST_FAILED',message:error.message,persisted:[]}},json); }
}
if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
