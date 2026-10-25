/** Validate an observed snapshot without invoking the runtime executable. */
export function validLaunchConfigSnapshot(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !['claude', 'codex'].includes(config.runtime)) return false;
  if (config.mode === 'default') return Object.keys(config).every(key => ['runtime', 'mode'].includes(key));
  if (config.mode !== 'override' || Object.keys(config).some(key => !['runtime', 'mode', 'model', 'effort'].includes(key))) return false;
  if (![config.model, config.effort].every(value => typeof value === 'string' && value.trim() && !value.includes('\0'))) return false;
  const efforts = config.runtime === 'claude' ? ['low', 'medium', 'high', 'max'] : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  return efforts.includes(config.effort);
}
