#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';
import { IDENTITY_ROTATION_PROMPT } from './sync-prompts.js';

const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

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
  const { mode, keyPresent } = await d.readSessionMode();
  if ((keyPresent && !['single', 'multi'].includes(mode)) || (!keyPresent && mode !== null)) throw failure('CONFIG_UNREADABLE', 'Invalid session mode');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--reason' || args[1] !== 'identity') throw failure('INVALID_INPUT', 'Usage: request-rotation.js --reason identity');
    const { enqueued } = await requestRotation({ reason: args[1] });
    console.log(`OK: enqueued ${enqueued.length} rotation controls`);
  } catch (error) {
    console.error(`Error [${error.code ?? 'ROTATION_FAILED'}]: ${error.message}`);
    if (error.enqueued?.length) console.error(`Already enqueued ${error.enqueued.length} controls: ${error.enqueued.map(row => row.id).join(',')}`);
    process.exitCode = 1;
  }
}
