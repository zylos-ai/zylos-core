export async function recordResult(details, settings = {}) {
  try {
    const { loadCoreModule } = await import('../../comm-bridge/scripts/router/core-modules.js');
    const { recordSyncResult } = await loadCoreModule('sync-observability.js');
    recordSyncResult({ scope: (settings.env || process.env).ZYLOS_SESSION_GROUP || '*',
      kind: ['group', 'origin', 'global'].includes(settings.kind) ? settings.kind : ((settings.env || process.env).ZYLOS_SESSION_GROUP ? 'group' : 'global'),
      runId: (settings.env || process.env).ZYLOS_RUN_ID || null, ...details }, { env: settings.env || process.env });
  } catch { /* Observability cannot change a protected operation's outcome. */ }
}
export async function withResult(settings, action, operation) {
  try { return await operation(); }
  catch (error) {
    await recordResult({ action, group: settings.group, status: 'error', code: error.code || 'IO_ERROR' }, settings);
    throw error;
  }
}
