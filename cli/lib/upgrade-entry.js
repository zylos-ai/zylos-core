#!/usr/bin/env node

// This dependency graph must use only Node builtins before target installation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateUpgradeHandoff, upgradeFailureCode, upgradeFailureMessage } from './upgrade-admission.js';
import { cleanupCoreDbRehearsals, probeCoreDbVersions, preflightCoreDbUpgrade, rehearseCoreDbUpgrade } from './core-db-backup.js';
import { beginUpgrade, saveProtectedCode, prepareProtectedInstall, markInstallationIntent, recovery, maintenance, maintenanceFor, resolveProtectedNpmCli, runProtectedInstaller } from './upgrade-protection.js';
import { saveOriginalPackage } from './upgrade-package.js';

export function inspectUpgradeSource(input, deps = {}) {
  validateUpgradeHandoff(input);
  const m = deps.maintenance ?? maintenance;
  const installedRoot = path.resolve(input.installedRoot);
  if (input.installedRoot !== installedRoot) throw Object.assign(Error('Installed Core requires its normalized global package path.'), {code:'UNSUPPORTED_INSTALL_LAYOUT'});
  const source = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  m.validateSupportedGlobalLayout(installedRoot, source);
  const tempDir = fs.realpathSync(input.tempDir);
  const target = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8'));
  if (source.version !== input.fromVersion || source.name !== 'zylos' || target.name !== source.name || typeof target.version !== 'string') throw Object.assign(Error('Installed source or downloaded target does not match upgrade handoff.'), {code:'INVALID_UPGRADE_HANDOFF'});
  const zylosDir = fs.realpathSync(input.zylosDir), skillsDir = path.join(zylosDir, '.claude', 'skills');
  // Full dependency preservation cannot safely follow a linked node_modules root.
  const names = new Set([installedRoot, tempDir].flatMap(root => fs.readdirSync(path.join(root, 'skills'), {withFileTypes:true}).filter(e => e.isDirectory()).map(e => e.name)));
  for (const name of names) {
    try { if (!fs.lstatSync(path.join(skillsDir, name, 'node_modules')).isDirectory()) throw Error('Core skill dependencies require a real directory: ' + name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!m.platformSupported()) throw Error('Protected target installation is unavailable on this platform.');
  m.preflightExternalTools();
  const rehearsalCleanup = (deps.cleanup ?? cleanupCoreDbRehearsals)(zylosDir);
  const options = {driverRoot:skillsDir};
  const versions = (deps.probe ?? probeCoreDbVersions)(zylosDir, tempDir, options);
  if (!versions || typeof versions.needsMigration !== 'boolean' || !Array.isArray(versions.databases) || versions.databases.length !== 3) throw Error('Invalid database version probe result');
  (deps.preflight ?? preflightCoreDbUpgrade)(zylosDir, options);
  if (versions.needsMigration) (deps.rehearse ?? rehearseCoreDbUpgrade)(zylosDir, tempDir, options);
  return {targetOwned:true, maintenance:m, coreDir:installedRoot, tempDir, zylosDir, skillsDir,
    from:source.version, to:target.version, newVersion:target.version, mode:'merge',
    databaseMode:versions.needsMigration ? 'migrate' : 'unchanged', databaseVersions:versions,
    rehearsalCleanup, steps:[], servicesWereRunning:[], servicesStopped:[], mergeConflicts:[], mergedFiles:[]};
}

export function validateUpgradeNpmPrefix(ctx) {
  const result = spawnSync(process.execPath, [ctx.protectedNpmCli, 'root', '-g'], {cwd:ctx.tempDir,encoding:'utf8',timeout:30000});
  if (result.error || result.status !== 0 || path.join(String(result.stdout || '').trim(), 'zylos') !== ctx.coreDir) throw Object.assign(Error('npm global prefix does not match the installed Core package.'), {code:'UNSUPPORTED_INSTALL_LAYOUT'});
}

export function installUpgradeTarget(ctx, deps = {}) {
  const run = deps.runInstaller ?? runProtectedInstaller;
  const output = run(ctx, {stage:'pack', npmCli:ctx.protectedNpmCli,
    args:['pack', '--ignore-scripts', '--json', '--pack-destination', ctx.tempDir], cwd:ctx.tempDir});
  const packed = JSON.parse(output);
  const name = packed?.length === 1 && packed[0]?.filename;
  if (typeof name !== 'string' || path.basename(name) !== name || !name.endsWith('.tgz')) throw Error('Invalid target npm pack result');
  (deps.markInstallationIntent ?? markInstallationIntent)(ctx);
  run(ctx, {stage:'install', npmCli:ctx.protectedNpmCli, args:['install', '-g', path.join(ctx.tempDir, name)], cwd:ctx.tempDir});
}

async function finalizeInstalledTarget(ctx) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ctx.coreDir, 'package.json'), 'utf8'));
  if (pkg.name !== 'zylos' || pkg.version !== ctx.to) throw Error('Installed target does not match downloaded package identity.');
  const target = await import(pathToFileURL(path.join(ctx.coreDir, 'cli/lib/self-upgrade.js')).href);
  return target.runInstalledFinalizer(ctx);
}

export async function runUpgradeEntry(input, deps = {}) {
  let ctx;
  try {
    validateUpgradeHandoff(input);
    const m = deps.maintenance ?? maintenance;
    const prior = m.discover(input.zylosDir);
    if (prior.candidates.length || prior.diagnostics.length || prior.marker) throw Object.assign(Error('An unfinished upgrade requires recovery before installation.'), {code:'UPGRADE_RECOVERY_REQUIRED', recovery_required:true});
    ctx = (deps.inspect ?? inspectUpgradeSource)(input, deps);
    ctx.protectedNpmCli = (deps.resolveNpm ?? resolveProtectedNpmCli)();
    (deps.validateNpm ?? validateUpgradeNpmPrefix)(ctx);
    (deps.begin ?? beginUpgrade)(ctx, {zylosDir:ctx.zylosDir, skillsDir:ctx.skillsDir});
    (deps.savePackage ?? saveOriginalPackage)(ctx);
    (deps.saveCode ?? saveProtectedCode)(ctx);
    (deps.prepare ?? prepareProtectedInstall)(ctx);
    (deps.install ?? installUpgradeTarget)(ctx);
    const result = await (deps.finalize ?? finalizeInstalledTarget)(ctx);
    if (result.success === false) {
      const rollback = (deps.recover ?? recovery)(ctx);
      return {...result, rollback:{...rollback, performed:!!rollback.attempted}, recovery_required:!!rollback.recovery_required};
    }
    ctx.releaseControl?.();
    ctx.releaseControl = null;
    return result;
  } catch (error) {
    const rollback = ctx?.transactionDir ? (deps.recover ?? recovery)(ctx) : {attempted:false, completed:false};
    return {action:'self_upgrade',success:false,code:upgradeFailureCode(error),error:upgradeFailureMessage(error),persisted:[],
      transactionDir:ctx?.transactionDir, rollback:{...rollback,performed:!!rollback.attempted},
      recovery_required:!!(rollback.recovery_required || error.recovery_required)};
  }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  let result;
  try {
    const input = validateUpgradeHandoff(JSON.parse(fs.readFileSync(0, 'utf8')));
    if (fs.realpathSync(input.tempDir) !== fs.realpathSync(path.join(import.meta.dirname, '../..'))) throw Object.assign(Error('Upgrade entry must execute from the downloaded target package.'), {code:'INVALID_UPGRADE_HANDOFF'});
    process.env.ZYLOS_DIR = input.zylosDir;
    result = await runUpgradeEntry(input);
  } catch (error) {
    result = {success:false,code:error instanceof SyntaxError ? 'INVALID_UPGRADE_HANDOFF' : upgradeFailureCode(error),error:upgradeFailureMessage(error),persisted:[]};
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.success ? 0 : 1;
}
