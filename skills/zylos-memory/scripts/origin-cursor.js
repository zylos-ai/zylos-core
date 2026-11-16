#!/usr/bin/env node
import path from 'node:path';
import { guard, memoryError, requireSyncToken } from './sync-lock.js';
import { helpRequested, inputError, isMain, options, parseJson, readInput, runCli } from './sync-cli.js';
import { listWithDate } from './sync-files.js';
import { verifyOriginReceipts } from '../../comm-bridge/scripts/c4-sync-batch.js';

const logDate = file => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(path.basename(file))?.[1] ?? null;
const byPath = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
// After this advance the next list starts at today's date, so a log dated
// before today is never listed again: it must match what was read, path and
// content. Today's log is listed again next run, so it may appear or grow, but
// a log that was listed must still be there.
function sessionsUnchanged(listed, actual, today) {
  if (!Array.isArray(listed) || listed.some(item => typeof item?.path !== 'string')) return false;
  const earlier = item => { const date = logDate(item.path); return date !== null && date < today; };
  const final = entries => JSON.stringify(entries.filter(earlier).map(item => [item.path, item.sha256 ?? null]).sort(byPath));
  if (final(listed) !== final(actual)) return false;
  const current = new Set(actual.filter(item => logDate(item.path) === today).map(item => item.path));
  return listed.every(item => earlier(item) || current.has(item.path));
}

// Cursor values come only from receipts recomputed against the database and
// from the script's own session-log listing; the worker supplies no numbers.
export async function advance({ group, input, ...settings }, deps = {}) {
  return guard({ ...settings, kind: 'origin' }, async () => {
    const payload = typeof input === 'string' ? parseJson(input) : input;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['summary', 'raw', 'inputs'].includes(key))) throw inputError('Expected {"summary":{...},"raw":{...}|null,"inputs":{...}}');
    const database = deps.database || await import('../../comm-bridge/scripts/c4-db.js');
    // "Today" is this script's own date, from the same list call and timezone.
    const { inputs: actual, today } = await listWithDate({ env: settings.env, group, now: deps.now }, { database });
    if (payload.inputs?.scope !== actual.scope || !sessionsUnchanged(payload.inputs?.sessions, actual.sessions, today)) {
      throw memoryError('INPUT_CHANGED', 'Session logs differ from list --group; list and read them again');
    }
    const cursor = verifyOriginReceipts(payload, { group, database });
    if (!cursor) return { advanced: false };
    database.advanceOriginSyncCursor(group, cursor);
    return { advanced: true, ...cursor };
  });
}
if (isMain(import.meta.url)) await runCli(async () => {
  if (helpRequested(process.argv.slice(2), ['group', 'token'])) {
    process.stdout.write('Usage: origin-cursor.js advance --group G --token TOKEN < JSON\n');
    return;
  }
  const [command, ...args] = process.argv.slice(2), parsed = options(args, ['group', 'token']);
  if (command !== 'advance' || parsed.positional.length || !Object.hasOwn(parsed, 'group')) throw inputError('Invalid command or arguments');
  requireSyncToken(parsed.token);
  console.log(JSON.stringify(await advance({ group: parsed.group, token: parsed.token, input: readInput() })));
});
