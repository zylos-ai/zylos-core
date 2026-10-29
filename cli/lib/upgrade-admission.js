import path from 'node:path';
import { assertSupportedUpgradeVersion } from '../../skills/comm-bridge/scripts/upgrade-admission.js';

export { assertSupportedUpgradeVersion, assertSupportedUpgradeVersion as assertSupportedUpgradeSource, MINIMUM_UPGRADE_VERSION, UPGRADE_BRIDGE_COMMAND } from '../../skills/comm-bridge/scripts/upgrade-admission.js';

const upgradeErrorCodes = new Set([
  'ZYLOS_NOT_INITIALIZED', 'INVALID_ARGS', 'UPGRADE_RECOVERY_REQUIRED',
  'DASHBOARD_STILL_INSTALLED', 'INVALID_CORE_DEPENDENCIES', 'DASHBOARD_TAKEOVER_INVALID',
  'RUNTIME_PREPARATION_INCOMPLETE', 'UPGRADE_FAILED', 'SCHEMA_TOO_NEW', 'SCHEMA_MIGRATION_FAILED',
  'SETTINGS_UNREADABLE', 'UPGRADE_SOURCE_TOO_OLD', 'INVALID_UPGRADE_HANDOFF', 'MANUAL_RECOVERY_REQUIRED',
  'SNAPSHOT_FAILED', 'NOT_RESUMABLE', 'CUTOFF_UNTRUSTED', 'CUTOFF_WRITE_UNCERTAIN', 'FINALIZE_INCOMPLETE',
  'CONFIG_LOCK_TIMEOUT', 'CONFIG_UNREADABLE', 'CONFIG_WRITE_FAILED', 'CONFIG_KEY_RESERVED',
  'LOCK_TIMEOUT', 'DB_BUSY',
  'material_corrupt', 'runtime_config_conflict', 'codex_config_unparseable', 'codex_config_reconcile_failed',
]);

export function upgradeFailureCode(error) {
  return upgradeErrorCodes.has(error?.code) ? error.code : 'UPGRADE_FAILED';
}

export function upgradeFailureMessage(error) {
  return String(error?.message || error).split('\n')[0]
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
