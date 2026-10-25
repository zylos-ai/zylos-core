import { CHECKPOINT_THRESHOLD } from '../../comm-bridge/scripts/c4-config.js';

function positiveInteger(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return undefined;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// Keep the established runtime threshold parsing and bounds.
function rotationThreshold(value, fallback) {
  const threshold = Number.parseInt(value, 10);
  return threshold > 0 && threshold <= 100 ? threshold : fallback;
}

/** Resolve startup settings once; invalid optional values fall through to the
 * next source. Mode and launch configuration remain separately refreshable. */
export function parseSupervisorConfiguration(config, env = process.env) {
  const setting = (key, fallback) => positiveInteger(env[`ZYLOS_${key.toUpperCase()}`])
    ?? positiveInteger(config[key]) ?? fallback;
  return {
    hotTtlSeconds: setting('session_hot_ttl_seconds', 1800),
    syncMinIntervalSeconds: setting('sync_min_interval_seconds', 600),
    syncMaxIntervalSeconds: setting('sync_max_interval_seconds', 21600),
    originSyncThreshold: setting('origin_sync_threshold', 50),
    syncBatchLimit: setting('sync_batch_limit', 200),
    syncThreshold: CHECKPOINT_THRESHOLD,
    rotationThresholds: {
      claude: rotationThreshold(config.new_session_threshold, 70),
      codex: rotationThreshold(config.codex_new_session_threshold, 75),
    },
  };
}
