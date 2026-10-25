import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCoreModule } from './core-modules.js';
const { readSessionMode } = await loadCoreModule('config.js');
const script = fileURLToPath(new URL('../../comm-bridge/scripts/c4-control.js', import.meta.url));

export function runControl(args) {
  return new Promise(resolve => execFile(process.execPath, [script, ...args], {encoding:'utf8',timeout:10000}, (error,stdout,stderr) =>
    resolve({ok:!error,output:(stdout || stderr || error?.message || '').trim()})));
}
export async function enqueueMachineControl(args, {readMode = readSessionMode, run = runControl} = {}) {
  const {mode} = await readMode();
  if (!['single','multi'].includes(mode)) throw new Error('Invalid session mode');
  if (args.includes('--group')) throw new Error('Machine controls cannot override their target');
  return run([...args,...(mode === 'multi' ? ['--group','origin'] : [])]);
}
