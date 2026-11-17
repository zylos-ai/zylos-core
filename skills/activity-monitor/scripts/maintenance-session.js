import { loadCoreModule } from './bootstrap-scope.js';

/** Purpose belongs to the persisted exact run, never to a reusable environment. */
export async function readMaintenanceSession(env = process.env) {
  if (!env.ZYLOS_SESSION_GROUP || !env.ZYLOS_RUN_ID) return null;
  const { readMaintenanceRun } = await loadCoreModule('sync-maintenance.js');
  return readMaintenanceRun({ env, sessionGroup: env.ZYLOS_SESSION_GROUP, runId: env.ZYLOS_RUN_ID });
}

/** Reserve before enqueue so hook retries and /clear cannot repeat the Sync. */
export async function claimMaintenanceStartup(maintenance, env = process.env) {
  const { createMaintenanceRequests } = await loadCoreModule('sync-maintenance.js');
  return createMaintenanceRequests({ env }).claimStartup(maintenance.sessionGroup, maintenance.runId);
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
