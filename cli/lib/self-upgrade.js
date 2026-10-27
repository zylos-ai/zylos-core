/**
 * Self-upgrade logic for zylos-core itself.
 * Downloads new version via GitHub tarball, syncs Core Skills with
 * manifest-based preservation, and runs npm install -g from local path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { SKILLS_DIR, ZYLOS_DIR } from './config.js';
import { downloadArchive, downloadBranch } from './download.js';
import { generateManifest, saveMergeBaseline } from './manifest.js';
import { fetchRawFile, fetchLatestTag, compareSemverDesc, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';
import { smartSync, formatMergeResult } from './smart-merge.js';
import { getAllowedTmpRoots } from './upgrade.js';
import { getCoreEcosystemPath, restartManagedProcess, createPm2Helpers } from './pm2.js';

import { createRequire as createFinalizerRequire } from 'node:module';
const finalizerRequire=createFinalizerRequire(import.meta.url);
function requireFinalizerExit(dir,j,terminate){return finalizerRequire(path.join(dir,'finalizer.cjs')).quiesce(dir,j,{terminate});}

import { cleanupCoreDbRehearsals, preflightCoreDbUpgrade, probeCoreDbVersions, rehearseCoreDbUpgrade, runCoreDbWorker } from './core-db-backup.js';
import { beginUpgrade, beginBackupOnly, prepareBackupOnlyInstall, saveProtectedCode, prepareProtectedInstall, markInstallationIntent, recovery, protectedDataReady, protectedSuccess, maintenance, maintenanceFor } from './upgrade-protection.js';
import { selectSameVersionRetry } from './upgrade-retry.js';
import { loadSnapshotManifest } from './upgrade-snapshot-manifest.js';
import { updateZylosConfigLocked, readSessionMode } from './config.js';
import { createMigration } from './memory-migration.js';
import { requestRuntimeRestart } from './request-runtime-restart.js';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyCutoff, commitCutoff } from './upgrade-cutoff.js';
import { preparePostCutoff, publishPostCutoff, publishRuntimePreparation } from './upgrade-post-cutoff.js';
import { prepareUpgradeRuntime, prepareUpgradeRuntimeClis } from './upgrade-runtime-preparation.js';
import { DEFAULT_FINALIZE_TIMEOUT_MS, MIN_FINALIZE_TIMEOUT_MS, MAX_FINALIZE_TIMEOUT_MS } from './upgrade-budget.js';

const REPO = 'zylos-ai/zylos-core';

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Get current installed zylos-core version from package.json.
 */
export function getCurrentVersion() {
  const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { success: true, version: pkg.version };
  } catch (err) {
    return { success: false, error: `Cannot read package.json: ${err.message}` };
  }
}

/**
 * Get latest zylos-core version from GitHub.
 * Uses tag-based detection (unified with component upgrades).
 * Falls back to package.json on a branch when --branch is specified.
 *
 * @param {object} [opts]
 * @param {string} [opts.branch] - Branch to read from (reads package.json from branch)
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) tags
 */
function getLatestVersion({ branch, beta = false } = {}) {
  // When --branch is specified, read package.json from that branch
  if (branch) {
    try {
      const content = fetchRawFile(REPO, 'package.json', branch);
      const pkg = JSON.parse(content);
      return { success: true, version: pkg.version };
    } catch (err) {
      return { success: false, error: `Cannot fetch latest version: ${sanitizeError(err.message)}` };
    }
  }

  // Default: tag-based detection (unified with component upgrades)
  try {
    const tagVersion = fetchLatestTag(REPO, { includePrerelease: beta });
    if (tagVersion) {
      return { success: true, version: tagVersion };
    }
    return { success: false, error: 'No release tags found' };
  } catch (err) {
    return { success: false, error: `Cannot fetch latest version: ${sanitizeError(err.message)}` };
  }
}

// ---------------------------------------------------------------------------
// Public: checkForCoreUpdates
// ---------------------------------------------------------------------------

/**
 * Check if zylos-core has updates available.
 *
 * @param {object} [opts]
 * @param {string} [opts.branch] - Branch to compare against
 * @param {boolean} [opts.beta=false] - Include prerelease (beta) versions
 * @returns {object} { success, hasUpdate, current, latest }
 */
export function checkForCoreUpdates({ branch, beta = false } = {}) {
  const current = getCurrentVersion();
  if (!current.success) {
    return { success: false, error: 'version_not_found', message: current.error };
  }

  const latest = getLatestVersion({ branch, beta });
  if (!latest.success) {
    return { success: false, error: 'remote_version_failed', message: latest.error };
  }

  // Use semver comparison (not string inequality) to avoid suggesting downgrades.
  // compareSemverDesc(a, b) > 0 means b is higher than a.
  const hasUpdate = compareSemverDesc(current.version, latest.version) > 0;

  return {
    success: true,
    hasUpdate,
    current: current.version,
    latest: latest.version,
  };
}

// ---------------------------------------------------------------------------
// Public: downloadCoreToTemp
// ---------------------------------------------------------------------------

/**
 * Download a zylos-core version to temp directory.
 *
 * @param {string} version
 * @returns {{ success: boolean, tempDir?: string, error?: string }}
 */
function getWritableTmpBase(prefix = 'zylos-self-upgrade-probe-') {
  let base = os.tmpdir();
  try {
    const probe = fs.mkdtempSync(path.join(base, prefix));
    fs.rmSync(probe, { recursive: true, force: true });
  } catch {
    // System tmp unavailable — fallback to ~/tmp
    base = path.join(os.homedir(), 'tmp');
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

export function downloadCoreToTemp(version, branch) {
  const base = getWritableTmpBase('zylos-self-upgrade-probe-');
  const tempDir = fs.mkdtempSync(path.join(base, 'zylos-self-upgrade-'));

  if (branch) {
    const branchResult = downloadBranch(REPO, branch, tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: branchResult.error };
    }
    return { success: true, tempDir };
  }

  const result = downloadArchive(REPO, version, tempDir);
  if (!result.success) {
    // Fallback: try downloading main branch (for pre-release versions without tags)
    const branchResult = downloadBranch(REPO, 'main', tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: result.error };
    }
  }

  return { success: true, tempDir };
}

// ---------------------------------------------------------------------------
// Public: readChangelog
// ---------------------------------------------------------------------------

/**
 * Read CHANGELOG.md from a directory.
 */
export function readChangelog(dir) {
  const changelogPath = path.join(dir, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  try {
    return fs.readFileSync(changelogPath, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core Skills sync
// ---------------------------------------------------------------------------

/**
 * Sync Core Skills from new version to SKILLS_DIR using smart merge.
 *
 * Strategy (per file):
 * - Local unmodified → overwrite with new version
 * - Local modified, new unchanged → keep local
 * - Both changed → try diff3 three-way merge; if conflict → overwrite + backup local
 * - New skill (not installed) → copy fresh
 *
 * No "preserve" — every file gets a definitive outcome.
 * Backup serves as safety net for conflict files.
 *
 * @param {string} newSkillsSrc - Path to skills/ in downloaded temp dir
 * @param {string} [backupBase] - Base directory for conflict backups
 * @param {object} [opts]
 * @param {string} [opts.mode] - 'merge' (default) or 'overwrite'
 * @returns {{ synced: string[], added: string[], merged: string[], deleted: string[], preserved: string[], conflicts: { skill: string, file: string, backupPath: string }[], errors: string[], pendingBaselines: { destDir: string, srcDir: string, manifest: object }[] }}
 */
export function syncCoreSkills(newSkillsSrc, backupBase, opts = {}) {
  const result = { synced: [], added: [], merged: [], deleted: [], preserved: [], conflicts: [], errors: [], pendingBaselines: [] };

  if (!fs.existsSync(newSkillsSrc)) {
    return result;
  }

  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }

  const entries = fs.readdirSync(newSkillsSrc, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillName = entry.name;
    const srcDir = path.join(newSkillsSrc, skillName);
    const destDir = path.join(SKILLS_DIR, skillName);

    if (!fs.existsSync(destDir)) {
      // New skill — copy entirely and defer its baseline to the outer commit.
      // Manifest is generated from the SOURCE (authoritative package), never
      // from a destDir scan, so pre-existing local files are not absorbed
      // into the ownership record (issue #715).
      try {
        if (opts.transactionId) {
          if(!opts.transactionDir)throw Error('protected new core deployment requires transaction directory');
          const journal=maintenance.read(path.join(opts.transactionDir,'journal.json'));
          const staging=path.join(opts.transactionDir,'new-core',skillName);
          journal.coreCreation ||= {};
          journal.coreCreation[skillName]={staging,target:destDir,published:false};
          maintenance.update(opts.transactionDir,journal);
          if(fs.existsSync(staging))throw Error('new core staging already exists');
          fs.cpSync(srcDir,staging,{recursive:true,verbatimSymlinks:true});
          const metadata=path.join(staging,'.zylos');
          let metadataStat;try{metadataStat=fs.lstatSync(metadata);}catch(error){if(error.code!=='ENOENT')throw error;}
          if(metadataStat)maintenance.privatePath(metadata,{directory:true});
          maintenance.durable(path.join(metadata,'upgrade-owner.json'),{transactionId:opts.transactionId});
          maintenance.fsyncTree(staging);
          fs.renameSync(staging,destDir);
          maintenance.fsyncDir(path.dirname(staging));maintenance.fsyncDir(path.dirname(destDir));
          journal.coreCreation[skillName].published=true;maintenance.update(opts.transactionDir,journal);
        } else copyTree(srcDir, destDir);
        result.pendingBaselines.push({ destDir, srcDir, manifest: generateManifest(srcDir) });
        result.added.push(skillName);
      } catch (err) {
        result.errors.push(`${skillName}: ${err.message}`);
      }
      continue;
    }

    // Existing skill — smart merge
    try {
      const skillBackupDir = backupBase ? path.join(backupBase, skillName) : null;
      const mergeResult = smartSync(srcDir, destDir, {
        backupDir: skillBackupDir,
        mode: opts.mode,
      });

      // Aggregate results
      if (mergeResult.overwritten.length || mergeResult.added.length || mergeResult.deleted.length
          || mergeResult.preserved.length) {
        result.synced.push(skillName);
      }
      if (mergeResult.merged.length) {
        result.merged.push(...mergeResult.merged.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.deleted.length) {
        result.deleted.push(...mergeResult.deleted.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.preserved.length) {
        result.preserved.push(...mergeResult.preserved.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.conflicts.length) {
        for (const c of mergeResult.conflicts) {
          result.conflicts.push({ skill: skillName, file: c.file, backupPath: c.backupPath });
        }
      }
      if (mergeResult.errors.length) {
        result.errors.push(...mergeResult.errors.map(e => `${skillName}: ${e}`));
      } else {
        result.pendingBaselines.push({ destDir, srcDir, manifest: mergeResult.nextManifest });
      }

    } catch (err) {
      result.errors.push(`${skillName}: ${err.message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/**
 * List all files in templates/ directory recursively.
 * Returns relative paths for Claude to compare with local structure.
 */
function listTemplateFiles(templatesDir) {
  const files = [];
  if (!templatesDir) return files;
  if (!fs.existsSync(templatesDir)) return files;

  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }

  walk(templatesDir);
  return files;
}


// ---------------------------------------------------------------------------
// 11-step self-upgrade pipeline
// ---------------------------------------------------------------------------

/**
 * Create self-upgrade context.
 */
function createContext({ tempDir, newVersion, mode } = {}) {
  const coreDir = path.join(import.meta.dirname, '..', '..');

  return {
    coreDir,
    tempDir: tempDir && fs.existsSync(tempDir) ? fs.realpathSync(tempDir) : tempDir || null,
    newVersion: newVersion || null,
    mode: mode || 'merge',
    // State tracking
    backupDir: null,
    servicesStopped: [],
    servicesWereRunning: [],
    mergeConflicts: [],
    mergedFiles: [],
    // Results
    steps: [],
    from: null,
    to: null,
    success: false,
    error: null,
  };
}

/**
 * Step 1: backup Core Skills
 */
export function step1_backupCoreSkills(ctx, deps = {}) {
  const startTime = Date.now();
  if (ctx.preInstallProtection) {
    try { saveProtectedCode(ctx); return {step:1,name:'backup_core_skills',status:'done',duration:Date.now()-startTime}; }
    catch(error) { return {step:1,name:'backup_core_skills',status:'failed',error:error.message,duration:Date.now()-startTime}; }
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = deps.backupDir
    ?? path.join(getWritableTmpBase('zylos-core-backup-probe-'), `zylos-core-backup-${timestamp}`);
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;
  const copyTreeFn = deps.copyTree ?? copyTree;
  const fsApi = deps.fs ?? fs;

  try {
    fsApi.mkdirSync(backupDir, { recursive: true });

    // Backup the skills directory (include .zylos manifests — needed for correct rollback)
    if (fsApi.existsSync(skillsDir)) {
      copyTreeFn(skillsDir, path.join(backupDir, 'skills'), { excludes: ['node_modules'] });
    }

    const ecosystemSrc = deps.ecosystemPath ?? path.join(zylosDir, 'pm2', 'ecosystem.config.cjs');
    if (fsApi.existsSync(ecosystemSrc)) {
      const backupPm2Dir = path.join(backupDir, 'pm2');
      fsApi.mkdirSync(backupPm2Dir, { recursive: true });
      fsApi.copyFileSync(ecosystemSrc, path.join(backupPm2Dir, 'ecosystem.config.cjs'));
    }

    ctx.backupDir = backupDir;
    return { step: 1, name: 'backup_core_skills', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 1, name: 'backup_core_skills', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 2: pre-upgrade hook (placeholder for future use)
 */
export function step2_preUpgradeHook(ctx) {
  const startTime = Date.now();
  // No core pre-upgrade hook yet — reserved for future
  return { step: 2, name: 'pre_upgrade_hook', status: 'skipped', duration: Date.now() - startTime };
}

/**
 * Find PM2 services running from SKILLS_DIR by matching exec paths.
 * This catches ALL zylos-managed services regardless of SKILL.md declarations.
 *
 * @returns {{ name: string, status: string }[]} PM2 processes whose scripts are under SKILLS_DIR
 */
function getSkillsServices(deps = {}) {
  const execSyncFn = deps.execSync ?? execSync;
  try {
    const output = execSyncFn('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const resolved = path.resolve(SKILLS_DIR);

    return processes
      .filter(proc => {
        const execPath = proc.pm2_env?.pm_exec_path || '';
        return execPath.startsWith(resolved + '/');
      })
      .map(proc => ({ name: proc.name, status: proc.pm2_env?.status }));
  } catch {
    return [];
  }
}

/**
 * Step 3: stop core services
 */
export function step3_stopCoreServices(ctx, deps = {}) {
  const startTime = Date.now();
  if (ctx.preInstallProtection) {try {prepareProtectedInstall(ctx,deps);return {step:3,name:'protect_databases_and_stop_services',status:'done',duration:Date.now()-startTime};}catch(error){return {step:3,name:'protect_databases_and_stop_services',status:'failed',error:error.message,duration:Date.now()-startTime};}}
  if (ctx.backupOnly) {try {prepareBackupOnlyInstall(ctx,deps);return {step:3,name:'backup_databases_and_stop_services',status:'done',dbBackupDir:ctx.dbBackupDir,message:`Verified database snapshot: ${ctx.dbBackupDir}. Automatic recovery disabled; failure requires manual recovery.`,duration:Date.now()-startTime};}catch(error){return {step:3,name:'backup_databases_and_stop_services',status:'failed',error:error.message,duration:Date.now()-startTime};}}
  const execSyncFn = deps.execSync ?? execSync;
  const getServices = deps.getSkillsServices ?? (() => getSkillsServices(deps));
  const stopService = deps.stopService ?? ((name) => {
    execSyncFn(`pm2 stop ${name} 2>/dev/null`, { stdio: 'pipe' });
  });

  // Find all PM2 services running from skills directory
  const services = getServices();
  const onlineServices = services.filter(s => s.status === 'online');

  if (services.length === 0) {
    return { step: 3, name: 'stop_core_services', status: 'skipped', message: 'no services found', duration: Date.now() - startTime };
  }

  if (onlineServices.length === 0) {
    return { step: 3, name: 'stop_core_services', status: 'done', message: 'none running', duration: Date.now() - startTime };
  }

  for (const svc of onlineServices) {
    ctx.servicesWereRunning.push(svc.name);
    try {
      stopService(svc.name);
      ctx.servicesStopped.push(svc.name);
    } catch {
      // Continue even if one service fails to stop
    }
  }

  const msg = ctx.servicesStopped.length > 0 ? ctx.servicesStopped.join(', ') : 'none running';
  return { step: 3, name: 'stop_core_services', status: 'done', message: msg, duration: Date.now() - startTime };
}

/**
 * Step 4: npm pack + npm install -g tarball
 *
 * Using `npm install -g <folder>` creates a symlink to the folder.
 * Since we install from a temp dir that gets cleaned up, the symlink breaks.
 * Instead: npm pack (creates a .tgz copy) → npm install -g <tgz> (copies files).
 */
export function resolveProtectedNpmCli() {
  for(const directory of String(process.env.PATH||'').split(path.delimiter)){
    if(!path.isAbsolute(directory))continue;
    try{const file=fs.realpathSync(path.join(directory,'npm')),st=fs.statSync(file);if(path.basename(file)==='npm-cli.js'&&st.isFile()){fs.accessSync(file,fs.constants.R_OK);return file;}}catch{}
  }
  throw Error('trusted npm-cli.js entry is unavailable');
}
export function runProtectedInstaller(ctx,{stage,npmCli,args,cwd,timeout=180000}) {
  const maintenance = maintenanceFor(ctx);
  cwd=fs.realpathSync(cwd);
  const dir=ctx.transactionDir,j=maintenance.read(path.join(dir,'journal.json'));
  maintenance.validateDescriptor(dir,j,maintenance.read(path.join(dir,'descriptor.json')));
  // A crash before spawnSync returns leaves no reliable PID evidence. Recovery
  // must remain blocked in that case; parent death never proves npm has exited.
  maintenance.update(dir,j,{installerStarted:true,installerStage:stage,installerPid:null,installerExitConfirmed:false,installerExitUnconfirmed:false});
  ctx.journal=j;
  const result=spawnSync(process.execPath,[npmCli,...args],{cwd,env:{...process.env,ZYLOS_SKIP_POSTINSTALL:'1'},encoding:'utf8',stdio:['ignore','pipe','pipe'],detached:true,timeout,killSignal:'SIGKILL',maxBuffer:4*1024*1024});
  const saved=maintenance.read(path.join(dir,'journal.json'));
  maintenance.update(dir,saved,{installerPid:result.pid||null});
  let verified;
  try { verified=finalizerRequire(path.join(dir,'finalizer.cjs')).quiesce(dir,saved,{terminate:true,kind:'installer'}); }
  catch(error){verified={confirmed:false,error:error.message};}
  maintenance.update(dir,saved,{installerExitConfirmed:verified.confirmed,installerExitUnconfirmed:!verified.confirmed});ctx.journal=saved;
  if(!verified.confirmed)throw Error(verified.error||'installer process exit unconfirmed');
  if(result.error||result.status!==0){const error=Error(result.error?.message||String(result.stderr||'').trim()||'npm '+stage+' exited '+result.status);error.stderr=String(result.stderr||'');throw error;}
  return String(result.stdout||'');
}
export function step4_npmInstallGlobal(ctx, deps = {}) {
  const startTime = Date.now();
  const execSyncFn = deps.execSync ?? execSync;

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 4, name: 'npm_install_global', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  try {
    if (ctx.backupOnly && !ctx.dbSnapshotVerified) throw Error('verified preinstall database snapshot required before installation');
    // Pack first — creates a .tgz tarball (copies, not symlinks)
    if (ctx.preInstallProtection) markInstallationIntent(ctx);
    if(ctx.preInstallProtection&&!deps.execSync){
      const npmCli=ctx.protectedNpmCli;
      const packed=runProtectedInstaller(ctx,{stage:'pack',npmCli,args:['pack','--pack-destination','.'],cwd:ctx.tempDir});
      const tarballName=packed.trim().split(/\r?\n/).at(-1);
      if(!tarballName||path.basename(tarballName)!==tarballName||!tarballName.endsWith('.tgz'))throw Error('npm pack returned an invalid tarball filename');
      runProtectedInstaller(ctx,{stage:'install',npmCli,args:['install','-g',path.join(ctx.tempDir,tarballName)],cwd:ctx.tempDir});
      return {step:4,name:'npm_install_global',status:'done',duration:Date.now()-startTime};
    }
    const tarballName = execSyncFn('npm pack --pack-destination .', {
      cwd: ctx.tempDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const tarballPath = path.join(ctx.tempDir, tarballName);

    // Install from tarball — npm copies files into global node_modules
    execSyncFn(`npm install -g "${tarballPath}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZYLOS_SKIP_POSTINSTALL: '1' },  // Skip postinstall — we sync skills ourselves
    });
    return { step: 4, name: 'npm_install_global', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 4, name: 'npm_install_global', status: 'failed', error: err.stderr?.trim() || err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 5: sync Core Skills (smart merge — no preserve)
 */
export function step5_syncCoreSkills(ctx, deps = {}) {
  const startTime = Date.now();
  const fsApi = deps.fs ?? fs;
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const syncCoreSkillsFn = deps.syncCoreSkills ?? syncCoreSkills;

  const newSkillsSrc = path.join(ctx.tempDir, 'skills');
  if (!fsApi.existsSync(newSkillsSrc)) {
    return { step: 5, name: 'sync_core_skills', status: 'skipped', message: 'no skills in new version', duration: Date.now() - startTime };
  }

  try {
    // Conflict backups are durable user-recovery artifacts. Keep them outside
    // the temporary transaction snapshot, which the non-JSON success path
    // removes after the upgrade commits.
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictBackupDir = path.join(zylosDir, '.backup', timestamp, 'conflicts');
    const syncResult = syncCoreSkillsFn(newSkillsSrc, conflictBackupDir, { mode: ctx.mode, transactionId: ctx.transactionId, transactionDir:ctx.transactionDir });

    const parts = [];
    if (syncResult.synced.length) parts.push(`${syncResult.synced.length} synced`);
    if (syncResult.added.length) parts.push(`${syncResult.added.length} added`);
    if (syncResult.merged.length) parts.push(`${syncResult.merged.length} merged`);
    if (syncResult.deleted.length) parts.push(`${syncResult.deleted.length} deleted`);
    if (syncResult.preserved.length) parts.push(`${syncResult.preserved.length} preserved`);
    if (syncResult.conflicts.length) parts.push(`${syncResult.conflicts.length} conflicts`);
    if (syncResult.errors.length) parts.push(`${syncResult.errors.length} errors`);
    const summary = parts.join(', ') || 'no changes';
    const conflictPaths = syncResult.conflicts.map(({ skill, file, backupPath }) =>
      `${skill}/${file} -> ${backupPath}`
    );
    const msg = conflictPaths.length > 0
      ? `${summary}; backups: ${conflictPaths.join('; ')}`
      : summary;

    // Store conflicts on ctx for the final result
    ctx.mergeConflicts = syncResult.conflicts;
    ctx.mergedFiles = syncResult.merged;
    ctx.pendingBaselines = syncResult.pendingBaselines;

    if (syncResult.errors.length > 0) {
      return { step: 5, name: 'sync_core_skills', status: 'failed', error: syncResult.errors.join('; '), duration: Date.now() - startTime };
    }

    return { step: 5, name: 'sync_core_skills', status: 'done', message: msg, duration: Date.now() - startTime };
  } catch (err) {
    return { step: 5, name: 'sync_core_skills', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 6: install/update skill dependencies
 */
export function step6_installSkillDeps(ctx, deps = {}) {
  const startTime = Date.now();
  const skillsRoot=deps.skillsDir || SKILLS_DIR;
  const execSyncFn=deps.execSync || execSync;
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  const allowed=ctx.preInstallProtection ? new Set(ctx.coreManifest.map(entry=>entry.name)) : null;
  let installed = 0;
  const failed = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || (allowed&&!allowed.has(entry.name))) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const pkgPath = path.join(skillDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;

      execSyncFn('npm install --omit=dev', {
        cwd: skillDir,
        stdio: 'pipe',
        timeout: 120000,
      });
      installed++;
    } catch {
      failed.push(entry.name);
    }
  }

  const msg = `${installed} installed${failed.length ? `, ${failed.length} failed: ${failed.join(', ')}` : ''}`;
  if (failed.length > 0) {
    return { step: 6, name: 'install_skill_deps', status: 'failed', error: msg, duration: Date.now() - startTime };
  }
  return { step: 6, name: 'install_skill_deps', status: 'done', message: msg, duration: Date.now() - startTime };
}


/**
 * Resolve a script path in the globally installed package.
 * Reads the package name from package.json to avoid hardcoding.
 * @returns {string|null} Absolute path to the script, or null if not found.
 */
function resolveInstalledPackageScript(...parts) {
  try {
    // import.meta.dirname points to cli/lib/, go up two levels to package root
    const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const pkgName = pkg.name || 'zylos';
    const npmRoot = execSync('npm root -g', { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }).trim();
    const script = path.join(npmRoot, pkgName, ...parts);
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/**
 * Step 11: start core services
 */
export function step11_startCoreServices(ctx, deps = {}) {
  const startTime = Date.now();
  const fsApi = deps.fs ?? fs;
  const budget = ctx.budget;
  const execute = deps.execSync ?? execSync;
  const exec = (command, options = {}) => {
    budget?.check();
    return execute(command, {...options,...(budget ? {timeout:Math.max(1,Math.floor(Math.min(30000,budget.remaining())))} : {})});
  };
  const restartFn = deps.restartManagedProcess ?? (budget ? createPm2Helpers({exec}).restartManagedProcess : restartManagedProcess);
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 11, name: 'start_core_services', status: 'skipped', message: 'no services to restart', duration: Date.now() - startTime };
  }

  // Deploy the new ecosystem.config.cjs from the upgraded package so PM2
  // re-evaluates env vars (e.g. ZYLOS_PACKAGE_ROOT) when services restart.
  // `pm2 restart <name>` reuses PM2's cached config and never picks up new env.
  let ecosystemPath = null;
  const ecosystemTemplateSrc = ctx.tempDir
    ? path.join(ctx.tempDir, 'templates', 'pm2', 'ecosystem.config.cjs')
    : null;
  const pm2Dir = path.join(zylosDir, 'pm2');
  const ecosystemDest = deps.ecosystemPath ?? getCoreEcosystemPath();
  if (ecosystemTemplateSrc && fsApi.existsSync(ecosystemTemplateSrc)) {
    try {
      fsApi.mkdirSync(pm2Dir, { recursive: true });
      if(ctx.preInstallProtection)ctx.journal=maintenance.read(path.join(ctx.transactionDir,'journal.json'));
      if(ctx.preInstallProtection&&!ctx.journal.initialIdentity.ecosystemHash){
        const staging=path.join(ctx.transactionDir,'new-ecosystem.cjs'),intendedHash=maintenance.hash(ecosystemTemplateSrc);
        const stat = file => {
          try { return fsApi.lstatSync(file); }
          catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        };
        let intent=ctx.journal.ecosystemCreationIntent;
        const destinationStat=stat(ecosystemDest);
        let stagingStat=stat(staging);
        if(!intent){
          if(destinationStat||stagingStat)throw Error('originally missing ecosystem appeared without provenance');
          intent={target:ecosystemDest,originalMissing:true,intendedHash,staging};
          maintenance.update(ctx.transactionDir,ctx.journal,{ecosystemCreationIntent:intent});
        }
        if(intent.target!==ecosystemDest||intent.originalMissing!==true||intent.intendedHash!==intendedHash||intent.staging!==staging){
          throw Error('ecosystem creation intent changed');
        }
        if(!destinationStat&&stagingStat?.isFile()&&maintenance.hash(staging)!==intendedHash){
          // A copy interrupted before publication can leave incomplete private staging.
          fsApi.unlinkSync(staging);
          maintenance.fsyncDir(ctx.transactionDir);
          stagingStat=null;
        }
        if(!stagingStat){
          if(destinationStat)throw Error('ecosystem creation staging provenance missing');
          fsApi.copyFileSync(ecosystemTemplateSrc,staging,fs.constants.COPYFILE_EXCL);
          const fd=fsApi.openSync(staging,'r');try{maintenance.fsyncFd(fd);}finally{fsApi.closeSync(fd);}
          maintenance.fsyncDir(ctx.transactionDir);
          stagingStat=stat(staging);
        }
        if(!stagingStat.isFile()||maintenance.hash(staging)!==intendedHash)throw Error('ecosystem creation staging changed');
        if(destinationStat){
          // Only the hard link published by this transaction can be resumed.
          if(!destinationStat.isFile()||destinationStat.dev!==stagingStat.dev||destinationStat.ino!==stagingStat.ino||maintenance.hash(ecosystemDest)!==intendedHash){
            throw Error('ecosystem creation destination provenance changed');
          }
        }else{
          // Exclusive publication also rejects a file appearing after validation.
          fsApi.linkSync(staging,ecosystemDest);
        }
        maintenance.fsyncDir(path.dirname(ecosystemDest));
      }else fsApi.copyFileSync(ecosystemTemplateSrc, ecosystemDest);
      ecosystemPath = ecosystemDest;
    } catch(error) {
      if(ctx.preInstallProtection)return {step:11,name:'start_core_services',status:'failed',error:error.message,duration:Date.now()-startTime};
      // Non-fatal — if copy fails, we can still use an already-deployed ecosystem file below.
    }
  } else if (fsApi.existsSync(ecosystemDest)) {
    // No new template available; use the existing ecosystem file
    ecosystemPath = ecosystemDest;
  }
  ecosystemPath = ecosystemPath ?? ecosystemDest;

  const started = [];
  const failed = [];

  for (const name of ctx.servicesWereRunning) {
    try {
      restartFn(name, {
        ecosystemPath,
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      });
      started.push(name);
    } catch {
      failed.push(name);
    }
  }

  if (failed.length > 0) {
    return { step: 11, name: 'start_core_services', status: 'failed', error: `Failed to restart: ${failed.join(', ')}`, duration: Date.now() - startTime };
  }

  if (started.includes('activity-monitor')) {
    const verifyActivityMonitorEnv = deps.verifyActivityMonitorEnv ?? (() => {
      const output = exec('pm2 jlist 2>/dev/null', {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const processes = JSON.parse(String(output));
      const activityMonitor = processes.find(process => process.name === 'activity-monitor');
      return Boolean(activityMonitor?.pm2_env?.ZYLOS_PACKAGE_ROOT);
    });

    try {
      if (!verifyActivityMonitorEnv()) {
        return { step: 11, name: 'start_core_services', status: 'failed', error: 'activity-monitor PM2 env missing ZYLOS_PACKAGE_ROOT after restart', duration: Date.now() - startTime };
      }
    } catch (err) {
      const detail = err?.message ? `: ${err.message}` : '';
      return { step: 11, name: 'start_core_services', status: 'failed', error: `failed to verify activity-monitor PM2 env after restart${detail}`, duration: Date.now() - startTime };
    }
  }

  try {
    exec('pm2 save 2>/dev/null', { stdio: 'pipe' });
  } catch {
    return { step: 11, name: 'start_core_services', status: 'failed', error: 'failed to save PM2 process list after core restart', duration: Date.now() - startTime };
  }

  return { step: 11, name: 'start_core_services', status: 'done', message: started.join(', '), duration: Date.now() - startTime };
}

/**
 * Step 12: verify services
 *
 * Polls up to 30 seconds (every 2 s) for all services to come online.
 * Some services (e.g. component bots) take longer than 2 s to start after
 * PM2 restarts them — a one-shot check caused spurious rollbacks.
 */
export function step12_verifyServices(ctx, deps = {}) {
  const startTime = Date.now();

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 12, name: 'verify_services', status: 'skipped', message: 'no services to verify', duration: Date.now() - startTime };
  }

  const POLL_INTERVAL_MS = 2000;
  const budget = ctx.budget;
  const execute = deps.execSync ?? execSync;
  const TIMEOUT_MS = Math.min(30000,budget ? budget.remaining() : Infinity);

  while (Date.now() - startTime < TIMEOUT_MS) {
    try {
      budget?.check();
      const remaining = Math.max(1,Math.floor(Math.min(TIMEOUT_MS-(Date.now()-startTime),budget ? budget.remaining() : Infinity)));
      execute(`sleep ${Math.min(POLL_INTERVAL_MS,remaining)/1000}`, { stdio: 'pipe',timeout:remaining });
    } catch (error) { return {step:12,name:'verify_services',status:'failed',error:error.message,duration:Date.now()-startTime}; }

    try {
      budget?.check();
      const output = execute('pm2 jlist 2>/dev/null', { encoding: 'utf8',timeout:Math.max(1,Math.floor(Math.min(30000,budget ? budget.remaining() : 30000))) });
      const processes = JSON.parse(output);

      const notOnline = ctx.servicesWereRunning.filter(name => {
        const proc = processes.find(p => p.name === name);
        return !proc || proc.pm2_env?.status !== 'online';
      });

      if (notOnline.length === 0) {
        return { step: 12, name: 'verify_services', status: 'done', duration: Date.now() - startTime };
      }

      // If we still have time, keep polling
      if (Date.now() - startTime + POLL_INTERVAL_MS >= TIMEOUT_MS) {
        return { step: 12, name: 'verify_services', status: 'failed', error: `Not online after ${TIMEOUT_MS / 1000}s: ${notOnline.join(', ')}`, duration: Date.now() - startTime };
      }
    } catch (err) {
      return { step: 12, name: 'verify_services', status: 'failed', error: err.message, duration: Date.now() - startTime };
    }
  }

  // Timed out
  return { step: 12, name: 'verify_services', status: 'failed', error: `Timed out after ${TIMEOUT_MS / 1000}s`, duration: Date.now() - startTime };
}

/** Commit every Core Skill baseline after the complete self-upgrade succeeds. */
function step13_commitSkillBaselines(ctx) {
  const startTime = Date.now();
  try {
    for (const baseline of ctx.pendingBaselines || []) {
      saveMergeBaseline(baseline.destDir, baseline.srcDir, baseline.manifest);
    }
    return {
      step: 13,
      name: 'commit_skill_baselines',
      status: 'done',
      message: `${(ctx.pendingBaselines || []).length} committed`,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return { step: 13, name: 'commit_skill_baselines', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Rollback from backup.
 */
export function rollbackSelf(ctx, deps = {}) {
  const results = [];
  const fsApi = deps.fs ?? fs;
  const syncTreeFn = deps.syncTree ?? syncTree;
  const restartFn = deps.restartManagedProcess ?? restartManagedProcess;
  const zylosDir = deps.zylosDir ?? ZYLOS_DIR;
  const skillsDir = deps.skillsDir ?? SKILLS_DIR;
  const ecosystemPath = deps.ecosystemPath ?? getCoreEcosystemPath();

  // Restore Core Skills from backup (include .zylos manifests to keep them in sync with files)
  if (ctx.backupDir && fsApi.existsSync(path.join(ctx.backupDir, 'skills'))) {
    try {
      syncTreeFn(path.join(ctx.backupDir, 'skills'), skillsDir, { excludes: ['node_modules'] });
      results.push({ action: 'restore_core_skills', success: true });
    } catch (err) {
      results.push({ action: 'restore_core_skills', success: false, error: err.message });
    }
  }

  if (ctx.backupDir) {
    const backupEcosystem = path.join(ctx.backupDir, 'pm2', 'ecosystem.config.cjs');
    if (fsApi.existsSync(backupEcosystem)) {
      try {
        fsApi.mkdirSync(path.dirname(ecosystemPath), { recursive: true });
        fsApi.copyFileSync(backupEcosystem, ecosystemPath);
        results.push({ action: 'restore_pm2_ecosystem', success: true });
      } catch (err) {
        results.push({ action: 'restore_pm2_ecosystem', success: false, error: err.message });
      }
    }
  }

  // Restart services if they were running
  for (const name of ctx.servicesWereRunning) {
    try {
      restartFn(name, {
        ecosystemPath,
        stdio: 'pipe',
        fallbackToPlainRestartOnError: true,
      });
      results.push({ action: `restart_${name}`, success: true });
    } catch (err) {
      results.push({ action: `restart_${name}`, success: false, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public: runSelfUpgrade
// ---------------------------------------------------------------------------

function backupOnlyResult(ctx, failed) {
  if (!ctx.backupOnly) return ctx.preInstallProtection ? {automaticCompensation:true, automaticResume:process.platform !== 'darwin', databaseMode:ctx.databaseMode || 'migrate', dbSnapshotVerified:ctx.dbSnapshotVerified===true, databases:ctx.databases || ctx.databasePreflight?.databases || null,...(ctx.rehearsalCleanup ? {rehearsalCleanup:ctx.rehearsalCleanup} : {})} : ctx.rehearsalCleanup ? {rehearsalCleanup:ctx.rehearsalCleanup} : {};
  return {
    backupOnly: true,
    ...(ctx.rehearsalCleanup ? {rehearsalCleanup:ctx.rehearsalCleanup} : {}),
    databaseMode: ctx.databaseMode || 'migrate',
    backupDir: ctx.backupDir || null,
    automaticRecovery: false,
    protectionUnavailableReason: ctx.protectionUnavailableReason,
    dbBackupDir: ctx.dbBackupDir || null,
    databases: ctx.databases || ctx.databasePreflight?.databases || ctx.dbManifest?.databases || null,
    dbSnapshotVerified: Boolean(ctx.dbSnapshotVerified),
    backupWarnings: ctx.backupWarnings || [],
    preInstallServicesRestored: ctx.preInstallServicesRestored === true,
    manualRecovery: {
      required: Boolean(failed) && ctx.preInstallServicesRestored !== true,
      dbBackupDir: ctx.dbBackupDir || null,
      instructions: ctx.preInstallServicesRestored === true
        ? 'Installation was not started. The previously running services were left running or restored; no database restoration was performed.'
        : ctx.dbSnapshotVerified
        ? 'Database recovery is manual. Preserve this snapshot; stop writers and verify code/schema compatibility before restoring databases or restarting services.'
        : 'No verified database snapshot is available. Installation was not started; inspect the failure before restarting stopped services.'
    }
  };
}
function buildSelfUpgradeResult(ctx, failedStep, rollbackResults = null, rollbackPerformed = Boolean(rollbackResults)) {
  if (failedStep) {
    return {
      action: 'self_upgrade',
      success: false,
      ...(ctx.retryOf ? {action:'retry',retryOf:ctx.retryOf,effectiveFrom:ctx.effectiveFrom,transactionId:ctx.transactionId} : {}),
      ...backupOnlyResult(ctx, true),
      preInstallProtection:!!ctx.preInstallProtection,
      ...(ctx.protectionUnavailableReason ? {protectionUnavailableReason:ctx.protectionUnavailableReason} : {}),
      from: ctx.from,
      to: null,
      failedStep: failedStep.step,
      error: failedStep.error,
      steps: ctx.steps,
      rollback: { performed: rollbackPerformed, steps: rollbackResults || [] },
    };
  }

  // List template files for Claude to compare with local structure
  const templatesDir = ctx.tempDir ? path.join(ctx.tempDir, 'templates') : null;
  const templates = listTemplateFiles(templatesDir);

  // Runtime preparation already reconciled settings before publication.
  const migrationHints = [];

  const settingsChanged = ctx.settingsChanged ?? false;

  return {
    action: 'self_upgrade',
    success: true,
    ...(ctx.retryOf ? {action:'retry', retryOf:ctx.retryOf, effectiveFrom:ctx.effectiveFrom, transactionId:ctx.transactionId} : {}),
    ...backupOnlyResult(ctx, false),
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
    dbBackupDir: ctx.dbBackupDir || null,
    databases: ctx.databases || ctx.databasePreflight?.databases || ctx.dbManifest?.databases || null,
    preInstallProtection: Boolean(ctx.preInstallProtection),
    transactionDir: ctx.transactionDir || null,
    cleanupWarnings: ctx.cleanupWarnings || [],
    templates,
    migrationHints,
    settingsChanged,
    mergeConflicts: ctx.mergeConflicts.length > 0 ? ctx.mergeConflicts : null,
    mergedFiles: ctx.mergedFiles.length > 0 ? ctx.mergedFiles : null,
  };
}

export function createFinalizeState(ctx) {
  return {
    schemaVersion: ctx.preInstallProtection ? 2 : 1,
    finalizeTimeoutMs: ctx.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS,
    ...(ctx.retryOf ? {retryOf:ctx.retryOf,effectiveFrom:ctx.effectiveFrom} : {}),
    ...(ctx.snapshotFormatVersion ? {snapshotFormatVersion:ctx.snapshotFormatVersion} : {}),
    ...(ctx.databaseMode ? {databaseMode:ctx.databaseMode} : {}),
    ...backupOnlyResult(ctx, false),
    ...(ctx.backupOnly ? {dbManifest:ctx.dbManifest} : {}),
    ...(ctx.preInstallProtection ? {
      preInstallProtection: true,
      transactionDir: ctx.transactionDir,
      transactionId: ctx.transactionId,
      coreManifest: ctx.coreManifest,
      dbBackupDir: ctx.dbBackupDir,
      dbManifest:ctx.dbManifest,
    } : {}),
    tempDir: ctx.tempDir,
    backupDir: ctx.backupDir,
    servicesWereRunning: ctx.servicesWereRunning,
    from: ctx.from,
    to: ctx.to,
    newVersion: ctx.newVersion,
    mode: ctx.mode,
  };
}

function writeFinalizeState(ctx) {
  const statePath = path.join(ctx.tempDir, 'self-upgrade-finalize-state.json');
  fs.writeFileSync(statePath, `${JSON.stringify(createFinalizeState(ctx), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return statePath;
}

export function runInstalledFinalizer(ctx, deps = {}) {
  const maintenance = maintenanceFor(ctx);
  const finalizeScript = (deps.resolveInstalledPackageScript ?? resolveInstalledPackageScript)('cli', 'lib', 'self-upgrade-finalize.js');
  if (!finalizeScript) {
    throw new Error('newly installed self-upgrade finalizer not found');
  }

  const statePath = (deps.writeFinalizeState ?? writeFinalizeState)(ctx);
  if(ctx.preInstallProtection){
    ctx.journal=maintenance.read(path.join(ctx.transactionDir,'journal.json'));
    maintenance.update(ctx.transactionDir,ctx.journal,{finalizerStarted:true,finalizerPid:null,finalizerExitConfirmed:false});
  }
  const result = (deps.spawnSync ?? spawnSync)(process.execPath, [finalizeScript,statePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: ctx.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS,
    ...(ctx.preInstallProtection ? {detached:true,killSignal:'SIGKILL'} : {}),
  });

  let terminalCleanup;
  if(ctx.preInstallProtection){
    const dir=ctx.transactionDir;
    const saved=maintenance.read(path.join(dir,'journal.json'));
    maintenance.update(dir,saved,{finalizerPid:result.pid||null});
    const verified=(deps.requireFinalizerExit ?? requireFinalizerExit)(dir,saved,true);
    ctx.finalizerExitUnconfirmed=!verified.confirmed;
    maintenance.update(dir,saved,{finalizerExitConfirmed:verified.confirmed,finalizerExitUnconfirmed:!verified.confirmed});
    if(!verified.confirmed) throw Error(verified.error || 'finalizer process exit unconfirmed');
    if(maintenance.terminalValid(saved)) terminalCleanup=maintenance.finishTerminal(dir,saved);
  }
  if(result.error)throw result.error;

  const output = String(result.stdout || '').trim();
  if (!output) {
    const err = String(result.stderr || '').trim() || `finalizer exited ${result.status}`;
    throw new Error(err);
  }

  const parsed = JSON.parse(output);
  if (terminalCleanup) {
    parsed.cleanupComplete = terminalCleanup.complete;
    parsed.cleanupWarnings = [...(parsed.cleanupWarnings || []), ...terminalCleanup.warnings];
  }
  if (result.status !== 0 && parsed?.success !== false) {
    const err = String(result.stderr || '').trim() || `finalizer exited ${result.status}`;
    throw new Error(err);
  }

  return parsed;
}

export function assertDashboardUninstalled(zylosDir = ZYLOS_DIR) {
  const file = path.join(zylosDir,'.zylos','components.json');
  let components;
  try { components=JSON.parse(fs.readFileSync(file,'utf8')); }
  catch (error) { if(error.code==='ENOENT')return; throw error; }
  if (components.dashboard) throw Object.assign(Error('Uninstall the independent Dashboard while retaining its data before upgrading: zylos uninstall dashboard --yes'), {
    code:'DASHBOARD_STILL_INSTALLED',
    next:'Run zylos uninstall dashboard --yes while retaining its data before retrying the upgrade.'
  });
}

async function installedDashboardOwner(ctx) {
  const root=ctx.packageRoot || path.join(import.meta.dirname,'../..');
  return import(pathToFileURL(path.join(root,'cli/lib/dashboard-install.js')).href);
}

function refreshMaintenanceReader(ctx) {
  const m=maintenanceFor(ctx), j=m.transaction(ctx.zylosDir,ctx.transactionDir);
  if(!['compensation_closed','recovery_required'].includes(j.phase) || classifyCutoff(j)!=='closed' || j.postCutoff?.items?.hooks?.state!=='done') throw Error('Core publication is not ready for service access');
  // Keep the per-transaction frozen controller untouched. Newly started owners
  // need the target reader at the stable path to recognize the cutoff phase.
  const stable=path.join(ctx.zylosDir,'.zylos/upgrade/maintenance.cjs');
  m.privatePath(path.dirname(stable),{directory:true});
  m.privatePath(stable);
  const staging=stable+'.'+process.pid+'.'+Date.now()+'.staging';
  // The initial frozen reader keeps closed transactions isolated. Publish this
  // capability only after the mandatory tail prerequisites have succeeded.
  const source=fs.readFileSync(path.join(import.meta.dirname,'upgrade-maintenance.cjs'),'utf8');
  fs.writeFileSync(staging,source+'\nmodule.exports.assertCoreDatabaseAvailable = root => assertCoreDatabaseAvailable(root, {postCutoffReady:true});\n',{flag:'wx',mode:0o600});
  fs.chmodSync(staging,0o600);
  const fd=fs.openSync(staging,'r');
  try {m.fsyncFd(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(staging,stable);
  m.fsyncDir(path.dirname(stable));
  if(j.phase==='recovery_required') m.update(ctx.transactionDir,j,{phase:'compensation_closed'});
  ctx.journal=j;
  delete finalizerRequire.cache[stable];
}

export function readUpgradeModeStatus(zylosDir, {budget,execute=execFileSync} = {}) {
  budget.check();
  try {
    const output=execute(process.execPath,[path.join(import.meta.dirname,'../zylos.js'),'session-mode','status','--json'],{
      encoding:'utf8',stdio:'pipe',env:{...process.env,ZYLOS_DIR:zylosDir},
      timeout:Math.max(1,Math.floor(Math.min(30000,budget.remaining())))
    });
    const result=JSON.parse(output);
    if(result?.ok!==true) throw Error('P10 status command did not succeed');
    return result;
  } catch(cause) {
    throw Object.assign(Error('P10 session-mode status is unavailable or could not be read.',{cause}),{code:'P10_STATUS_UNAVAILABLE'});
  }
}

/** Shared by initial finalization and forward repair after publication is done. */
export async function completeUpgradeFinalization(ctx, deps = {}) {
  const root=ctx.zylosDir || ZYLOS_DIR, budget=ctx.budget;
  if (!budget || typeof budget.check!=='function' || typeof budget.remaining!=='function') throw Error('finalizer budget is required');
  const completion={install:'pending',dashboard:'degraded',sessionRestart:'manual_required',modeTransition:'unknown'};
  const steps=ctx.steps ||= [];
  const run=async (step,name,fn)=>{
    try {
      budget.check();
      const value=await fn();
      if(value?.status==='failed' || value?.ok===false) throw Object.assign(Error(value.error?.message || value.error || `${name} failed`), {code:value.code || value.error?.code});
      steps.push({step,name,status:value?.status || 'done',...(value?.message ? {message:value.message} : {})});
      return value;
    } catch(error) {error.step=step;error.finalizeStepName=name;throw error;}
  };
  const fail=error=>{
    ctx.error=error.message;
    const failed={step:error.step ?? null,name:error.finalizeStepName || 'finalize',status:'failed',error:error.message};
    steps.push(failed);
    if(ctx.preInstallProtection) recordClosedFinalizationFailure(ctx,error,{stopServices:deps.stopServices,requireClosed:true});
    return {...buildSelfUpgradeResult(ctx,failed,null,false),code:error.code,completion,...(ctx.isolationError ? {isolationError:ctx.isolationError} : {}),
      ...(ctx.preInstallProtection ? {recovery_required:true,next:'Repair the reported failure, then run zylos upgrade --resume-finalize.'} : {next:'把 CLI 装回原版本，处理失败原因后再重新升级'})};
  };
  try {
    await run(4,'session_threshold_defaults',()=> (deps.updateConfig || updateZylosConfigLocked)(
      {setIfAbsent:{new_session_threshold:70,codex_new_session_threshold:75}},
      {configFile:path.join(root,'.zylos/config.json'),lockFile:path.join(root,'.zylos/config.json.lock'),waitMs:2000}));
    await run(5,'memory_migration_ensure',()=> (deps.ensureMemoryMigration || (()=>createMigration({env:{...process.env,ZYLOS_DIR:root}}).ensure({createdBy:'upgrade'})))());
    await run(5,'rotate_legacy_session',()=>{
      const current=path.join(root,'memory/sessions/current.md');
      if(!fs.existsSync(current))return {status:'skipped',message:'legacy session already absent'};
      const script=path.join(root,'.claude/skills/zylos-memory/scripts/rotate-session.js');
      return (deps.rotateSession || (()=>execFileSync(process.execPath,[script],{encoding:'utf8',stdio:'pipe',env:{...process.env,ZYLOS_DIR:root}})))();
    });
    await run(6,'preserve_working_state',()=>{
      try {fs.readFileSync(path.join(root,'memory/state.md'),'utf8');}
      catch(error){if(error.code!=='ENOENT')throw error;}
      return {status:'skipped',message:'existing working state preserved for mode conversion'};
    });
    await run(13,'commit_skill_baselines',()=> (deps.commitBaselines || step13_commitSkillBaselines)(ctx));
    if(ctx.preInstallProtection) await run(7,'publish_maintenance_reader',()=> (deps.refreshMaintenanceReader || refreshMaintenanceReader)(ctx));
    await run(7,'start_core_services',()=> (deps.startServices || (c=>step11_startCoreServices(c,{zylosDir:root})))(ctx));
    await run(7,'verify_core_services',()=> (deps.verifyServices || step12_verifyServices)(ctx));
  } catch(error) {return fail(error);}

  let dashboard;
  const dashboardErrors=[];
  const dashboardFailure=(item,error)=>dashboardErrors.push({item,code:error.code || 'DASHBOARD_UNAVAILABLE',
    message:error.message,location:error.location || error.message});
  if(ctx.journal?.dashboardInstall?.dbCopy?.ok===false) {
    const error=ctx.journal.dashboardInstall.dbCopy.error;
    dashboardFailure('dbCopy',{code:error?.code || 'COPY_FAILED',message:error?.message || 'Legacy Dashboard database was not copied.'});
  }
  try {
    budget.check();
    const owner=deps.dashboardOwner || await installedDashboardOwner(ctx);
    if(ctx.firstDashboardTakeover){
      for(const [item,name] of [['registration','applyDashboardRegistration'],['route','applyDashboardRoute']]) {
        const saved=ctx.journal?.dashboardInstall?.items?.[item];
        if (item==='registration' && saved?.state==='done') continue;
        const persistItem = changes => {
          if (!saved) return;
          const dashboardInstall=structuredClone(ctx.journal.dashboardInstall);
          Object.assign(dashboardInstall.items[item], changes);
          maintenanceFor(ctx).update(ctx.transactionDir,ctx.journal,{dashboardInstall});
        };
        try {
          budget.check();
          persistItem({state:'pending',attempts:(saved?.attempts || 0)+1,lastError:null});
          const result=await owner[name]({zylosDir:root});
          if(result.state!=='done')throw Object.assign(Error(result.error?.message || result.message || `${name}: ${result.state}`),
            {code:result.error?.code || result.code,location:result.error?.location || result.location});
          persistItem({state:'done',lastError:null});
        } catch(error) {
          persistItem({state:'failed',lastError:{code:error.code || 'DASHBOARD_INSTALL_FAILED',message:error.message}});
          dashboardFailure(item,error);
        }
      }
    }
    budget.check();
    dashboard=await owner.verifyDashboard({zylosDir:root,deadlineAt:budget.deadlineAt});
  } catch(error) {dashboardFailure('dashboard',error);}
  dashboard={...dashboard,state:dashboardErrors.length?'degraded':dashboard?.state || 'degraded',errors:[...(dashboard?.errors || []),...dashboardErrors]};
  completion.dashboard=dashboard.state;
  ctx.dashboard=dashboard;
  try {
    budget.check();
    const status=await (deps.readModeStatus || (()=>readUpgradeModeStatus(root,{budget})))();
    const data=status?.ok===true ? status.data : status;
    if(!data || !Object.hasOwn(data,'sessionMode') || ![null,'single','multi'].includes(data.sessionMode) ||
        !Object.hasOwn(data,'transition') || data.transition!==null && typeof data.transition!=='object') throw Error('Invalid P10 session-mode status');
    ctx.modeStatus={state:'observed',sessionMode:data.sessionMode,transition:data.transition};
    completion.modeTransition=data.transition ? 'in_progress' : data.sessionMode===null ? 'pending_auto' : 'none';
  } catch(error) {
    ctx.modeStatus={state:'unavailable',error:{code:error.code || 'P10_STATUS_UNAVAILABLE',message:error.message}};
  }
  let mode,transition;
  try {
    budget.check(); mode=await (deps.readMode || readSessionMode)();
    budget.check(); transition=await (deps.readTransition || (async()=> (await import('../../skills/comm-bridge/scripts/c4-db.js')).getModeTransition()))();
    const normalized=mode.mode===null ? {...mode,mode:'single'} : mode;
    if(!['single','multi'].includes(normalized.mode))throw Error('session mode is not available');
    budget.check();
    const restart=await (deps.restart || requestRuntimeRestart)({deadlineAt:budget.deadlineAt,afterServiceRestart:true,
      readMode:()=>normalized,readTransition:()=>transition});
    completion.sessionRestart=restart.ok ? (restart.data?.result==='exit_enqueued' ? 'single_exit_enqueued' : restart.data?.result || 'accepted') : 'manual_required';
    ctx.restart=restart;
  } catch(error) {ctx.restart={ok:false,error:{code:error.code || 'RESTART_UNAVAILABLE',message:error.message}};}
  try {
    budget.check();
    const audit=await (deps.audit || (async()=> (await import('../../skills/comm-bridge/scripts/c4-db.js')).auditCheckpoints()))();
    ctx.checkpointAudit={state:'complete',items:audit};
  } catch(error) {ctx.checkpointAudit={state:'incomplete',error:error.message};}
  completion.install='done';
  ctx.completion=completion;
  if(ctx.preInstallProtection) (deps.protectedSuccess || protectedSuccess)(ctx);
  return {...buildSelfUpgradeResult(ctx,null),completion,dashboard,sessionRestart:ctx.restart,checkpointAudit:ctx.checkpointAudit,
    modeStatus:ctx.modeStatus,publication:ctx.publication,preparationWarnings:ctx.preparationWarnings || [],...(ctx.dashboardCopy ? {dashboardCopy:ctx.dashboardCopy} : {})};
}

export function runSelfUpgradeFinalize(state = {}, deps = {}) {
  if (state.schemaVersion !== undefined && ![1, 2].includes(state.schemaVersion)) {
    return {
      action: 'self_upgrade',
      success: false,
      from: state.from || null,
      to: null,
      failedStep: 5,
      error: `unsupported finalize state schemaVersion: ${state.schemaVersion}`,
      steps: [],
      rollback: { performed: false, steps: [] },
    };
  }

  const ctx = createContext({
    tempDir: state.tempDir,
    newVersion: state.newVersion || state.to,
    mode: state.mode,
  });
  ctx.backupOnly = state.backupOnly === true;
  ctx.databaseMode = state.databaseMode === 'unchanged' ? 'unchanged' : 'migrate';
  ctx.protectionUnavailableReason = state.protectionUnavailableReason;
  ctx.dbSnapshotVerified = state.dbSnapshotVerified === true;
  ctx.backupWarnings = state.backupWarnings;
  ctx.rehearsalCleanup = state.rehearsalCleanup;
  ctx.preInstallProtection = state.schemaVersion===2 && state.preInstallProtection===true;
  ctx.zylosDir = deps.zylosDir || ZYLOS_DIR;
  ctx.maintenance = deps.maintenance;
  ctx.budget = deps.budget;
  ctx.transactionDir=state.transactionDir;ctx.transactionId=state.transactionId;ctx.coreManifest=state.coreManifest;ctx.dbBackupDir=state.dbBackupDir;ctx.dbManifest=state.dbManifest;ctx.databases=state.databases || null;
  if(ctx.preInstallProtection){
    try {
      const maintenance=maintenanceFor(ctx);
      ctx.journal=maintenance.transaction(ctx.zylosDir,ctx.transactionDir);
      if(!ctx.journal.installationIntent)throw Error('finalizer without durable installation intent');
      const cutoff=maintenance.classifyCutoff(ctx.journal);
      if(cutoff!=='none')throw Error(cutoff==='closed' ? 'compensation is closed; use forward finalization' : 'untrusted cutoff requires manual recovery');
    }
    catch(error){return {success:false,error:error.message,rollback:{attempted:false,completed:false,performed:false},recovery_required:true};}
  }
  ctx.backupDir = state.backupDir || null;
  ctx.servicesWereRunning = Array.isArray(state.servicesWereRunning) ? [...state.servicesWereRunning] : [];
  ctx.from = state.from || null;
  ctx.retryOf = state.retryOf;
  ctx.effectiveFrom = state.effectiveFrom;
  ctx.snapshotFormatVersion = state.snapshotFormatVersion ?? state.dbManifest?.formatVersion;
  ctx.to = state.to || state.newVersion || null;

  if(!ctx.preInstallProtection && (state.transactionDir || state.transactionId || state.preInstallProtection===true)) {
    return buildSelfUpgradeResult(ctx,{step:5,error:'Declared upgrade transaction requires valid protected finalize state.'},null,false);
  }

  return finalizeInstalledUpgrade(ctx, deps);
}

function recordClosedFinalizationFailure(ctx, error, {stopServices, requireClosed=false} = {}) {
  const m = maintenanceFor(ctx);
  const journal = m.transaction(ctx.zylosDir || ZYLOS_DIR, ctx.transactionDir);
  const closed = m.classifyCutoff(journal) === 'closed';
  if (requireClosed && !closed) throw error;
  if (closed) {
    if (requireClosed) {
      try { (stopServices || m.stop)(journal); }
      catch (isolationError) { ctx.isolationError = isolationError.message; }
    }
    m.update(ctx.transactionDir, journal, {phase:'recovery_required', resumePhase:'compensation_closed', lastError:error.message});
  }
  ctx.journal = journal;
  return closed;
}

function finalizationFailure(ctx, error, step = 5) {
  const failed = {step, name:error.finalizeStepName || 'finalize', status:'failed', error:error.message};
  ctx.steps.push(failed);
  let closed = false;
  let recoveryError;
  if (ctx.preInstallProtection) {
    try {
      closed = recordClosedFinalizationFailure(ctx,error);
    } catch (failure) {
      recoveryError = failure.message;
    }
  }
  const guidance = recoveryError ? {recovery_required:true, recoveryError,
      next:'Repair the upgrade transaction journal before attempting recovery or resuming finalization.'} :
      closed ? {recovery_required:true, next:'Repair the reported failure, then run zylos upgrade --resume-finalize.'} :
      !ctx.preInstallProtection ? {next:'把 CLI 装回原版本，处理失败原因后再重新升级'} : {};
  return {...buildSelfUpgradeResult(ctx, failed, null, false), code:error.code, ...guidance,
    ...((error.next || guidance.next) ? {next:[error.next,guidance.next].filter(Boolean).join(' ')} : {})};
}

async function finalizeInstalledUpgrade(ctx, deps) {
  try {
    if (!ctx.budget) throw Error('finalizer budget is required');
    ctx.budget.check();
    (deps.assertDashboardUninstalled || assertDashboardUninstalled)(ctx.zylosDir);
    const hadCoreDashboard = fs.existsSync(path.join(ctx.zylosDir,'.claude/skills/dashboard/src/lib/schema-owner.js'));
    let manifest;
    if (ctx.preInstallProtection) {
      const m = maintenanceFor(ctx);
      const j = m.transaction(ctx.zylosDir, ctx.transactionDir);
      if (j.transactionId !== ctx.transactionId || j.installationIntent !== true || classifyCutoff(j) !== 'none' || j.phase !== 'installing') throw Error('invalid initial finalizer transaction');
      m.validateOriginalJournal(j, {completeBackups:true});
      manifest = loadSnapshotManifest(j, m);
      (deps.verifySnapshot || runCoreDbWorker)({action:'verify',zylosDir:ctx.zylosDir,dbBackupDir:j.dbBackupDir,manifest});
      ctx.journal=j;
      ctx.coreManifest=j.coreManifest;
      ctx.dbBackupDir=j.dbBackupDir;
      ctx.dbManifest=manifest;
      ctx.databaseMode=j.databaseMode || ctx.databaseMode;
      ctx.servicesWereRunning=j.originalServices.map(service=>service.name);
    }
    for (const [fn, options] of [[deps.syncSkills || step5_syncCoreSkills, deps.step5], [deps.installDependencies || step6_installSkillDeps, deps.step6]]) {
      ctx.budget.check();
      const result=await fn(ctx,options);
      ctx.steps.push(result);
      if(result.status==='failed') throw Object.assign(Error(result.error), {step:result.step});
    }
    ctx.budget.check();
    await (deps.prepareRuntimeClis || prepareUpgradeRuntimeClis)(ctx);
    ctx.budget.check();
    if (ctx.preInstallProtection) (deps.dataReady || protectedDataReady)(ctx,{deferPublication:true});
    else (deps.migrateDatabases || runCoreDbWorker)({action:'ordinary-migrate',zylosDir:ctx.zylosDir,schemaRoot:path.join(ctx.zylosDir,'.claude/skills'),formatVersion:1});
    ctx.budget.check();
    const prepared=await (deps.prepareRuntime || prepareUpgradeRuntime)(ctx);
    ctx.preparationWarnings=prepared.warnings;
    const workDir=ctx.preInstallProtection ? ctx.transactionDir : ctx.tempDir;
    if (!workDir) throw Error('finalizer preparation directory is unavailable');
    const preparation=(deps.stage || preparePostCutoff)({transactionDir:workDir,zylosDir:ctx.zylosDir,...prepared,ordinary:!ctx.preInstallProtection});
    ctx.firstDashboardTakeover=ctx.preInstallProtection ? manifest.formatVersion===1 : !hadCoreDashboard;
    if (ctx.preInstallProtection) {
      let dashboardInstall=null;
      if (ctx.firstDashboardTakeover) {
        let owner;
        try {owner=deps.dashboardOwner || await installedDashboardOwner(ctx);} catch {}
        let dbCopy={ok:false,error:{code:'DASHBOARD_UNAVAILABLE',message:'Dashboard owner is unavailable; legacy database was not copied.'}};
        if(owner) {
          try {ctx.budget.check();dbCopy=await owner.copyDashboardDb(ctx.zylosDir,ctx.transactionDir);}
          catch(error){dbCopy={ok:false,error:{code:error.code || 'COPY_FAILED',message:error.message}};}
        }
        dashboardInstall={formatVersion:1,classification:fs.existsSync(path.join(ctx.zylosDir,'components/dashboard/dashboard.db'))?'data_only':'absent',dbCopy,
          items:Object.fromEntries(['registration','route'].map(key=>[key,{state:'pending',attempts:0,lastError:null}]))};
      }
      ctx.budget.check();
      (deps.commitCutoff || commitCutoff)(ctx,{postCutoff:preparation,dashboardInstall});
      return await resumeUpgradeFinalization(ctx,deps);
    }
    ctx.dashboardCopy={state:'skipped',reason:'No protected transaction; legacy Dashboard database was not copied.'};
    const publication=await (deps.publishOrdinary || publishRuntimePreparation)({workDir,zylosDir:ctx.zylosDir,preparation},{checkBudget:()=>ctx.budget.check(),...deps.publication});
    if(!publication.ok) throw Object.assign(Error(publication.lastError?.reason || 'Core publication incomplete'), {code:publication.lastError?.code});
    ctx.publication=publication;
    ctx.settingsChanged=publishedSettingsChanged(preparation);
    return await completeUpgradeFinalization(ctx,deps);
  } catch(error) {return finalizationFailure(ctx,error,error.step);}
}

function publishedSettingsChanged(preparation) {
  return (preparation?.items?.hooks?.targets || []).some(target =>
    target.kind === 'claude_settings' && target.rule === 'replace' &&
    (!target.beforeExists || target.beforeSha256 !== target.stagedSha256));
}

/** Forward repair consumes only durable publication inputs, never migrations. */
export async function resumeUpgradeFinalization(ctx, deps = {}) {
  ctx.steps ||= [];
  ctx.preInstallProtection=true;
  ctx.from ||= ctx.journal.from;
  ctx.to ||= ctx.journal.to;
  ctx.servicesWereRunning ||= ctx.journal.originalServices.map(service=>service.name);
  ctx.mergeConflicts ||= [];
  ctx.mergedFiles ||= [];
  try {
    const m=maintenanceFor(ctx), j=ctx.journal;
    const manifest=ctx.dbManifest || loadSnapshotManifest(j, m);
    ctx.dbManifest=manifest;
    ctx.firstDashboardTakeover=manifest.formatVersion===1;
    const publication=await (deps.publish || publishPostCutoff)(ctx,{checkBudget:()=>ctx.budget.check(),...deps.publication});
    if(!publication.ok) throw Object.assign(Error(publication.lastError?.reason || 'Core publication incomplete'),{code:publication.lastError?.code});
    ctx.publication=publication;
    ctx.settingsChanged=publishedSettingsChanged(ctx.journal.postCutoff);
    return await completeUpgradeFinalization(ctx,deps);
  } catch(error) {return finalizationFailure(ctx,error);}
}

/**
 * Run the 13-step self-upgrade pipeline.
 * Template migration and Claude restart are handled by Claude after this completes.
 * Lock must be acquired by caller.
 *
 * @param {{ tempDir: string, newVersion: string, onStep?: function }} opts
 * @param {object} [deps] - Isolated self-upgrade seam for npm, PM2, version, rollback, and finalizer boundaries
 * @returns {object} Upgrade result
 */
export function runSelfUpgrade({ tempDir, newVersion, mode, onStep, retry, finalizeTimeoutMs = DEFAULT_FINALIZE_TIMEOUT_MS } = {}, deps = {}) {
  if (!Number.isInteger(finalizeTimeoutMs) || finalizeTimeoutMs < MIN_FINALIZE_TIMEOUT_MS || finalizeTimeoutMs > MAX_FINALIZE_TIMEOUT_MS) {
    return {action:'self_upgrade',success:false,code:'INVALID_ARGS',error:'finalize timeout must be an integer from 60000 to 3600000 milliseconds',steps:[],rollback:{performed:false,steps:[]}};
  }
  const ctx = createContext({ tempDir, newVersion, mode });
  ctx.dashboardRoot = deps.dashboardRoot;
  ctx.finalizeTimeoutMs = finalizeTimeoutMs;

  const getCurrentVersionFn = deps.getCurrentVersion ?? getCurrentVersion;
  const current = getCurrentVersionFn();
  if (current.success) {
    ctx.from = current.version;
  }
  ctx.to = newVersion || null;
  ctx.snapshotFormatVersion = 2;
  if (retry) {
    try {
      const selected = selectSameVersionRetry(deps.zylosDir ?? ZYLOS_DIR, ctx.from);
      if (ctx.from !== ctx.to || !selected || ['retryOf','effectiveFrom','snapshotFormatVersion'].some(key => selected[key] !== retry[key])) {
        throw Object.assign(Error('Latest restored retry base changed before upgrade admission'), {code:'RETRY_BASE_INVALID',transactionId:retry.retryOf,field:'retryOf',next:'Inspect the latest transaction and run the upgrade command again.'});
      }
      Object.assign(ctx, selected);
    } catch (error) {
      return {action:'retry',success:false,error:error.message,code:error.code,transactionId:error.transactionId,field:error.field,next:error.next,preInstallProtection:false,rollback:{attempted:false,completed:false,performed:false}};
    }
  }
  const platform = deps.platform ?? process.platform;
  const protectionSupported = deps.protectionSupported ?? (() => maintenance.platformSupported(platform));
  const eligible = protectionSupported();
  if (!deps.preInstallSteps) {
    try {
      const root = deps.zylosDir ?? ZYLOS_DIR;
      const prior = maintenance.discover(root);
      if (prior.candidates.length || prior.diagnostics.length || prior.marker) return {action:'self_upgrade',success:false,error:'unresolved prior upgrade transaction',preInstallProtection:false,rollback:{attempted:false,completed:false,performed:false},recovery_required:true};
      ctx.rehearsalCleanup=(deps.cleanupCoreDbRehearsals ?? cleanupCoreDbRehearsals)(root);
      ctx.databaseVersions=(deps.probeCoreDbVersions ?? probeCoreDbVersions)(root,ctx.tempDir,{driverRoot:deps.skillsDir ?? SKILLS_DIR,formatVersion:ctx.snapshotFormatVersion,dashboardRoot:deps.dashboardRoot});
      if (!ctx.databaseVersions || typeof ctx.databaseVersions.needsMigration !== 'boolean' || !Array.isArray(ctx.databaseVersions.databases) || ctx.databaseVersions.databases.length !== (ctx.snapshotFormatVersion === 1 ? 3 : 4)) throw Error('Invalid database version probe result');
      ctx.databaseMode=ctx.databaseVersions.needsMigration?'migrate':'unchanged';
      if (ctx.databaseMode === 'migrate') {
        ctx.databasePreflight=(deps.preflightCoreDbUpgrade ?? preflightCoreDbUpgrade)(root,{formatVersion:ctx.snapshotFormatVersion,dashboardRoot:deps.dashboardRoot});
        ctx.databaseRehearsal=(deps.rehearseCoreDbUpgrade ?? rehearseCoreDbUpgrade)(root,ctx.tempDir,{driverRoot:deps.skillsDir ?? SKILLS_DIR,formatVersion:ctx.snapshotFormatVersion,dashboardRoot:deps.dashboardRoot,onCleanup:cleanup=>ctx.rehearsalCleanup.removed.push(...cleanup.removed)});
      }
    }
    catch (error) { return {action:'self_upgrade',success:false,error:error.message,rehearsalCleanup:ctx.rehearsalCleanup || {removed:error.removedRehearsals || []},preInstallProtection:false,rollback:{attempted:false,completed:false,performed:false},recovery_required:false}; }
  }
  if (!deps.preInstallSteps && eligible) {
    try {
      maintenance.preflightExternalTools(platform);
      if (!deps.step4?.execSync) ctx.protectedNpmCli = resolveProtectedNpmCli();
    } catch (error) {
      return {action:'self_upgrade',success:false,error:error.message,rehearsalCleanup:ctx.rehearsalCleanup,preInstallProtection:false,rollback:{attempted:false,completed:false,performed:false},recovery_required:false};
    }
  }
  if(!deps.preInstallSteps && eligible) {
    try {beginUpgrade(ctx,{zylosDir:deps.zylosDir ?? ZYLOS_DIR,skillsDir:deps.skillsDir ?? SKILLS_DIR},deps.step3);}
    catch(error){return {action:'self_upgrade',success:false,error:error.message,rehearsalCleanup:ctx.rehearsalCleanup,preInstallProtection:false,rollback:{attempted:false,completed:false,performed:false},recovery_required:!!ctx.transactionDir};}
  } else if (!eligible && !deps.preInstallSteps) {
    try {beginBackupOnly(ctx,{zylosDir:deps.zylosDir ?? ZYLOS_DIR,skillsDir:deps.skillsDir ?? SKILLS_DIR});}
    catch(error){return {action:'self_upgrade',success:false,error:error.message,rehearsalCleanup:ctx.rehearsalCleanup,preInstallProtection:false,rollback:{attempted:false,completed:false,performed:false}};}
  }

  const preInstallSteps = deps.preInstallSteps ?? [
    (stepCtx) => step1_backupCoreSkills(stepCtx, deps.step1),
    step2_preUpgradeHook,
    (stepCtx) => step3_stopCoreServices(stepCtx, deps.step3),
    (stepCtx) => step4_npmInstallGlobal(stepCtx, deps.step4),
  ];

  const total = 13;
  let failedStep = null;

  for (const stepFn of preInstallSteps) {
    const result = stepFn(ctx);
    result.total = total;
    ctx.steps.push(result);
    if (onStep) onStep(result);

    if (result.status === 'failed') {
      failedStep = result;
      ctx.error = result.error;
      break;
    }
  }

  if (failedStep) {
    if(ctx.preInstallProtection) {const rb=recovery(ctx);return {...buildSelfUpgradeResult(ctx,failedStep),backupDir:ctx.backupDir,dbBackupDir:ctx.dbBackupDir,preInstallProtection:true,transactionDir:ctx.transactionDir,rollback:{...rb,performed:rb.attempted},recovery_required:rb.recovery_required};}
    if(ctx.backupOnly) return buildSelfUpgradeResult(ctx, failedStep, null, false);
    const rollbackFn = deps.rollbackSelf ?? rollbackSelf;
    const rollbackResults = rollbackFn(ctx);
    return buildSelfUpgradeResult(ctx, failedStep, rollbackResults);
  }

  try {
    const finalizerFn = deps.runInstalledFinalizer ?? runInstalledFinalizer;
    const finalizeResult = finalizerFn(ctx);
    const finalizeSteps = Array.isArray(finalizeResult.steps) ? finalizeResult.steps : [];
    for (const step of finalizeSteps) {
      ctx.steps.push(step);
      if (onStep) onStep(step);
    }
    if(ctx.preInstallProtection && finalizeResult.success===false){const rb=recovery(ctx);return {...finalizeResult,...backupOnlyResult(ctx,true),from:ctx.from,steps:ctx.steps,dbBackupDir:ctx.dbBackupDir,transactionDir:ctx.transactionDir,rollback:{...rb,performed:rb.attempted},recovery_required:rb.recovery_required};}
    ctx.releaseControl?.();ctx.releaseControl=null;
    return {
      ...finalizeResult,
      ...backupOnlyResult(ctx, finalizeResult.success === false),
      preInstallProtection:!!ctx.preInstallProtection,
      ...(ctx.protectionUnavailableReason ? {protectionUnavailableReason:ctx.protectionUnavailableReason} : {}),
      from: ctx.from,
      steps: ctx.steps,
      backupDir: finalizeResult.backupDir || ctx.backupDir,
      dbBackupDir:finalizeResult.dbBackupDir || ctx.dbBackupDir || null,
      databases:finalizeResult.databases || ctx.databasePreflight?.databases || ctx.dbManifest?.databases || null,
      ...(ctx.rehearsalCleanup ? {rehearsalCleanup:ctx.rehearsalCleanup} : {}),
    };
  } catch (err) {
    const error = err.stderr?.toString().trim() || err.message;
    failedStep = {
      step: 5,
      name: 'run_new_upgrade_finalizer',
      status: 'failed',
      error,
      total,
      duration: 0,
    };
    ctx.steps.push(failedStep);
    if (onStep) onStep(failedStep);
    if(ctx.preInstallProtection){const rb=recovery(ctx);return {...buildSelfUpgradeResult(ctx,failedStep),transactionDir:ctx.transactionDir,dbBackupDir:ctx.dbBackupDir,rollback:{...rb,performed:rb.attempted},recovery_required:rb.recovery_required};}
    return buildSelfUpgradeResult(ctx, failedStep, null, false);
  }
}

// ---------------------------------------------------------------------------
// Public: cleanupTemp
// ---------------------------------------------------------------------------

export function cleanupTemp(tempDir) {
  if (!tempDir || !fs.existsSync(tempDir)) return;

  let resolved;
  try { resolved = fs.realpathSync(tempDir); } catch { resolved = path.resolve(tempDir); }

  // Safety: only delete directories under allowed temp roots
  const allowedRoots = getAllowedTmpRoots();
  if (!allowedRoots.some(root => resolved.startsWith(root + '/'))) {
    console.error(`SAFETY: refusing to delete ${resolved} (not under any allowed temp root)`);
    return;
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
}

// Also clean up backup dirs after successful upgrade
export function cleanupBackup(backupDir) {
  if(!backupDir||!fs.existsSync(backupDir))return;
  const resolved=fs.realpathSync(backupDir);
  const roots=getAllowedTmpRoots();
  if(!roots.some(root=>resolved.startsWith(root+path.sep)&&path.basename(resolved).startsWith('zylos-core-backup-'))) {
    // Protected code cleanup is performed only by the verified transaction success path.
    return;
  }
  fs.rmSync(resolved,{recursive:true,force:true});
}
