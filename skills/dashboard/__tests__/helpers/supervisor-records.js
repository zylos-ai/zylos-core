import fs from 'node:fs';
import path from 'node:path';
import { CoreLogImporter } from '../../src/lib/core-log-importer.js';

// One supervisor diagnostic line in the shape activity-monitor/scripts/supervisor.js appends.
export function supervisorRecord(ts, event, sessionGroup, runId, details = {}) {
  const body = { event, sessionGroup, runId, run_id: runId, runtime: 'claude', ...details };
  return { v: 1, ts, session_group: sessionGroup, conversation_id: null, decision: event, reason: details.reason ?? '', ...body };
}

// The supervisor's real record sequences, as its observer and exit path write them.
export const supervisorSequences = {
  // Reminded, then restarted after the grace; the exit path reports the stopped run as a crash about 1.1 s later.
  noResponseRestart: (at, group, runId) => [
    supervisorRecord(at, 'no_response_nudge', group, runId, { reason: 'no_response_nudge', silence_ms: 300_000, enqueued: true,
      escape_enqueued: true, superseded: false }),
    supervisorRecord(at + 120_000, 'no_response_restart', group, runId, { reason: 'no_response_restart', silence_ms: 420_000 }),
    supervisorRecord(at + 121_100, 'crash_detected', group, runId, { sessionId: 'session-' + runId }),
  ],
  toolTimeoutRestart: (at, group, runId) => [
    supervisorRecord(at, 'tool_timeout_nudge', group, runId, { reason: 'tool_timeout_nudge', tool: 'Bash' }),
    supervisorRecord(at + 60_000, 'tool_timeout_restart', group, runId, { reason: 'tool_timeout_restart', tool: 'Bash', silence_ms: 960_000 }),
    supervisorRecord(at + 61_100, 'crash_detected', group, runId, { sessionId: 'session-' + runId }),
  ],
  crash: (at, group, runId) => [supervisorRecord(at, 'crash_detected', group, runId, { sessionId: 'session-' + runId })],
  nudge: (at, group, runId) => [supervisorRecord(at, 'no_response_nudge', group, runId, { reason: 'no_response_nudge',
    silence_ms: 300_000, enqueued: true, escape_enqueued: true, superseded: false })],
};

// Imports records through the Dashboard's own supervisor log importer into a real Store.
export async function importSupervisorRecords({ store, root }, records) {
  const file = path.join(root, `supervisor-events-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const importer = new CoreLogImporter({ store, zylosDir: root });
  try { await importer.importFile('supervisor', file); } finally { await importer.stop(); fs.rmSync(file, { force: true }); }
}
