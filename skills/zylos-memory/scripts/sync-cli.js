import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { escapeText } from '../../comm-bridge/scripts/c4-query-format.js';

export const exitCode = code => code === 'TOKEN_MISMATCH' ? 3 : ['LOCK_TIMEOUT', 'SYNC_BUSY'].includes(code) ? 2 : 1;
export const memoryError = (code, message, extra = {}) => Object.assign(new Error(message), { code, exitCode: exitCode(code), ...extra });
export const inputError = message => memoryError('INVALID_INPUT', message);
export const isMain = url => process.argv[1] && pathToFileURL(process.argv[1]).href === url;
export const readInput = () => fs.readFileSync(0, 'utf8');
export function parseJson(text) {
  try { return JSON.parse(text); } catch { throw inputError('Expected JSON input'); }
}
export function options(argv, values = [], flags = []) {
  const result = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(result, key)) throw inputError(`Duplicate option ${arg}`);
    if (flags.includes(key)) result[key] = true;
    else if (values.includes(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) result[key] = argv[++i];
    else throw inputError(`Invalid option ${arg}`);
  }
  return { ...result, positional };
}
export function reportMemoryError(error) {
  console.error(`Error [${error.code || 'IO_ERROR'}]: ${escapeText(error.message)}`);
  if (error.enqueued?.length) console.error(`Already enqueued ${error.enqueued.length} controls: ${error.enqueued.map(row => row.id).join(',')}`);
  process.exitCode = exitCode(error.code);
}
export async function runCli(action) {
  try { await action(); } catch (error) { reportMemoryError(error); }
}
