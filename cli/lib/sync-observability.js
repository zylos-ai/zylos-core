import { appendEvent } from './event-log.js';
import { supervisorDiagnosticPath } from './session-group-paths.js';

// Diagnostics are best effort: a log failure must never undo published memory.
// Keep a fixed metadata allowlist; receipts, tokens and content never enter logs.
const fields = ['scope', 'kind', 'status', 'code', 'action', 'runId', 'startedAt', 'group',
  'checkpointId', 'fromId', 'toId', 'fromCheckpointId', 'toCheckpointId', 'count', 'processedCount', 'remainingQuota',
  'hasRemaining', 'advanced', 'advancedGroups', 'errorCount'];
export function recordSyncResult(details, { env = process.env, now = Date.now() } = {}) {
  try {
    const safe = Object.fromEntries(fields.filter(key => details[key] !== undefined).map(key => [key, details[key]]));
    appendEvent(supervisorDiagnosticPath(env), { v: 1, ts: typeof now === 'function' ? now() : now,
      event: 'sync_result', decision: 'sync_result', ...safe });
    return true;
  } catch { return false; }
}
