function parseBooleanish(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  }
  return fallback;
}

export function isRuntimeHeartbeatEnabled({ runtimeId, config = {} } = {}) {
  if (runtimeId !== 'codex') return true;
  return parseBooleanish(config.codex_heartbeat_enabled, false);
}
