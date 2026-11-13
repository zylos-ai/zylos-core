import { CHECKPOINT_THRESHOLD } from '../../comm-bridge/scripts/c4-config.js';

function positiveInteger(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return undefined;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Resolve startup settings once; invalid optional values fall through to the
 * next source. Mode, model thresholds and launch configuration refresh separately. */
export function parseSupervisorConfiguration(config, env = process.env) {
  const setting = (key, fallback) => positiveInteger(env[`ZYLOS_${key.toUpperCase()}`])
    ?? positiveInteger(config[key]) ?? fallback;
  return {
    hotTtlSeconds: setting('session_hot_ttl_seconds', 1800),
    reclaimDeferMaxSeconds: setting('session_reclaim_defer_max_seconds', 1800),
    reclaimDeferAlertSeconds: setting('session_reclaim_defer_alert_seconds', 7200),
    evictMinIdleSeconds: setting('session_evict_min_idle_seconds', 300),
    syncMinIntervalSeconds: setting('sync_min_interval_seconds', 600),
    syncMaxIntervalSeconds: setting('sync_max_interval_seconds', 21600),
    originSyncThreshold: setting('origin_sync_threshold', 50),
    syncBatchLimit: setting('sync_batch_limit', 200),
    syncThreshold: CHECKPOINT_THRESHOLD,
  };
}
