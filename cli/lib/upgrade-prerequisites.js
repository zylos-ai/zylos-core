import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assertDashboardUninstalled, inspectFirstDashboardTakeover, inspectCoreDbSnapshotDestination } from './core-db-backup.js';
import { assertSupportedUpgradeSource, UPGRADE_BRIDGE_COMMAND, upgradeFailureCode, upgradeFailureMessage } from './upgrade-admission.js';
import { recoveryNext } from './upgrade-discovery.js';

const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');

/** Inspect only dependency paths declared by the installed and selected target packages. */
export function inspectCoreSkillDependencies(installedRoot, targetRoot, skillsDir) {
  const names = new Set();
  for (const root of [installedRoot, targetRoot]) {
    try {
      for (const entry of fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of names) {
    try {
      if (!fs.lstatSync(path.join(skillsDir, name, 'node_modules')).isDirectory()) {
        throw Object.assign(Error('Installed core skill node_modules must be a real directory or absent: ' + name), { code: 'INVALID_CORE_DEPENDENCIES' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Advisory filesystem checks only: no recovery, database opens, probes or migrations. */
export function collectUpgradePrerequisites({ zylosDir, installedRoot, targetRoot, fromVersion }) {
  const prerequisites = [];
  const inspect = (read, next, message, code) => {
    try { read(); }
    catch (error) {
      prerequisites.push({ code: code || upgradeFailureCode(error), message: message || upgradeFailureMessage(error), next: error.next || next });
    }
  };
  if (!fs.existsSync(zylosDir)) {
    return [{ code: 'ZYLOS_NOT_INITIALIZED', message: 'Zylos deployment directory is missing. Initialize this deployment before upgrading.', next: 'Run zylos init before retrying the upgrade.' }];
  }
  inspect(() => {
    const found = maintenance.discover(zylosDir);
    if (found.candidates.length || found.diagnostics.length || found.marker) {
      throw Object.assign(Error('Unfinished upgrade requires recovery before another installation.'), {
        code: 'UPGRADE_RECOVERY_REQUIRED', next: recoveryNext(found, maintenance, 'Run zylos recovery status, then zylos recovery resume before upgrading.'),
      });
    }
  }, 'Run zylos recovery status before retrying the upgrade.');

  // Explicit-version checks do not download a target. Do not infer that target's
  // admission policy from its version number, or apply these rules to old targets.
  if (!targetRoot) return prerequisites;
  let target;
  try {
    target = JSON.parse(fs.readFileSync(path.join(targetRoot, 'package.json'), 'utf8'));
    if (target.name !== 'zylos') throw Error('Unexpected target package');
  } catch (error) {
    inspect(() => { throw error; }, 'Retry the check with a readable target package.', 'Could not inspect the downloaded target package.', 'UPGRADE_FAILED');
    return prerequisites;
  }
  try {
    if (!fs.statSync(path.join(targetRoot, 'cli/lib/upgrade-entry.js')).isFile()) throw Error('Invalid target entry');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return prerequisites;
    inspect(() => { throw error; }, 'Retry the check with a readable target package.', 'Could not inspect the downloaded upgrade entry.', 'UPGRADE_FAILED');
    return prerequisites;
  }
  inspect(() => assertSupportedUpgradeSource(fromVersion), 'Run ' + UPGRADE_BRIDGE_COMMAND + ' before retrying the upgrade.');
  inspect(() => {
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')); }
    catch { throw Object.assign(Error('Installed Core package metadata is unavailable.'), { code: 'UPGRADE_FAILED' }); }
    maintenance.validateSupportedGlobalLayout(installedRoot, metadata);
  }, 'Use a supported global npm installation of zylos before retrying the upgrade.');
  const skillsDir = path.join(zylosDir, '.claude/skills');
  inspect(() => inspectCoreSkillDependencies(installedRoot, targetRoot, skillsDir), 'Repair the installed core skill dependency directories before retrying the upgrade.');
  inspect(() => inspectCoreDbSnapshotDestination(zylosDir), 'Repair the backup destination directories before retrying the upgrade.');
  let bundledDashboard = false;
  inspect(() => {
    try {
      if (!fs.statSync(path.join(targetRoot, 'skills/dashboard')).isDirectory()) throw Error('Invalid target Dashboard directory');
      bundledDashboard = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, 'Retry the check with a readable target package.', 'Could not inspect the target Dashboard directory.', 'UPGRADE_FAILED');
  if (bundledDashboard) {
    inspect(() => {
      try { assertDashboardUninstalled(zylosDir); }
      catch (error) {
        if (error.code === 'DASHBOARD_STILL_INSTALLED') throw error;
        throw Object.assign(Error('Could not inspect the installed component registry.'), { code: 'UPGRADE_FAILED' });
      }
    }, 'Repair the component registry before retrying the upgrade.');
    const dashboard = prerequisites.find(item => item.code === 'DASHBOARD_STILL_INSTALLED');
    if (dashboard) dashboard.message = 'Zylos 1.0 includes Dashboard. Uninstall the standalone dashboard first; its data is retained.';
    inspect(() => inspectFirstDashboardTakeover(installedRoot), 'Repair the installed Dashboard directory before retrying the upgrade.');
  }
  return prerequisites;
}
