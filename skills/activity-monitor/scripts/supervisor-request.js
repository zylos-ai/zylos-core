#!/usr/bin/env node
import { loadCoreModule } from './core-modules.js';
import { randomUUID } from 'node:crypto';
import { isMainModule } from './is-main-module.js';
const { submit } = await loadCoreModule('am-sock-client.js');
const { assertSessionGroup } = await loadCoreModule('session-group-paths.js');

/** Request release of this session's own run; the supervisor owns stop admission. */
export async function requestRelease({ env = process.env, send = submit } = {}) {
  const sessionGroup = env.ZYLOS_SESSION_GROUP, expectedRunId = env.ZYLOS_RUN_ID;
  try {
    if (typeof sessionGroup !== 'string' || !sessionGroup || typeof expectedRunId !== 'string' || !expectedRunId.trim()) throw new Error('Missing session identity');
    assertSessionGroup(sessionGroup);
  } catch {
    return { ok: false, error: { code: 'NO_SESSION_ENV', message: 'A valid session group and run identity are required', persisted: [] } };
  }
  const response = await send({ version: 1, type: 'request_release', requestId: `release-${randomUUID()}`,
    sessionGroup, expectedRunId });
  if (response.kind === 'accepted') return { ok: true, data: { result: response.reply.result,
    sessionGroup, expectedRunId } };
  const code = response.reply?.reason ?? response.reply?.code ?? response.kind;
  return { ok: false, error: { code,
    message: response.sent && !response.reply
      ? 'Submission result is unknown; keep the current run and do not exit or assume release was accepted'
      : code === 'requests_unreadable'
        ? 'Keep the current run; repair the supervisor restart-request state, retry this request, and do not exit'
        : 'Session release was not accepted; keep the current run and do not exit',
    persisted: response.sent && !response.reply ? null : [] } };
}

export async function deferReclaim({ reason, env = process.env, send = submit } = {}) {
  const sessionGroup = env.ZYLOS_SESSION_GROUP, expectedRunId = env.ZYLOS_RUN_ID;
  try {
    if (!sessionGroup || !expectedRunId) throw new Error('Missing session identity');
    assertSessionGroup(sessionGroup);
  } catch {
    return { ok: false, error: { code: 'NO_SESSION_ENV', message: 'A valid session group and run identity are required', persisted: [] } };
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return { ok: false, error: { code: 'INVALID_ARGS', message: 'Expected a nonempty reason', persisted: [] } };
  }
  const response = await send({ version: 1, type: 'defer_reclaim', requestId: `defer-${randomUUID()}`,
    sessionGroup, expectedRunId, reason });
  if (response.kind === 'accepted') return { ok: true, data: { result: response.reply.result,
    sessionGroup, expectedRunId } };
  return { ok: false, error: { code: response.reply?.reason ?? response.reply?.code ?? response.kind,
    message: response.sent && !response.reply ? 'Submission result is unknown; do not assume reclaim was deferred' : 'Reclaim deferral was not accepted',
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
      if (!['--reason'].includes(flag) || values[flag] !== undefined || !args.length) {
        printResult({ok:false,error:{code:'INVALID_ARGS',message:'Expected defer-reclaim --reason TEXT [--json]',persisted:[]}},json); return;
      }
      values[flag] = args.shift();
    }
    try { printResult(await deferReclaim({ reason: values['--reason'] }), json); }
    catch (error) { printResult({ok:false,error:{code:error.code ?? 'REQUEST_FAILED',message:error.message,persisted:[]}},json); }
    return;
  }
  if (argv[0] === 'request-release') {
    if (argv.slice(1).some(arg => arg !== '--json')) {
      printResult({ok:false,error:{code:'INVALID_ARGS',message:'Expected request-release [--json]',persisted:[]}},json); return;
    }
    try { printResult(await requestRelease(), json); }
    catch (error) { printResult({ok:false,error:{code:error.code ?? 'REQUEST_FAILED',message:error.message,persisted:[]}},json); }
    return;
  }
  printResult({ok:false,error:{code:'INVALID_ARGS',message:'Expected request-release or defer-reclaim [--json]',persisted:[]}},json);
}
if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
