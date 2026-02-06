/**
 * Self-upgrade logic for zylos-core itself.
 * Downloads new version via GitHub tarball, syncs Core Skills with
 * manifest-based preservation, and runs npm install -g from local path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { SKILLS_DIR } from './config.js';
import { downloadArchive } from './download.js';
import { generateManifest, loadManifest, saveManifest } from './manifest.js';
import { fetchRawFile, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';

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
 * Get latest zylos-core version from GitHub (package.json on main branch).
 */
function getLatestVersion() {
  try {
    const content = fetchRawFile(REPO, 'package.json');
    const pkg = JSON.parse(content);
    return { success: true, version: pkg.version };
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
 * @returns {object} { success, hasUpdate, current, latest }
 */
export function checkForCoreUpdates() {
  const current = getCurrentVersion();
  if (!current.success) {
    return { success: false, error: 'version_not_found', message: current.error };
  }

  const latest = getLatestVersion();
  if (!latest.success) {
    return { success: false, error: 'remote_version_failed', message: latest.error };
  }

  return {
    success: true,
    hasUpdate: current.version !== latest.version,
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
export function downloadCoreToTemp(version) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-'));

  const result = downloadArchive(REPO, version, tempDir);
  if (!result.success) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { success: false, error: result.error };
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
 * Sync Core Skills from new version to SKILLS_DIR.
 * Uses manifest to detect user modifications and preserve them.
 *
 * Strategy:
 * - Unmodified files → overwrite with new version
 * - Modified files → keep user version
 * - New skill (not installed) → copy fresh
 * - New files in existing skill → add
 * - Deleted files in new version → keep user files
 *
 * @param {string} newSkillsSrc - Path to skills/ in downloaded temp dir
 * @returns {{ synced: string[], preserved: string[], added: string[], errors: string[] }}
 */
export function syncCoreSkills(newSkillsSrc) {
  const result = { synced: [], preserved: [], added: [], errors: [] };

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
      // New skill — copy entirely
      try {
        copyTree(srcDir, destDir);
        // Generate manifest for the newly copied skill
        const manifest = generateManifest(destDir);
        saveManifest(destDir, manifest);
        result.added.push(skillName);
      } catch (err) {
        result.errors.push(`${skillName}: ${err.message}`);
      }
      continue;
    }

    // Existing skill — sync file by file using manifest
    try {
      syncSkillFiles(srcDir, destDir, skillName, result);
    } catch (err) {
      result.errors.push(`${skillName}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Sync individual files within a skill directory.
 * Compares against saved manifest to detect user modifications.
 */
function syncSkillFiles(srcDir, destDir, skillName, result) {
  const savedManifest = loadManifest(destDir);
  const newManifest = generateManifest(srcDir);
  let currentManifest;
  if (savedManifest) {
    currentManifest = generateManifest(destDir);
  }

  let anyUpdated = false;

  for (const [relPath, newHash] of Object.entries(newManifest.files)) {
    const srcFile = path.join(srcDir, relPath);
    const destFile = path.join(destDir, relPath);

    if (!fs.existsSync(destFile)) {
      // New file — add it
      const destFileDir = path.dirname(destFile);
      fs.mkdirSync(destFileDir, { recursive: true });
      fs.copyFileSync(srcFile, destFile);
      anyUpdated = true;
      continue;
    }

    if (!savedManifest) {
      // No manifest — can't tell if user modified, skip (preserve)
      continue;
    }

    const savedHash = savedManifest.files[relPath];
    const currentHash = currentManifest.files[relPath];

    if (!savedHash) {
      // File didn't exist in previous manifest — user might have added it, skip
      continue;
    }

    if (currentHash === savedHash) {
      // User hasn't modified this file — safe to overwrite
      if (newHash !== currentHash) {
        fs.copyFileSync(srcFile, destFile);
        anyUpdated = true;
      }
    } else {
      // User modified this file — preserve their version
      if (!result.preserved.includes(skillName)) {
        result.preserved.push(skillName);
      }
    }
  }

  if (anyUpdated) {
    result.synced.push(skillName);
  }

  // Update manifest to reflect current state after sync
  const updatedManifest = generateManifest(destDir);
  saveManifest(destDir, updatedManifest);
}

// ---------------------------------------------------------------------------
// 8-step self-upgrade pipeline
// ---------------------------------------------------------------------------

/**
 * Create self-upgrade context.
 */
function createContext({ tempDir, newVersion } = {}) {
  const coreDir = path.join(import.meta.dirname, '..', '..');

  return {
    coreDir,
    tempDir: tempDir || null,
    newVersion: newVersion || null,
    // State tracking
    backupDir: null,
    servicesStopped: [],
    servicesWereRunning: [],
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
function step1_backupCoreSkills(ctx) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(os.tmpdir(), `zylos-core-backup-${timestamp}`);

  try {
    fs.mkdirSync(backupDir, { recursive: true });

    // Backup the skills directory (include .zylos manifests — needed for correct rollback)
    if (fs.existsSync(SKILLS_DIR)) {
      copyTree(SKILLS_DIR, path.join(backupDir, 'skills'), { excludes: ['node_modules'] });
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
function step2_preUpgradeHook(ctx) {
  const startTime = Date.now();
  // No core pre-upgrade hook yet — reserved for future
  return { step: 2, name: 'pre_upgrade_hook', status: 'skipped', duration: Date.now() - startTime };
}

/**
 * Step 3: stop core services
 */
function step3_stopCoreServices(ctx) {
  const startTime = Date.now();

  // Core services that might be running from zylos skills
  const coreServicePrefixes = ['zylos-scheduler', 'zylos-comm-bridge', 'zylos-activity-monitor'];

  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);

    for (const proc of processes) {
      if (coreServicePrefixes.some(prefix => proc.name === prefix) && proc.pm2_env?.status === 'online') {
        ctx.servicesWereRunning.push(proc.name);
        try {
          execSync(`pm2 stop ${proc.name} 2>/dev/null`, { stdio: 'pipe' });
          ctx.servicesStopped.push(proc.name);
        } catch {
          // Continue even if one service fails to stop
        }
      }
    }

    const msg = ctx.servicesStopped.length > 0 ? ctx.servicesStopped.join(', ') : 'none running';
    return { step: 3, name: 'stop_core_services', status: 'done', message: msg, duration: Date.now() - startTime };
  } catch {
    return { step: 3, name: 'stop_core_services', status: 'skipped', message: 'pm2 not available', duration: Date.now() - startTime };
  }
}

/**
 * Step 4: npm install -g from temp dir
 */
function step4_npmInstallGlobal(ctx) {
  const startTime = Date.now();

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 4, name: 'npm_install_global', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  try {
    // Install from local path — this updates the globally installed zylos package
    execSync(`npm install -g "${ctx.tempDir}"`, {
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
 * Step 5: sync Core Skills (preserve user modifications)
 */
function step5_syncCoreSkills(ctx) {
  const startTime = Date.now();

  const newSkillsSrc = path.join(ctx.tempDir, 'skills');
  if (!fs.existsSync(newSkillsSrc)) {
    return { step: 5, name: 'sync_core_skills', status: 'skipped', message: 'no skills in new version', duration: Date.now() - startTime };
  }

  try {
    const syncResult = syncCoreSkills(newSkillsSrc);
    const parts = [];
    if (syncResult.synced.length) parts.push(`${syncResult.synced.length} synced`);
    if (syncResult.added.length) parts.push(`${syncResult.added.length} added`);
    if (syncResult.preserved.length) parts.push(`${syncResult.preserved.length} preserved`);
    if (syncResult.errors.length) parts.push(`${syncResult.errors.length} errors`);
    const msg = parts.join(', ') || 'no changes';

    if (syncResult.errors.length > 0) {
      return { step: 5, name: 'sync_core_skills', status: 'failed', error: syncResult.errors.join('; '), duration: Date.now() - startTime };
    }

    return { step: 5, name: 'sync_core_skills', status: 'done', message: msg, duration: Date.now() - startTime };
  } catch (err) {
    return { step: 5, name: 'sync_core_skills', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 6: post-upgrade hook (placeholder for future use)
 */
function step6_postUpgradeHook(ctx) {
  const startTime = Date.now();
  // No core post-upgrade hook yet — reserved for future
  return { step: 6, name: 'post_upgrade_hook', status: 'skipped', duration: Date.now() - startTime };
}

/**
 * Step 7: start core services
 */
function step7_startCoreServices(ctx) {
  const startTime = Date.now();

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 7, name: 'start_core_services', status: 'skipped', message: 'no services to restart', duration: Date.now() - startTime };
  }

  const started = [];
  const failed = [];

  for (const name of ctx.servicesWereRunning) {
    try {
      execSync(`pm2 restart ${name} 2>/dev/null`, { stdio: 'pipe' });
      started.push(name);
    } catch {
      failed.push(name);
    }
  }

  if (failed.length > 0) {
    return { step: 7, name: 'start_core_services', status: 'failed', error: `Failed to restart: ${failed.join(', ')}`, duration: Date.now() - startTime };
  }

  return { step: 7, name: 'start_core_services', status: 'done', message: started.join(', '), duration: Date.now() - startTime };
}

/**
 * Step 8: verify services
 */
function step8_verifyServices(ctx) {
  const startTime = Date.now();

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 8, name: 'verify_services', status: 'skipped', message: 'no services to verify', duration: Date.now() - startTime };
  }

  // Brief wait for services to start
  const waitUntil = Date.now() + 2000;
  while (Date.now() < waitUntil) { /* busy wait */ }

  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);

    const notOnline = [];
    for (const name of ctx.servicesWereRunning) {
      const proc = processes.find(p => p.name === name);
      if (!proc || proc.pm2_env?.status !== 'online') {
        notOnline.push(name);
      }
    }

    if (notOnline.length > 0) {
      return { step: 8, name: 'verify_services', status: 'failed', error: `Not online: ${notOnline.join(', ')}`, duration: Date.now() - startTime };
    }

    return { step: 8, name: 'verify_services', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 8, name: 'verify_services', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Rollback from backup.
 */
function rollbackSelf(ctx) {
  const results = [];

  // Restore Core Skills from backup (include .zylos manifests to keep them in sync with files)
  if (ctx.backupDir && fs.existsSync(path.join(ctx.backupDir, 'skills'))) {
    try {
      syncTree(path.join(ctx.backupDir, 'skills'), SKILLS_DIR, { excludes: ['node_modules'] });
      results.push({ action: 'restore_core_skills', success: true });
    } catch (err) {
      results.push({ action: 'restore_core_skills', success: false, error: err.message });
    }
  }

  // Restart services if they were running
  for (const name of ctx.servicesWereRunning) {
    try {
      execSync(`pm2 restart ${name} 2>/dev/null || true`, { stdio: 'pipe' });
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

/**
 * Run the 8-step self-upgrade pipeline.
 * Lock must be acquired by caller.
 *
 * @param {{ tempDir: string, newVersion: string }} opts
 * @returns {object} Upgrade result
 */
export function runSelfUpgrade({ tempDir, newVersion } = {}) {
  const ctx = createContext({ tempDir, newVersion });

  const current = getCurrentVersion();
  if (current.success) {
    ctx.from = current.version;
  }
  ctx.to = newVersion || null;

  const steps = [
    step1_backupCoreSkills,
    step2_preUpgradeHook,
    step3_stopCoreServices,
    step4_npmInstallGlobal,
    step5_syncCoreSkills,
    step6_postUpgradeHook,
    step7_startCoreServices,
    step8_verifyServices,
  ];

  let failedStep = null;

  for (const stepFn of steps) {
    const result = stepFn(ctx);
    ctx.steps.push(result);

    if (result.status === 'failed') {
      failedStep = result;
      ctx.error = result.error;
      break;
    }
  }

  // If failed, rollback
  if (failedStep) {
    const rollbackResults = rollbackSelf(ctx);
    return {
      action: 'self_upgrade',
      success: false,
      from: ctx.from,
      to: null,
      failedStep: failedStep.step,
      error: failedStep.error,
      steps: ctx.steps,
      rollback: { performed: true, steps: rollbackResults },
    };
  }

  return {
    action: 'self_upgrade',
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
  };
}

// ---------------------------------------------------------------------------
// Public: cleanupTemp
// ---------------------------------------------------------------------------

export function cleanupTemp(tempDir) {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Also clean up backup dirs after successful upgrade
export function cleanupBackup(backupDir) {
  if (backupDir && fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}
