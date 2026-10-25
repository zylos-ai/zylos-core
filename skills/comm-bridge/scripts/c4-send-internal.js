import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { insertInternalMessage } from './c4-db.js';
import { resolveCoreConfigModule } from './core-config-loader.js';

const invalid = (code, message) => Object.assign(new Error(message), { code });

export function parseInternalArgs(args) {
  if (args.length !== 2 || args[0] !== 'internal' || args[1].startsWith('--')) {
    throw invalid('INVALID_ARGS', 'Expected internal <target-group> with the message on stdin');
  }
  return args[1];
}

async function readSenderIdentity(group) {
  const modulePath = path.join(path.dirname(resolveCoreConfigModule()), 'runtime/session-target.js');
  const { readReadyIdentity } = await import(pathToFileURL(modulePath).href);
  return readReadyIdentity(group);
}

/** Internal writes use the sender's inherited group, never external route inference. */
export async function sendInternal(args, readBody, {
  env = process.env, insertMessage = insertInternalMessage, readIdentity = readSenderIdentity,
} = {}) {
  const target = parseInternalArgs(args);
  const content = (await readBody()).trimEnd();
  if (!content) throw invalid('EMPTY_CONTENT', 'Message content is empty');
  const sender = env.ZYLOS_SESSION_GROUP;
  if (!sender) throw invalid('NO_SENDER_GROUP', 'Sender session group is required');
  const current = await readIdentity(sender);
  const sessionId = env.ZYLOS_RUN_ID && current?.runId === env.ZYLOS_RUN_ID ? current.sessionId : null;
  try {
    const { inRow } = insertMessage(sender, target, content, { sessionId });
    return `[C4] internal message queued for ${target} (id ${inRow.id})`;
  } catch (error) {
    // The shared store reports lock contention as DB_BUSY; this command's
    // atomic-send contract reports every failed write as DB_WRITE_FAILED.
    if (error.code === 'DB_BUSY' || error.code?.startsWith('SQLITE_')) {
      throw invalid('DB_WRITE_FAILED', error.message);
    }
    throw error;
  }
}
