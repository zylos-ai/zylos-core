#!/usr/bin/env node
import { guard } from './sync-lock.js';
import { inputError, isMain, options, runCli } from './sync-cli.js';

export async function advance({ group, syncedId, checkpointId, ...settings }, deps = {}) {
  return guard({ ...settings, kind: 'origin' }, async () => {
    const database = deps.database || await import('../../comm-bridge/scripts/c4-db.js');
    return database.advanceOriginSyncCursor(group, { syncedId, checkpointId });
  });
}
if (isMain(import.meta.url)) await runCli(async () => {
  const [command, ...args] = process.argv.slice(2), parsed = options(args, ['group', 'synced', 'checkpoint', 'token']);
  if (command !== 'advance' || parsed.positional.length || !['group', 'synced', 'checkpoint', 'token'].every(key => Object.hasOwn(parsed, key))) throw inputError('Invalid command or arguments');
  await advance({ group: parsed.group, syncedId: Number(parsed.synced), checkpointId: Number(parsed.checkpoint), token: parsed.token });
});
