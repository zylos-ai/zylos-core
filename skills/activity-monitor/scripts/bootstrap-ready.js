import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootstrapScope } from './bootstrap-scope.js';
import { enqueueStartupPrompt } from './session-start-prompt.js';
import { isSubsession, readBootstrapIdentity } from './bootstrap-identity.js';

export async function publishBootstrapReady(payload, { env = process.env, enqueue = enqueueStartupPrompt, scopeReader = bootstrapScope, identityReader = readBootstrapIdentity, now = Date.now, write = fs.writeFileSync, rename = fs.renameSync } = {}) {
  if (!['startup', 'clear'].includes(payload?.source) || isSubsession(payload)) return { skipped: true };
  if (!env.ZYLOS_RUN_ID || typeof payload.session_id !== 'string' || !payload.session_id) return { skipped: true, reason: 'identity_missing' };
  const scope = await scopeReader(env);
  await identityReader(scope, { env });
  let startupControlIds = [];
  try { startupControlIds = (await enqueue(payload.source)).startupControlIds ?? []; }
  catch (error) { console.error(`[bootstrap-ready] enqueue failed: ${error.message}`); }
  if (!Array.isArray(startupControlIds) || !startupControlIds.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid startup control ids');
  const record = { runId: env.ZYLOS_RUN_ID, sessionId: payload.session_id, startupControlIds, ts: now() };
  fs.mkdirSync(scope.dir, { recursive: true });
  const file = path.join(scope.dir, 'current-session.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  write(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
  rename(temporary, file);
  return record;
}
