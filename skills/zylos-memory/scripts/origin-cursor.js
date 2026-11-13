#!/usr/bin/env node
import { guard } from './sync-lock.js';
import { helpRequested, inputError, isMain, options, nonnegativeInteger, runCli } from './sync-cli.js';

export async function advance({ group, syncedId, checkpointId, ...settings }, deps = {}) {
  return guard({ ...settings, kind: 'origin' }, async () => {
    const database = deps.database || await import('../../comm-bridge/scripts/c4-db.js');
    return database.advanceOriginSyncCursor(group, { syncedId, checkpointId });
  });
}
if (isMain(import.meta.url)) await runCli(async () => {
  if (helpRequested(process.argv.slice(2), ['group', 'synced', 'checkpoint', 'token'])) {
    process.stdout.write('Usage: origin-cursor.js advance --group G --synced ID --checkpoint ID --token TOKEN\n');
    return;
  }
  const [command, ...args] = process.argv.slice(2), parsed = options(args, ['group', 'synced', 'checkpoint', 'token']);
  if (command !== 'advance' || parsed.positional.length || !['group', 'synced', 'checkpoint', 'token'].every(key => Object.hasOwn(parsed, key))) throw inputError('Invalid command or arguments');
  await advance({ group: parsed.group, syncedId: nonnegativeInteger(parsed.synced, 'synced'), checkpointId: nonnegativeInteger(parsed.checkpoint, 'checkpoint'), token: parsed.token });
});
