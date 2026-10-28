import { assertSupportedUpgradeVersion } from '../cli/lib/upgrade-admission.js';

export function checkInstallAdmission(env = process.env) {
  if (env.ZYLOS_SKIP_POSTINSTALL !== '1') return;
  try { assertSupportedUpgradeVersion(env.ZYLOS_UPGRADE_FROM_VERSION); }
  catch (error) {
    error.message += ' If an older upgrade has already stopped services (especially Core 0.9.0 backup-only mode), preserve its backup and verify the previous Core package is complete and usable before manually restarting the previously running services. Do not assume npm restored the previous package.';
    throw error;
  }
}

checkInstallAdmission();
