export const HOT_TTL_MIN_MINUTES = 5;
export const HOT_TTL_MAX_MINUTES = 1440;
const ENV_KEY = 'ZYLOS_SESSION_HOT_TTL_SECONDS';

function positiveInteger(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return undefined;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Preserve existing environment/config parsing; limits apply only to new writes. */
export function resolveSessionHotTtl(config = {}, env = process.env) {
  const environmentValue = positiveInteger(env[ENV_KEY]);
  const configuredValue = positiveInteger(config.session_hot_ttl_seconds);
  const seconds = environmentValue ?? configuredValue ?? 1800;
  const environmentSet = env[ENV_KEY] !== undefined;
  const mode = config.session_mode === undefined ? 'single'
    : ['single', 'multi'].includes(config.session_mode) ? config.session_mode : null;
  return {
    seconds,
    minutes: seconds / 60,
    source: environmentValue !== undefined ? 'environment' : configuredValue !== undefined ? 'config' : 'default',
    read_only: environmentSet || mode !== 'multi',
    environment_set: environmentSet,
    environment_valid: environmentValue !== undefined,
    min_minutes: HOT_TTL_MIN_MINUTES,
    max_minutes: HOT_TTL_MAX_MINUTES,
    mode,
  };
}
