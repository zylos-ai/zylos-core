import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSessionGroup } from './c4-session-group.js';

// The receipt belongs to this exact runtime run, independently of the shared
// scheduling ledger. A replacement run can never inherit maintenance purpose.
export function maintenancePurposeFile(sessionGroup, env = process.env) {
  if (!parseSessionGroup(sessionGroup)) throw new Error('Invalid maintenance session group');
  const root = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  return path.join(root, 'activity-monitor', 'session-groups', sessionGroup, 'maintenance-run.json');
}

export function readMaintenancePurpose(env = process.env) {
  const sessionGroup = env.ZYLOS_SESSION_GROUP, runId = env.ZYLOS_RUN_ID;
  if (!sessionGroup || !runId) return null;
  try {
    const row = JSON.parse(fs.readFileSync(maintenancePurposeFile(sessionGroup, env), 'utf8'));
    return row && row.sessionGroup === sessionGroup && row.runId === runId &&
      ['running', 'finishing', 'ordinary', 'complete', 'failed'].includes(row.phase) ? row : null;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[sync-maintenance] run purpose unavailable: ${error.code ?? error.message}`);
    return null;
  }
}

export function readMaintenanceSession(env = process.env) {
  const purpose = readMaintenancePurpose(env);
  return purpose && ['running', 'finishing'].includes(purpose.phase) ? purpose : null;
}

export const maintenanceSyncPrompt = [
  'This is a maintenance session. Read zylos-memory and run exactly one group Memory Sync in the current runtime.',
  'Explicitly authorize the worker to repair state when a checkpoint already exists, and retained inputs even with no new conversations, using protected commit instead of the no-new-work exit.',
  'Do not resume handoff work, pending tasks or unrelated work, or reply to any channel.',
  'Wait for the worker result before acknowledging, then stop; the supervisor reclaims this session.',
  'Real conversation delivery ends maintenance; handle it normally.',
].join(' ');

export const maintenanceSessionContext = [
  'This is a maintenance session whose only job is exactly one group Memory Sync.',
  'Wait for the maintenance startup control to be delivered; this context is not a second Sync request.',
  'This task explicitly authorizes state-only repair even with no new conversations: pass that exception to the worker and use the protected commit procedure, rather than the ordinary no-new-work early exit.',
  'Do not resume handoff work, act on pending tasks, reply to any channel, or perform other work.',
  'A new real conversation ends maintenance and may be handled normally.',
].join(' ');
