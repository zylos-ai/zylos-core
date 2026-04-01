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
  const key = runtimeId === 'codex' ? 'codex_heartbeat_enabled' : 'heartbeat_enabled';
  return parseBooleanish(config[key], false);
}
