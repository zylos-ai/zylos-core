#!/usr/bin/env node
import { guard, memoryError, requireSyncToken } from './sync-lock.js';
import { inputError, isMain, options, parseJson, readInput, runCli } from './sync-cli.js';
import { list } from './sync-files.js';
import { verifyOriginReceipts } from '../../comm-bridge/scripts/c4-sync-batch.js';

// Cursor values come only from receipts recomputed against the database and
// from the script's own session-log listing; the worker supplies no numbers.
export async function advance({ group, input, ...settings }, deps = {}) {
  return guard({ ...settings, kind: 'origin' }, async () => {
    const payload = typeof input === 'string' ? parseJson(input) : input;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['summary', 'raw', 'inputs'].includes(key))) throw inputError('Expected {"summary":{...},"raw":{...}|null,"inputs":{...}}');
    const database = deps.database || await import('../../comm-bridge/scripts/c4-db.js');
    const actual = await list({ env: settings.env, group, now: deps.now }, { database });
    const paths = entries => Array.isArray(entries) ? entries.map(item => item?.path).sort() : null;
    if (payload.inputs?.scope !== actual.scope || JSON.stringify(paths(payload.inputs?.sessions)) !== JSON.stringify(paths(actual.sessions))) {
      throw memoryError('INPUT_CHANGED', 'Session logs differ from list --group; list and read them again');
    }
    const cursor = verifyOriginReceipts(payload, { group, database });
    if (!cursor) return { advanced: false };
    database.advanceOriginSyncCursor(group, cursor);
    return { advanced: true, ...cursor };
  });
}
if (isMain(import.meta.url)) await runCli(async () => {
  const [command, ...args] = process.argv.slice(2), parsed = options(args, ['group', 'token']);
  if (command !== 'advance' || parsed.positional.length || !Object.hasOwn(parsed, 'group')) throw inputError('Invalid command or arguments');
  requireSyncToken(parsed.token);
  console.log(JSON.stringify(await advance({ group: parsed.group, token: parsed.token, input: readInput() })));
});
