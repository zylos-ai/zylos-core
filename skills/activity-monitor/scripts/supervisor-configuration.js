function positiveInteger(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return undefined;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Resolve lifecycle settings; invalid optional values fall through to the next
 * source. Callers retain startup settings and refresh the alert count per request.
 * Mode, model thresholds and launch configuration refresh separately. */
export function parseSupervisorConfiguration(config, env = process.env) {
  const setting = (key, fallback) => positiveInteger(env[`ZYLOS_${key.toUpperCase()}`])
    ?? positiveInteger(config[key]) ?? fallback;
  return {
    hotTtlSeconds: setting('session_hot_ttl_seconds', 3300),
    reclaimDeferAlertCount: setting('session_reclaim_defer_alert_count', 4),
    evictMinIdleSeconds: setting('session_evict_min_idle_seconds', 300),
  };
}
