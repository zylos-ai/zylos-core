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
  return { ok: false, error: { code: result.reply?.code ?? result.reply?.reason ?? result.kind,
    message: result.sent && !result.reply ? 'Submission result is unknown; keep the handoff and do not exit' : 'Configuration reclaim was not accepted',
    persisted: result.sent && !result.reply ? null : [] } };
}

function printResult(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (result.ok) process.stdout.write(`OK: ${result.data.result}\n`);
  else process.stderr.write(`Error [${result.error.code}]: ${result.error.message}\n`);
  if (!result.ok) process.exitCode = 1;
}
async function main(argv) {
  const json = argv.includes('--json');
  if (argv[0] !== 'ready-for-config-reclaim' || argv.slice(1).some(arg => arg !== '--json')) {
    printResult({ok:false,error:{code:'INVALID_ARGS',message:'Expected ready-for-config-reclaim [--json]',persisted:[]}},json);return;
  }
  try { printResult(await readyForConfigReclaim(), json); }
  catch (error) { printResult({ok:false,error:{code:error.code ?? 'REQUEST_FAILED',message:error.message,persisted:[]}},json); }
}
if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
