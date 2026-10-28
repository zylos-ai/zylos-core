#!/usr/bin/env node

// This graph must stay dependency-free until npm has installed the target.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateUpgradeHandoff } from './upgrade-admission.js';
import { probeCoreDbVersions, preflightCoreDbUpgrade, rehearseCoreDbUpgrade } from './core-db-backup.js';
import { beginUpgrade, saveProtectedCode, prepareProtectedInstall, markInstallationIntent, recovery, maintenance, maintenanceFor } from './upgrade-protection.js';
import { saveOriginalPackage } from './upgrade-package.js';

export function resolveUpgradeNpmCli() {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const file = fs.realpathSync(path.join(directory, 'npm'));
      if (path.basename(file) === 'npm-cli.js' && fs.statSync(file).isFile()) {
        fs.accessSync(file, fs.constants.R_OK);
        return file;
      }
    } catch {}
  }
  throw new Error('trusted npm-cli.js entry is unavailable');
}

export function inspectUpgradeSource(input, deps = {}) {
  validateUpgradeHandoff(input);
  const tempDir = fs.realpathSync(input.tempDir);
  const coreDir = fs.realpathSync(input.installedRoot);
  const zylosDir = fs.realpathSync(input.zylosDir);
  const source = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8'));
  const target = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8'));
  if (source.version !== input.fromVersion) throw Object.assign(new Error('Installed source version does not match upgrade handoff.'), {code:'INVALID_UPGRADE_HANDOFF'});
  if (source.name !== target.name || typeof target.version !== 'string') throw Object.assign(new Error('Downloaded target package identity does not match installed Core.'), {code:'INVALID_UPGRADE_HANDOFF'});
  const skillsDir = path.join(zylosDir, '.claude', 'skills');
  const registry = path.join(zylosDir, '.zylos', 'components.json');
  if (fs.existsSync(registry)) {
    const installed = JSON.parse(fs.readFileSync(registry, 'utf8'));
    if (Object.hasOwn(installed.components || installed, 'dashboard')) throw Object.assign(new Error('Uninstall standalone Dashboard before upgrading.'), {
      code:'DASHBOARD_STILL_INSTALLED', next:'Run zylos uninstall dashboard --yes while retaining its data.'
    });
  }
  const firstTakeover = input.fromVersion === '0.9.3';
  const options = {driverRoot:skillsDir, firstTakeover};
  const versions = (deps.probe ?? probeCoreDbVersions)(zylosDir, tempDir, options);
  if (!versions || !Array.isArray(versions.databases) || versions.databases.length !== (firstTakeover ? 3 : 4) || typeof versions.needsMigration !== 'boolean') throw new Error('Invalid database version probe result');
  (deps.preflight ?? preflightCoreDbUpgrade)(zylosDir, {firstTakeover});
  if (versions.needsMigration) (deps.rehearse ?? rehearseCoreDbUpgrade)(zylosDir, tempDir, options);
  return {coreDir, tempDir, zylosDir, skillsDir, from:source.version, to:target.version, newVersion:target.version,
    firstTakeover, snapshotFormatVersion:2, databaseMode:versions.needsMigration ? 'migrate' : 'unchanged',
    databaseVersions:versions, mode:'merge', steps:[], servicesWereRunning:[], servicesStopped:[],
    mergeConflicts:[], mergedFiles:[], maintenance:deps.maintenance ?? maintenance};
}

export function installUpgradeTarget(ctx, deps = {}) {
  const m = maintenanceFor(ctx);
  const run = deps.runInstaller ?? ((context, options) => m.runInstaller(context.transactionDir, context.journal, options));
  const output = run(ctx, {stage:'pack-target', npmCli:ctx.protectedNpmCli,
    args:['pack', '--ignore-scripts', '--json', '--pack-destination', ctx.tempDir], cwd:ctx.tempDir});
  const packed = JSON.parse(output);
  const name = packed?.length === 1 && packed[0]?.filename;
  if (typeof name !== 'string' || path.basename(name) !== name || !name.endsWith('.tgz')) throw new Error('Invalid target npm pack result');
  // Packing cannot replace the installed package. Open installation intent only
  // once the exact target archive is available for npm to consume.
  (deps.markInstallationIntent ?? markInstallationIntent)(ctx);
  run(ctx, {stage:'install', npmCli:ctx.protectedNpmCli,
    args:['install', '-g', path.join(ctx.tempDir, name)], cwd:ctx.tempDir});
}

async function finalizeTarget(ctx) {
  const metadata = JSON.parse(fs.readFileSync(path.join(ctx.coreDir, 'package.json'), 'utf8'));
  if (metadata.version !== ctx.to) throw new Error('Installed target version does not match the downloaded package.');
  const module = await import(pathToFileURL(path.join(ctx.coreDir, 'cli/lib/self-upgrade.js')).href);
  return module.runSelfUpgradeFinalize({schemaVersion:2, preInstallProtection:true,
    tempDir:ctx.tempDir, packageRoot:ctx.coreDir, zylosDir:ctx.zylosDir, from:ctx.from, to:ctx.to,
    newVersion:ctx.to, mode:ctx.mode, firstTakeover:ctx.firstTakeover, databaseMode:ctx.databaseMode,
    transactionDir:ctx.transactionDir, transactionId:ctx.transactionId, coreManifest:ctx.coreManifest,
    dbBackupDir:ctx.dbBackupDir, dbManifest:ctx.dbManifest, backupDir:ctx.backupDir,
    servicesWereRunning:ctx.servicesWereRunning, protectedNpmCli:ctx.protectedNpmCli}, {maintenance:maintenanceFor(ctx), zylosDir:ctx.zylosDir});
}

export async function runUpgradeEntry(input, deps = {}) {
  let ctx;
  try {
    validateUpgradeHandoff(input);
    const m = deps.maintenance ?? maintenance;
    const prior = m.discover(input.zylosDir);
    if (prior.candidates.length || prior.diagnostics.length || prior.marker) {
      throw Object.assign(new Error('Unfinished upgrade requires recovery before another installation.'), {code:'UPGRADE_RECOVERY_REQUIRED', recovery_required:true});
    }
    ctx = (deps.inspect ?? inspectUpgradeSource)(input, deps);
    ctx.protectedNpmCli = (deps.resolveNpm ?? resolveUpgradeNpmCli)();
    (deps.begin ?? beginUpgrade)(ctx, {zylosDir:ctx.zylosDir, skillsDir:ctx.skillsDir});
    (deps.savePackage ?? saveOriginalPackage)(ctx);
    (deps.saveCode ?? saveProtectedCode)(ctx);
    (deps.prepare ?? prepareProtectedInstall)(ctx);
    (deps.install ?? installUpgradeTarget)(ctx);
    const result = await (deps.finalize ?? finalizeTarget)(ctx);
    if (result.success === false) {
      const rollback = (deps.recover ?? recovery)(ctx);
      return {...result, rollback:{...rollback, performed:rollback.attempted}, recovery_required:rollback.recovery_required};
    }
    ctx.releaseControl?.();
    ctx.releaseControl = null;
    return result;
  } catch (error) {
    const rollback = ctx?.transactionDir ? (deps.recover ?? recovery)(ctx) : {attempted:false, completed:false, performed:false};
    return {action:'self_upgrade', success:false, code:error.code || 'UPGRADE_FAILED', error:error.message,
      next:error.next, persisted:error.persisted || [], preInstallProtection:!!ctx?.preInstallProtection,
      transactionDir:ctx?.transactionDir, rollback:{...rollback, performed:!!rollback.attempted},
      recovery_required:rollback.recovery_required || error.recovery_required || false};
  }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  let result;
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    validateUpgradeHandoff(input);
    if (fs.realpathSync(input.tempDir) !== fs.realpathSync(path.join(import.meta.dirname, '../..'))) throw Object.assign(new Error('Upgrade entry must run from the downloaded target package.'), {code:'INVALID_UPGRADE_HANDOFF'});
    process.env.ZYLOS_DIR = input.zylosDir;
    result = await runUpgradeEntry(input);
  } catch (error) {
    result = {success:false, code:error.code || 'INVALID_UPGRADE_HANDOFF', error:error.message, persisted:[]};
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.success ? 0 : 1;
}
