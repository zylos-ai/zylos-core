/**
 * Self-upgrade logic for zylos-core itself.
 * Downloads new version via GitHub tarball, syncs Core Skills with
 * manifest-based preservation, and runs npm install -g from local path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { SKILLS_DIR, ZYLOS_DIR } from './config.js';
import { downloadArchive, downloadBranch } from './download.js';
import { generateManifest, saveMergeBaseline } from './manifest.js';
import { fetchRawFile, fetchLatestTag, compareSemverDesc, sanitizeError } from './github.js';
import { copyTree } from './fs-utils.js';
import { smartSync, formatMergeResult } from './smart-merge.js';
import { getAllowedTmpRoots } from './upgrade.js';
import { getCoreEcosystemPath, createPm2Helpers } from './pm2.js';

import { createRequire as createFinalizerRequire } from 'node:module';
const finalizerRequire=createFinalizerRequire(import.meta.url);
function requireFinalizerExit(dir,j,terminate){return finalizerRequire(path.join(dir,'finalizer.cjs')).quiesce(dir,j,{terminate});}

import { cleanupCoreDbRehearsals, preflightCoreDbUpgrade, probeCoreDbVersions, rehearseCoreDbUpgrade, runCoreDbWorker } from './core-db-backup.js';
import { recovery, protectedDataReady, protectedSuccess, maintenance, maintenanceFor } from './upgrade-protection.js';
import { loadSnapshotManifest } from './upgrade-snapshot-manifest.js';
import { updateZylosConfigLocked, readSessionMode } from './config.js';
import { createMigration } from './memory-migration.js';
import { requestRuntimeRestart } from './request-runtime-restart.js';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyCutoff, commitCutoff } from './upgrade-cutoff.js';
import { preparePostCutoff, publishPostCutoff, publishRuntimePreparation } from './upgrade-post-cutoff.js';
import { prepareUpgradeRuntime, prepareUpgradeRuntimeClis } from './upgrade-runtime-preparation.js';

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
  const skillsRoot=deps.skillsDir || ctx.journal?.skillsDir || SKILLS_DIR;
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

      if (!ctx.preInstallProtection || !ctx.transactionDir || !ctx.journal) throw Error('skill dependencies require a protected transaction');
      const original=ctx.coreManifest.find(item=>item.name===entry.name);
      if(original?.existedBefore && (!original.backedUp || !original.dependencies))throw Error('original skill dependency backup is incomplete');
      const modules=path.join(skillDir,'node_modules');
      let moduleStat;
      try {moduleStat=fs.lstatSync(modules);} catch(error) {if(error.code!=='ENOENT')throw error;}
      if(moduleStat && (!moduleStat.isDirectory() || moduleStat.isSymbolicLink())) throw Error('skill node_modules must be a real directory');
      const npmCli=ctx.protectedNpmCli || ctx.journal.originalPackage?.npmCli;
      maintenanceFor(ctx).runInstaller(ctx.transactionDir,ctx.journal,{
        stage:'skill-deps:'+entry.name,npmCli,args:['install','--omit=dev'],cwd:skillDir,timeout:180000,
      });
      installed++;
    } catch(error) {
      failed.push(entry.name+': '+error.message);
      // Preserve the failed installer's durable identity until recovery has
      // confirmed its descendants exited; another launch must not replace it.
      break;
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
  const maintenance = maintenanceFor(ctx);
  const fsApi = deps.fs ?? fs;
  const execute = deps.execSync ?? execSync;
  const exec = (command, options = {}) => {
    return execute(command, {...options,timeout:30000});
  };
  const restartFn = deps.restartManagedProcess ?? createPm2Helpers({exec}).restartManagedProcess;
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
        fallbackToPlainRestartOnError: false,
      });
      started.push(name);
    } catch {
      // A timed-out PM2 command may have committed its start before it died.
      try {
        const processes=JSON.parse(exec('pm2 jlist 2>/dev/null',{encoding:'utf8',stdio:'pipe'}));
        if(processes.some(item=>item.name===name && item.pm2_env?.status==='online')) started.push(name);
        else failed.push(name);
      } catch { failed.push(name); }
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
  const execute = deps.execSync ?? execSync;
  const TIMEOUT_MS = 30000;

  while (Date.now() - startTime < TIMEOUT_MS) {
    try {
      const remaining = Math.max(1,TIMEOUT_MS-(Date.now()-startTime));
      execute(`sleep ${Math.min(POLL_INTERVAL_MS,remaining)/1000}`, { stdio: 'pipe',timeout:remaining });
    } catch (error) { return {step:12,name:'verify_services',status:'failed',error:error.message,duration:Date.now()-startTime}; }

    try {
      const output = execute('pm2 jlist 2>/dev/null', { encoding: 'utf8',timeout:30000 });
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
// Public: runSelfUpgrade
// ---------------------------------------------------------------------------

function protectionResult(ctx) {
  return {automaticCompensation:true, automaticResume:maintenanceFor(ctx).canRecognizeProcesses(),
    databaseMode:ctx.databaseMode || 'migrate', dbSnapshotVerified:ctx.dbSnapshotVerified===true,
    databases:ctx.databases || ctx.databasePreflight?.databases || null};
}
function buildSelfUpgradeResult(ctx, failedStep, rollbackResults = null, rollbackPerformed = Boolean(rollbackResults)) {
  if (failedStep) {
    return {
      action: 'self_upgrade',
      success: false,
      ...protectionResult(ctx),
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
    ...protectionResult(ctx),
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
    schemaVersion: 2,
    ...(ctx.snapshotFormatVersion ? {snapshotFormatVersion:ctx.snapshotFormatVersion} : {}),
    ...(ctx.databaseMode ? {databaseMode:ctx.databaseMode} : {}),
    ...protectionResult(ctx),
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
    ...(typeof ctx.firstDashboardTakeover==='boolean' ? {firstDashboardTakeover:ctx.firstDashboardTakeover} : {}),
  };
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

export function readUpgradeModeStatus(zylosDir, {execute=execFileSync} = {}) {
  try {
    const output=execute(process.execPath,[path.join(import.meta.dirname,'../zylos.js'),'session-mode','status','--json'],{
      encoding:'utf8',stdio:'pipe',env:{...process.env,ZYLOS_DIR:zylosDir},
      timeout:5000
    });
    const result=JSON.parse(output);
    if(result?.ok!==true) throw Error('P10 status command did not succeed');
    return result;
  } catch(cause) {
    throw Object.assign(Error('P10 session-mode status is unavailable or could not be read.',{cause}),{code:'P10_STATUS_UNAVAILABLE'});
  }
}

function finalizationNext(ctx) {
  return maintenanceFor(ctx).canRecognizeProcesses?.()===false
    ? 'This platform cannot reliably recognize upgrade processes. Arrange manual recovery; do not replay database snapshots.'
    : 'Repair the reported failure, then run zylos upgrade --resume-finalize.';
}

/** Shared by initial finalization and forward repair after publication is done. */
export async function completeUpgradeFinalization(ctx, deps = {}) {
  const root=ctx.zylosDir || ZYLOS_DIR;
  const completion={install:'pending',dashboard:'degraded',sessionRestart:'manual_required',modeTransition:'unknown'};
  const steps=ctx.steps ||= [];
  const run=async (step,name,fn)=>{
    try {
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
      ...(ctx.preInstallProtection ? {recovery_required:true,next:finalizationNext(ctx)} : {next:'把 CLI 装回原版本，处理失败原因后再重新升级'})};
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
    dashboard=await owner.verifyDashboard({zylosDir:root});
  } catch(error) {dashboardFailure('dashboard',error);}
  dashboard={...dashboard,state:dashboardErrors.length?'degraded':dashboard?.state || 'degraded',errors:[...(dashboard?.errors || []),...dashboardErrors]};
  completion.dashboard=dashboard.state;
  ctx.dashboard=dashboard;
  try {
    const status=await (deps.readModeStatus || (()=>readUpgradeModeStatus(root)))();
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
    mode=await (deps.readMode || readSessionMode)();
    transition=await (deps.readTransition || (async()=> (await import('../../skills/comm-bridge/scripts/c4-db.js')).getModeTransition()))();
    const normalized=mode.mode===null ? {...mode,mode:'single'} : mode;
    if(!['single','multi'].includes(normalized.mode))throw Error('session mode is not available');
    const restart=await (deps.restart || requestRuntimeRestart)({afterServiceRestart:true,
      readMode:()=>normalized,readTransition:()=>transition});
    completion.sessionRestart=restart.ok ? (restart.data?.result==='exit_enqueued' ? 'single_exit_enqueued' : restart.data?.result || 'accepted') : 'manual_required';
    ctx.restart=restart;
  } catch(error) {ctx.restart={ok:false,error:{code:error.code || 'RESTART_UNAVAILABLE',message:error.message}};}
  try {
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
  if (state.schemaVersion !== 2 || state.preInstallProtection !== true) {
    return {
      action: 'self_upgrade',
      success: false,
      from: state.from || null,
      to: null,
      failedStep: 5,
      error: 'Finalization requires the protected target-upgrade transaction.',
      steps: [],
      rollback: { performed: false, steps: [] },
    };
  }

  const ctx = createContext({
    tempDir: state.tempDir,
    newVersion: state.newVersion || state.to,
    mode: state.mode,
  });
  ctx.databaseMode = 'migrate';
  ctx.preInstallProtection = true;
  ctx.zylosDir = deps.zylosDir || state.zylosDir || ZYLOS_DIR;
  ctx.maintenance = deps.maintenance;
  ctx.packageRoot = state.packageRoot;
  ctx.firstTakeover = state.firstTakeover === true;
  ctx.firstDashboardTakeover = state.firstDashboardTakeover;
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
  ctx.snapshotFormatVersion = state.snapshotFormatVersion ?? state.dbManifest?.formatVersion;
  ctx.to = state.to || state.newVersion || null;

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
      closed ? {recovery_required:true, next:finalizationNext(ctx)} :
      !ctx.preInstallProtection ? {next:'把 CLI 装回原版本，处理失败原因后再重新升级'} : {};
  return {...buildSelfUpgradeResult(ctx, failed, null, false), code:error.code, ...guidance,
    ...((error.next || guidance.next) ? {next:[error.next,guidance.next].filter(Boolean).join(' ')} : {})};
}

function needsDashboardTakeover(ctx) {
  const target = path.join(ctx.tempDir, 'skills/dashboard');
  try {
    if (!fs.lstatSync(target).isDirectory()) throw Error('Target Dashboard must be a directory');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const marker = path.join(ctx.journal.skillsDir, 'dashboard/.zylos/core-managed.json');
  try {
    if (!fs.lstatSync(marker).isFile()) throw Error('Dashboard core-managed marker must be a regular file');
    fs.accessSync(marker, fs.constants.R_OK);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw Object.assign(Error(`Cannot inspect Dashboard takeover marker: ${error.message}`), {
      code: 'DASHBOARD_TAKEOVER_INVALID',
    });
  }
}

async function finalizeInstalledUpgrade(ctx, deps) {
  try {
    (deps.assertDashboardUninstalled || assertDashboardUninstalled)(ctx.zylosDir);
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
      ctx.firstDashboardTakeover=needsDashboardTakeover(ctx);
      ctx.servicesWereRunning=j.originalServices.map(service=>service.name);
    }
    for (const [fn, options] of [[deps.syncSkills || step5_syncCoreSkills, deps.step5], [deps.installDependencies || step6_installSkillDeps, deps.step6]]) {
      const result=await fn(ctx,options);
      ctx.steps.push(result);
      if(result.status==='failed') throw Object.assign(Error(result.error), {step:result.step});
    }
    await (deps.prepareRuntimeClis || prepareUpgradeRuntimeClis)(ctx);
    (deps.dataReady || protectedDataReady)(ctx,{deferPublication:true});
    const prepared=await (deps.prepareRuntime || prepareUpgradeRuntime)(ctx);
    ctx.preparationWarnings=prepared.warnings;
    const workDir=ctx.transactionDir;
    if (!workDir) throw Error('finalizer preparation directory is unavailable');
    const preparation=(deps.stage || preparePostCutoff)({transactionDir:workDir,zylosDir:ctx.zylosDir,...prepared});
      let dashboardInstall=null;
      if (ctx.firstDashboardTakeover) {
        let owner;
        try {owner=deps.dashboardOwner || await installedDashboardOwner(ctx);} catch {}
        let dbCopy={ok:false,error:{code:'DASHBOARD_UNAVAILABLE',message:'Dashboard owner is unavailable; legacy database was not copied.'}};
        if(owner) {
          try {dbCopy=await owner.copyDashboardDb(ctx.zylosDir,ctx.transactionDir);}
          catch(error){dbCopy={ok:false,error:{code:error.code || 'COPY_FAILED',message:error.message}};}
        }
        dashboardInstall={formatVersion:1,classification:fs.existsSync(path.join(ctx.zylosDir,'components/dashboard/dashboard.db'))?'data_only':'absent',dbCopy,
          items:Object.fromEntries(['registration','route'].map(key=>[key,{state:'pending',attempts:0,lastError:null}]))};
      }
    (deps.commitCutoff || commitCutoff)(ctx,{postCutoff:preparation,dashboardInstall});
    return await resumeUpgradeFinalization(ctx,deps);
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
    ctx.firstDashboardTakeover=Boolean(j.dashboardInstall);
    const publication=await (deps.publish || publishPostCutoff)(ctx,deps.publication);
    if(!publication.ok) throw Object.assign(Error(publication.lastError?.reason || 'Core publication incomplete'),{code:publication.lastError?.code});
    ctx.publication=publication;
    ctx.settingsChanged=publishedSettingsChanged(ctx.journal.postCutoff);
    return await completeUpgradeFinalization(ctx,deps);
  } catch(error) {return finalizationFailure(ctx,error);}
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
