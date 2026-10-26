#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';
import { IDENTITY_ROTATION_PROMPT } from './sync-prompts.js';
import { memoryError as failure, isMain, options, runCli } from './sync-cli.js';


async function defaultDependencies() {
  const coreDir = path.dirname(resolveCoreConfigModule());
  const [{ readSessionMode }, { listGroupTmuxSessions }, db] = await Promise.all([
    import(pathToFileURL(path.join(coreDir, 'config.js')).href),
    import(pathToFileURL(path.join(coreDir, 'session-group-paths.js')).href),
    import('../../comm-bridge/scripts/c4-db.js'),
  ]);
  return { readSessionMode, listGroupTmuxSessions, getModeTransition: db.getModeTransition, insertControl: db.insertControl };
}

export async function requestRotation({ reason = 'identity' } = {}, dependencies) {
  if (reason !== 'identity') throw failure('INVALID_INPUT', 'Only identity rotation is supported');
  const d = dependencies ?? await defaultDependencies();
  const { mode } = await d.readSessionMode();
  if (await d.getModeTransition()) throw failure('TRANSITION_OPEN', 'A mode transition is in progress');
  const sessions = await d.listGroupTmuxSessions();
  const targets = mode === 'multi' ? sessions.map(session => session.sessionGroup) : sessions.some(session => session.sessionGroup === 'origin') ? [null] : [];
  const enqueued = [];
  try {
    for (const sessionGroup of targets) {
      const control = await d.insertControl(IDENTITY_ROTATION_PROMPT, { sessionGroup, priority: 2, requireIdle: true, appendAckSuffix: false });
      enqueued.push({ sessionGroup, id: control.id });
    }
  } catch (error) {
    // Earlier queue transactions remain committed; never retry them here.
    error.enqueued = enqueued;
    throw error;
  }
  return { enqueued };
}

if (isMain(import.meta.url)) await runCli(async () => {
  const parsed = options(process.argv.slice(2), ['reason']);
  if (parsed.positional.length || parsed.reason !== 'identity') throw failure('INVALID_INPUT', 'Usage: request-rotation.js --reason identity');
  const { enqueued } = await requestRotation({ reason: parsed.reason });
  console.log(`OK: enqueued ${enqueued.length} rotation controls`);
});
