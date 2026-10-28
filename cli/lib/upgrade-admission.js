import path from 'node:path';
import { assertSupportedUpgradeVersion } from '../../skills/comm-bridge/scripts/upgrade-admission.js';

export { assertSupportedUpgradeVersion, assertSupportedUpgradeVersion as assertSupportedUpgradeSource, MINIMUM_UPGRADE_VERSION, UPGRADE_BRIDGE_COMMAND } from '../../skills/comm-bridge/scripts/upgrade-admission.js';

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
