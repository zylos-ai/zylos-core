import { validateChannel } from '../c4-validate.js';

/** Called only after expirePending=true; the original D1 row supplies routing. */
export function createPendingExpiryHandler({ resolveSessionLaunchConfig, readRuntimeHealth, sendStatusNotice,
  isComponent = channel => { try { validateChannel(channel, true); return true; } catch { return false; } } }) {
  return async function handleExpired(row, { sessionMode, identity, launchConfig } = {}) {
    if (!row.endpoint_id || ['system', 'void', 'internal'].includes(row.channel) || !isComponent(row.channel)) {
      return { outcome: 'skipped' };
    }
    let runtime = 'unknown';
    if (identity?.present) runtime = identity.runtime || 'unknown';
    else if (identity?.present === false) {
      try { runtime = (launchConfig ?? resolveSessionLaunchConfig({ sessionGroup: sessionMode === 'single' ? null : row.session_group,
        sessionMode })).runtime || 'unknown'; } catch { /* Unknown remains unknown; no default runtime. */ }
    }
    let health = 'unavailable';
    if (runtime !== 'unknown') {
      try {
        const status = readRuntimeHealth(runtime);
        health = status.missing ? 'ok' : status.unreadable ? 'unavailable' : status.publicHealth ||
          (['recovering', 'down'].includes(status.health) ? 'unavailable' : status.health || 'unavailable');
      } catch { /* Unreadable health projects to unavailable. */ }
    }
    return sendStatusNotice(row, { runtime, health, reason: 'pending_expired', noticeKind: 'pending_expired' });
  };
}
