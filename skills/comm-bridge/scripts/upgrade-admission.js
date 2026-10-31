import fs from 'node:fs';
import path from 'node:path';

export const MINIMUM_UPGRADE_VERSION = '0.9.3';
export const UPGRADE_BRIDGE_COMMAND = 'zylos upgrade --self --branch release/0.9';

export function assertSupportedUpgradeVersion(version) {
  const match = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  const supported = match && (Number(match[1]) > 0 || Number(match[2]) > 9 ||
    Number(match[2]) === 9 && (Number(match[3]) > 3 || Number(match[3]) === 3 && !match[4]));
  if (!supported) throw Object.assign(new Error(
    `Core ${version || '(unknown)'} cannot upgrade directly. Run ${UPGRADE_BRIDGE_COMMAND} to reach Core 0.9.3 first.`),
  { code: 'UPGRADE_SOURCE_TOO_OLD', persisted: [] });
  return version;
}

// Old Core probes load the downloaded schema before stopping any services.
export function rejectLegacySchemaProbe(argv = process.argv) {
  if (!argv[1] || path.basename(argv[1]) !== 'core-db-backup-worker.js') return;
  let input;
  try { input = JSON.parse(argv[2]); } catch { return; }
  if (input?.action !== 'version-probe') return;
  const root = path.resolve(path.dirname(argv[1]), '..', '..');
  if (fs.realpathSync(root) === fs.realpathSync(path.resolve(import.meta.dirname, '../../..'))) return;
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assertSupportedUpgradeVersion(version);
}
