#!/usr/bin/env node

// This graph must stay dependency-free until npm has installed the target.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateUpgradeHandoff, upgradeFailureCode, upgradeFailureMessage } from './upgrade-admission.js';
import { probeCoreDbVersions, preflightCoreDbUpgrade, rehearseCoreDbUpgrade, inspectFirstDashboardTakeover, inspectCoreManagesDashboardDb, assertDashboardUninstalled } from './core-db-backup.js';
import { beginUpgrade, saveProtectedCode, prepareProtectedInstall, markInstallationIntent, recovery, maintenance, maintenanceFor } from './upgrade-protection.js';
import { saveOriginalPackage } from './upgrade-package.js';
import { recoveryNext, runningUpgradeNotice } from './upgrade-discovery.js';

// Keep local presentation context out of the legacy JSON result protocol.
const humanResults = new WeakMap();

class UpgradeNpmPrefixError extends Error {
  code = 'UNSUPPORTED_INSTALL_LAYOUT';
}

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

export function validateUpgradeNpmPrefix(ctx) {
  const result = spawnSync(process.execPath, [ctx.protectedNpmCli, 'root', '-g'], {cwd:ctx.tempDir, encoding:'utf8', timeout:30000});
  const root = result.stdout?.trim();
  const target = root && path.isAbsolute(root) ? path.join(root, 'zylos') : null;
  if (!result.error && result.status === 0 && target) {
    try {
      if (fs.realpathSync(target) === fs.realpathSync(ctx.coreDir)) return;
    } catch {}
  }
  const reason = result.error?.code === 'ETIMEDOUT' ? 'npm timed out after 30 seconds'
    : result.error ? `npm execution failed (${result.error.code || 'unknown error'})`
    : result.status !== 0 ? `npm exited with code ${result.status}`
    : 'npm returned an empty or non-absolute global directory';
  const message = result.error || result.status !== 0 || !target
    ? `Cannot determine where npm would install zylos (currently at ${ctx.coreDir}): ${reason}, so the upgrade was stopped and nothing was changed.`
    : `npm would install zylos at ${target}, but zylos is currently at ${ctx.coreDir}; the directories do not match, so the upgrade was stopped and nothing was changed. Check npm root -g: remove or align the prefix setting in ~/.npmrc or the npm_config_prefix environment variable, then run the upgrade again.`;
  throw new UpgradeNpmPrefixError(message);
}

export function inspectUpgradeSource(input, deps = {}) {
  validateUpgradeHandoff(input);
  const packageRoot = (directory, label) => {
    try {
      const root=fs.realpathSync(directory);
      return {root, metadata:JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))};
    } catch(cause) {
      throw Object.assign(Error(`${label} package metadata is unavailable.`, {cause}), {code:'UPGRADE_FAILED'});
    }
  };
  let installed;
  try {
    const root=path.resolve(input.installedRoot);
    if (input.installedRoot !== root) throw Object.assign(Error('Installed Core must use its normalized absolute global package path.'), {code:'UNSUPPORTED_INSTALL_LAYOUT'});
    const metadata=JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    (deps.maintenance ?? maintenance).validateSupportedGlobalLayout(root, metadata);
    installed={root,metadata};
  } catch(cause) {
    if (cause?.code === 'UNSUPPORTED_INSTALL_LAYOUT') throw cause;
    throw Object.assign(Error('Installed Core package metadata is unavailable.', {cause}), {code:'UPGRADE_FAILED'});
  }
  const downloaded=packageRoot(input.tempDir, 'Downloaded target');
  const tempDir = downloaded.root;
  const coreDir = installed.root;
  const zylosDir = fs.realpathSync(input.zylosDir);
  const source = installed.metadata;
  const target = downloaded.metadata;
  if (source.version !== input.fromVersion) throw Object.assign(new Error('Installed source version does not match upgrade handoff.'), {code:'INVALID_UPGRADE_HANDOFF'});
  if (source.name !== target.name || typeof target.version !== 'string') throw Object.assign(new Error('Downloaded target package identity does not match installed Core.'), {code:'INVALID_UPGRADE_HANDOFF'});
  const skillsDir = path.join(zylosDir, '.claude', 'skills');
  assertDashboardUninstalled(zylosDir);
  const declaredSkills=new Set();
  for(const packageRoot of [coreDir,tempDir]) {
    const directory=path.join(packageRoot,'skills');
    try {for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isDirectory())declaredSkills.add(entry.name);}
    catch(error) {if(error.code!=='ENOENT')throw error;}
  }
  for(const name of declaredSkills) {
    try {
      const dependencyPath=path.join(skillsDir,name,'node_modules');
      const stat=fs.lstatSync(dependencyPath);
      if(!stat.isDirectory())throw Object.assign(Error('Installed core skill node_modules must be a real directory or absent: '+name),{code:'INVALID_CORE_DEPENDENCIES',dependencyPath});
    } catch(error) {if(error.code!=='ENOENT')throw error;}
  }
  const firstTakeover = inspectFirstDashboardTakeover(coreDir);
  const dashboardOwnerManaged = inspectCoreManagesDashboardDb(zylosDir,coreDir,{driverRoot:skillsDir});
  const options = {driverRoot:skillsDir, schemaRoot:path.join(tempDir,'skills'), dashboardOwnerManaged};
  const versions = (deps.probe ?? probeCoreDbVersions)(zylosDir, tempDir, options);
  if (!versions || !Array.isArray(versions.databases) || versions.databases.length !== (dashboardOwnerManaged ? 3 : 2) || typeof versions.needsMigration !== 'boolean') throw new Error('Invalid database version probe result');
  (deps.preflight ?? preflightCoreDbUpgrade)(zylosDir, options);
  if (versions.needsMigration) (deps.rehearse ?? rehearseCoreDbUpgrade)(zylosDir, tempDir, options);
  return {coreDir, tempDir, zylosDir, skillsDir, from:source.version, to:target.version, newVersion:target.version,
    firstTakeover, dashboardOwnerManaged, snapshotFormatVersion:3, databaseMode:versions.needsMigration ? 'migrate' : 'unchanged',
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
  return module.runSelfUpgradeFinalize({
    tempDir:ctx.tempDir, packageRoot:ctx.coreDir, zylosDir:ctx.zylosDir, from:ctx.from, to:ctx.to,
    transactionDir:ctx.transactionDir, transactionId:ctx.transactionId, protectedNpmCli:ctx.protectedNpmCli},
    {maintenance:maintenanceFor(ctx), zylosDir:ctx.zylosDir});
}

export async function runUpgradeEntry(input, deps = {}) {
  let ctx;
  let running;
  const present = (result, extra = {}) => {
    humanResults.set(result, {from:input?.fromVersion, running, ...extra});
    return result;
  };
  try {
    validateUpgradeHandoff(input);
    if (!fs.existsSync(input.zylosDir)) throw Object.assign(Error('Zylos deployment directory is missing. Initialize this deployment before upgrading.'), {code:'ZYLOS_NOT_INITIALIZED'});
    const m = deps.maintenance ?? maintenance;
    const prior = m.discover(input.zylosDir);
    if (prior.candidates.length || prior.diagnostics.length || prior.marker) {
      running = runningUpgradeNotice(input.zylosDir, {maintenance:m, found:prior});
      throw Object.assign(new Error('Unfinished upgrade requires recovery before another installation.'), {code:'UPGRADE_RECOVERY_REQUIRED', recovery_required:true,
        next:recoveryNext(prior, m, 'Run zylos recovery status, then zylos recovery resume before upgrading.')});
    }
    ctx = (deps.inspect ?? inspectUpgradeSource)(input, deps);
    ctx.protectedNpmCli = (deps.resolveNpm ?? resolveUpgradeNpmCli)();
    (deps.validateNpmPrefix ?? validateUpgradeNpmPrefix)(ctx);
    (deps.begin ?? beginUpgrade)(ctx, {zylosDir:ctx.zylosDir, skillsDir:ctx.skillsDir});
    (deps.savePackage ?? saveOriginalPackage)(ctx);
    (deps.saveCode ?? saveProtectedCode)(ctx);
    (deps.prepare ?? prepareProtectedInstall)(ctx);
    (deps.install ?? installUpgradeTarget)(ctx);
    const result = await (deps.finalize ?? finalizeTarget)(ctx);
    if (result.success === false) {
      const rollback = (deps.recover ?? recovery)(ctx);
      return present({...result, code:upgradeFailureCode(result), error:upgradeFailureMessage({message:result.error || 'Upgrade finalization failed.'}),
        rollback:{...rollback, performed:rollback.attempted}, recovery_required:rollback.recovery_required});
    }
    ctx.releaseControl?.();
    ctx.releaseControl = null;
    return result;
  } catch (error) {
    const rollback = ctx?.transactionDir ? (deps.recover ?? recovery)(ctx) : {attempted:false, completed:false, performed:false};
    return present({action:'self_upgrade', success:false, code:upgradeFailureCode(error),
      error:error instanceof UpgradeNpmPrefixError ? error.message : upgradeFailureMessage(error),
      next:error.next, persisted:error.persisted || [], upgradeProtected:!!ctx?.upgradeProtected,
      transactionDir:ctx?.transactionDir, rollback:{...rollback, performed:!!rollback.attempted},
      recovery_required:rollback.recovery_required || error.recovery_required || false}, {dependencyPath:error.dependencyPath});
  }
}

// Missing preference preserves the stdout protocol of installed older callers.
export function outputUpgradeResult(result, { jsonOutput = true } = {}, output = process) {
  if (!jsonOutput) {
    const human = humanResults.get(result) || {};
    // Older previews may leave the changelog's final line unterminated.
    output.stdout.write('\n');
    if (result.success) output.stdout.write(`zylos-core upgraded: ${result.from} → ${result.to}.\n`);
    else {
      output.stderr.write(`Error: ${human.running?.error || result.error || 'Core upgrade failed.'}\n`);
      const from = result.from || human.from;
      if (result.rollback?.completed === true && (result.rollback.attempted || result.rollback.performed) && from) {
        output.stderr.write(`Rollback completed. zylos-core has been restored to ${from}.\n`);
      }
      if (human.dependencyPath) output.stderr.write(`Dependency path: ${human.dependencyPath}\n`);
    }
    if (result.recovery_required && !human.running) {
      const rollbackNotice = result.rollback?.completed === false && (result.rollback.attempted || result.rollback.recovery_required)
        ? 'Rollback did not complete. ' : '';
      output.stderr.write(`Upgrade warning: ${rollbackNotice}Upgrade is blocked until recovery completes.\n`);
    }
    const next = human.running?.next || (human.dependencyPath
      ? 'Replace the invalid core skill node_modules entry with a real dependency directory, or move it aside, then retry the upgrade.'
      : result.next || (result.recovery_required ? 'Run zylos recovery status, then zylos recovery resume before upgrading.' : null));
    if (next) output.stderr.write(`Next: ${next}\n`);
  }
  for(const warning of result.serviceWarnings || []) output.stderr.write(`Service warning: ${warning}\n`);
  // Runtime CLI preparation returns objects; finalization adds plain notices.
  for(const warning of result.warnings || []) output.stderr.write(typeof warning === 'string' ? `Upgrade warning: ${warning}\n` : `Runtime warning (${warning.runtime}): ${jsonOutput ? warning.code + ': ' : ''}${warning.message}\n`);
  for(const warning of result.corePackageWarnings || []) output.stderr.write(`Core package location warning: ${warning.message}\n`);
  for(const item of result.checkpointAudit?.items || []) {
    if(item?.repairRequired === true) output.stderr.write(`Checkpoint warning: checkpoint ${item.checkpointId} exceeds the available conversation range and requires repair.\n`);
  }
  if(result.checkpointAudit?.state === 'incomplete') output.stderr.write('Checkpoint audit warning: audit incomplete; checkpoint consistency could not be verified.\n');
  if (jsonOutput) output.stdout.write(JSON.stringify(result) + '\n');
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  let result, input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
    validateUpgradeHandoff(input);
    let targetRoot;
    try { targetRoot=fs.realpathSync(input.tempDir); }
    catch(cause) { throw Object.assign(Error('Downloaded target package is unavailable.',{cause}),{code:'UPGRADE_FAILED'}); }
    if (targetRoot !== fs.realpathSync(path.join(import.meta.dirname, '../..'))) throw Object.assign(new Error('Upgrade entry must run from the downloaded target package.'), {code:'INVALID_UPGRADE_HANDOFF'});
    process.env.ZYLOS_DIR = input.zylosDir;
    result = await runUpgradeEntry(input);
  } catch (error) {
    result = {success:false, code:error instanceof SyntaxError ? 'INVALID_UPGRADE_HANDOFF' : upgradeFailureCode(error), error:upgradeFailureMessage(error), persisted:[]};
  }
  outputUpgradeResult(result, { jsonOutput: input?.jsonOutput !== false });
  process.exitCode = result.success ? 0 : 1;
}
