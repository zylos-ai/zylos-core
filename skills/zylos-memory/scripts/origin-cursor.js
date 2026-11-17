#!/usr/bin/env node
import path from 'node:path';
import { guard, memoryError, requireSyncToken } from './sync-lock.js';
import { helpRequested, inputError, isMain, options, parseJson, readInput, runCli } from './sync-cli.js';
import { listWithDate } from './sync-files.js';
import { verifyOriginReceipts } from '../../comm-bridge/scripts/c4-sync-batch.js';

import { recordResult, withResult } from './sync-results.js';
import { updateOriginRound } from './origin-round.js';

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
  return withResult({ ...settings, kind: 'origin', group }, 'advance', () => {
    return guard({ ...settings, kind: 'origin' }, async scope => {
      const { marker } = scope;
      try {
        const payload = typeof input === 'string' ? parseJson(input) : input;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['summary', 'raw', 'inputs'].includes(key))) throw inputError('Expected {"summary":{...},"raw":{...}|null,"inputs":{...}}');
        const database = deps.database || await import('../../comm-bridge/scripts/c4-db.js');
        // Use one instant for log validation and the cursor's next-list boundary.
        const at = (deps.now ?? Date.now)();
        const { inputs: actual, today } = await listWithDate({ env: settings.env, group, now: () => at }, { database });
        if (payload.inputs?.scope !== actual.scope || !sessionsUnchanged(payload.inputs?.sessions, actual.sessions, today)) {
          throw memoryError('INPUT_CHANGED', 'Session logs differ from list --group; list and read them again');
        }
        const before = database.getOriginSyncCursor(group) || { syncedId: 0, checkpointId: 0 };
        const cursor = verifyOriginReceipts(payload, { group, database });
        const advanced = !!cursor && (cursor.syncedId !== before.syncedId || cursor.checkpointId !== before.checkpointId);
        if (cursor) database.advanceOriginSyncCursor(group, { ...cursor, updatedAt: Math.floor(at / 1000) });
        // Diagnostic accounting must not turn an already published cursor into a failure.
        try { updateOriginRound(scope, marker, { count: payload.raw?.count || 0, advanced }); } catch { /* Keep the protected operation outcome. */ }
        await recordResult({ action: 'advance', kind: 'origin', status: 'success', scope: 'origin',
          group, startedAt: marker.startedAt, advanced, count: payload.raw?.count || 0,
          checkpointId: cursor?.checkpointId, fromId: before.syncedId,
          toId: cursor?.syncedId ?? before.syncedId, fromCheckpointId: before.checkpointId,
          toCheckpointId: cursor?.checkpointId ?? before.checkpointId }, settings);
        return cursor ? { advanced: true, ...cursor } : { advanced: false };
      } catch (error) {
        try { updateOriginRound(scope, marker, { error: true }); } catch { /* Keep the protected operation outcome. */ }
        throw error;
      }
    }, { recordFailure: false });
  });
}
if (isMain(import.meta.url)) await runCli(async () => {
  if (helpRequested(process.argv.slice(2), ['group', 'token'])) {
    process.stdout.write('Usage: origin-cursor.js advance --group G --token TOKEN < JSON\n');
    return;
  }
  const [command, ...args] = process.argv.slice(2), parsed = options(args, ['group', 'token']);
  if (command !== 'advance' || parsed.positional.length || !Object.hasOwn(parsed, 'group')) throw inputError('Invalid command or arguments');
  await withResult({ kind: 'origin', group: parsed.group }, 'advance', () => requireSyncToken(parsed.token));
  console.log(JSON.stringify(await advance({ group: parsed.group, token: parsed.token, input: readInput() })));
});
