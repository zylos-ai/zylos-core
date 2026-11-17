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

export { maintenanceSyncPrompt, maintenanceSessionContext } from '../../comm-bridge/scripts/maintenance-session.js';
