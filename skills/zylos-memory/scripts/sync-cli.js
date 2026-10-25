import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { escapeText } from '../../comm-bridge/scripts/c4-query-format.js';

export const inputError = message => Object.assign(new Error(message), { code: 'INVALID_INPUT' });
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
export async function runCli(action) {
  try { await action(); }
  catch (error) {
    console.error(`Error [${error.code || 'WRITE_FAILED'}]: ${escapeText(error.message)}`);
    process.exitCode = error.code === 'TOKEN_MISMATCH' ? 3 : error.code === 'FRAGMENT_CONFLICT' ? 4 : ['LOCK_TIMEOUT', 'SYNC_BUSY'].includes(error.code) ? 2 : 1;
  }
}
