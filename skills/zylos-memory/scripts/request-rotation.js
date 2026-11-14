#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';
import { IDENTITY_ROTATION_PROMPT } from './sync-prompts.js';
import { helpRequested, memoryError as failure, isMain, options, runCli } from './sync-cli.js';


async function defaultDependencies() {
  const coreDir = path.dirname(resolveCoreConfigModule());
  const [{ readSessionMode }, { listGroupTmuxSessions }, { readLiveIdentity }, db] = await Promise.all([
    import(pathToFileURL(path.join(coreDir, 'config.js')).href),
    import(pathToFileURL(path.join(coreDir, 'session-group-paths.js')).href),
    import(pathToFileURL(path.join(coreDir, 'session-state-reader.js')).href),
    import('../../comm-bridge/scripts/c4-db.js'),
  ]);
  return { readSessionMode, listGroupTmuxSessions, readLiveIdentity, buildTargetBinding: db.buildTargetBinding, getModeTransition: db.getModeTransition, insertControl: db.insertControl };
}

export async function requestRotation({ reason = 'identity' } = {}, dependencies) {
  if (reason !== 'identity') throw failure('INVALID_INPUT', 'Only identity rotation is supported');
  const d = dependencies ?? await defaultDependencies();
  const { mode } = await d.readSessionMode();
  if (await d.getModeTransition()) throw failure('TRANSITION_OPEN', 'A mode transition is in progress');
  const sessions = await d.listGroupTmuxSessions();
  const targets = mode === 'multi' ? sessions.map(session => session.sessionGroup) : sessions.some(session => session.sessionGroup === 'origin') ? [null] : [];
  const enqueued = [], skipped = [];
  try {
    for (const sessionGroup of targets) {
      let targetBinding = null;
      if (mode === 'multi') {
        const live = await d.readLiveIdentity(sessionGroup);
        if (!live.present || !live.runId) {
          skipped.push({ sessionGroup, code: 'TARGET_NOT_RUNNING' });
          continue;
        }
        try {
          targetBinding = await d.buildTargetBinding({ sessionGroup, expectedRunId: live.runId });
        } catch (error) {
          if (!error.code?.startsWith('TARGET_')) throw error;
          skipped.push({ sessionGroup, code: error.code });
          continue;
        }
      }
      const control = await d.insertControl(IDENTITY_ROTATION_PROMPT, { sessionGroup, targetBinding, priority: 2, requireIdle: true, appendAckSuffix: false });
      enqueued.push({ sessionGroup, id: control.id });
    }
  } catch (error) {
    // Earlier queue transactions remain committed; never retry them here.
    error.enqueued = enqueued;
    throw error;
  }
  return { enqueued, skipped };
}

export function printRotationResult({ enqueued, skipped }, write = console.log) {
  write(`OK: enqueued ${enqueued.length} rotation controls`);
  for (const { sessionGroup, code } of skipped) write(`SKIPPED: ${sessionGroup} ${code}`);
}

if (isMain(import.meta.url)) await runCli(async () => {
  if (helpRequested(process.argv.slice(2), ['reason'])) {
    process.stdout.write('Usage: request-rotation.js --reason identity\n');
    return;
  }
  const parsed = options(process.argv.slice(2), ['reason']);
  if (parsed.positional.length || parsed.reason !== 'identity') throw failure('INVALID_INPUT', 'Usage: request-rotation.js --reason identity');
  printRotationResult(await requestRotation({ reason: parsed.reason }));
});
