import path from 'node:path';
import { assertSupportedUpgradeVersion } from '../../skills/comm-bridge/scripts/upgrade-admission.js';

export { assertSupportedUpgradeVersion, assertSupportedUpgradeVersion as assertSupportedUpgradeSource, MINIMUM_UPGRADE_VERSION, UPGRADE_BRIDGE_COMMAND } from '../../skills/comm-bridge/scripts/upgrade-admission.js';

export function upgradeFailureCode(error) {
  return typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'UPGRADE_FAILED';
}

export function upgradeFailureMessage(error) {
  const lines = String(error?.message || error).split(/\r?\n/).map(line => line.trim());
  const useful = lines.filter(line => line && !/^(?:npm\s+(?:warn(?:ing)?|notice)\b|(?:warn(?:ing)?|deprecated)\b|at\s)/i.test(line));
  const npmError = useful.find(line => /^npm\s+(?:error|err!)\s+/i.test(line)
    && !/^npm\s+(?:error|err!)\s+(?:code|path|errno|syscall|command|stack|at|a complete log|log files?)\b/i.test(line));
  const message = npmError || useful.find(line => !/^npm\s+(?:error|err!)(?:\s|$)/i.test(line));
  return (message || 'Core upgrade failed. Check the npm debug log for details.')
    .replace(/(^|[\s('"`])(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)[^\s'"`,;:)]+/g, '$1<path>');
}

export function validateUpgradeHandoff(input) {
  const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_UPGRADE_HANDOFF', persisted: [] }); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1) invalid('Upgrade handoff requires schemaVersion 1.');
  assertSupportedUpgradeVersion(input.fromVersion);
  for (const key of ['tempDir', 'installedRoot', 'zylosDir']) {
    if (typeof input[key] !== 'string' || !path.isAbsolute(input[key]) || input[key].includes('\0')) invalid('Upgrade handoff requires an absolute ' + key + '.');
  }
  if (input.skillsDir !== undefined && input.skillsDir !== path.join(input.zylosDir, '.claude/skills')) invalid('Upgrade handoff skillsDir must belong to zylosDir.');
  return input;
}
