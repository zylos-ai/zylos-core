#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadCoreModule } from '../../activity-monitor/scripts/core-modules.js';
const { requestRuntimeRestart } = await loadCoreModule('request-runtime-restart.js');

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--json')) throw Object.assign(new Error('Expected restart.js [--json]'),{code:'INVALID_ARGS'});
  const result = await requestRuntimeRestart();
  if (args.includes('--json')) process.stdout.write(JSON.stringify(result)+'\n');
  else if (result.ok) process.stdout.write(`OK: ${result.data.result}\n`);
  else process.stderr.write(`Error [${result.error.code}]: ${result.error.message}\n`);
  if (!result.ok) process.exitCode=1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error=>{
  const result={ok:false,error:{code:error.code??'RESTART_FAILED',message:error.message,persisted:[]}};
  if(process.argv.includes('--json'))process.stdout.write(JSON.stringify(result)+'\n');
  else process.stderr.write(`Error [${result.error.code}]: ${result.error.message}\n`);
  process.exitCode=1;
});
