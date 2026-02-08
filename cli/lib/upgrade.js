/**
 * Core upgrade logic for components.
 * Uses GitHub archive tarballs and filesystem-based backup/rollback.
 * Zero git dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { SKILLS_DIR, COMPONENTS_DIR } from './config.js';
import { loadComponents } from './components.js';
import { loadLocalRegistry } from './registry.js';
import { parseSkillMd } from './skill.js';
import { generateManifest, saveManifest } from './manifest.js';
import { downloadArchive, downloadBranch } from './download.js';
import { fetchLatestTag, fetchRawFile, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Read the local version from SKILL.md frontmatter, falling back to package.json.
 */
function getLocalVersion(skillDir) {
  // Primary: SKILL.md frontmatter
  const parsed = parseSkillMd(skillDir);
  if (parsed?.frontmatter?.version) {
    return { success: true, version: String(parsed.frontmatter.version) };
  }
  // Fallback: package.json
  const pkgPath = path.join(skillDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version) {
      return { success: true, version: String(pkg.version) };
    }
  } catch {
    // package.json doesn't exist or is invalid
  }
  return { success: false, error: 'Version not found in SKILL.md or package.json' };
}

/**
 * Get the repo for a component from components.json or registry.
 */
function getRepo(component) {
  const components = loadComponents();
  if (components[component]?.repo) return components[component].repo;
  const registry = loadLocalRegistry();
  if (registry[component]?.repo) return registry[component].repo;
  return null;
}

/**
 * Get the latest version from GitHub (latest tag).
 * Falls back to fetching SKILL.md from GitHub if no tags found.
 */
function getLatestVersion(component, repo) {
  if (!repo) return { success: false, error: 'No repo configured for component' };

  // Primary: fetch latest tag from GitHub
  const tagVersion = fetchLatestTag(repo);
  if (tagVersion) {
    return { success: true, version: tagVersion };
  }

  // Fallback: fetch raw SKILL.md from GitHub
  try {
    const content = fetchRawFile(repo, 'SKILL.md');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (match) {
      const versionMatch = match[1].match(/^version:\s*(.+)$/m);
      if (versionMatch) {
        return { success: true, version: versionMatch[1].trim() };
      }
    }
    return { success: false, error: 'Version not found in remote SKILL.md' };
  } catch (err) {
    return { success: false, error: `Cannot fetch remote: ${sanitizeError(err.message)}` };
  }
}

// ---------------------------------------------------------------------------
// Public: checkForUpdates
// ---------------------------------------------------------------------------

/**
 * Check if a component has updates available.
 * Uses registry lookup (fast, no HTTP) with fallback to GitHub raw SKILL.md.
 *
 * @param {string} component
 * @returns {object} { success, hasUpdate, current, latest, repo }
 */
export function checkForUpdates(component) {
  const skillDir = path.join(SKILLS_DIR, component);

  if (!fs.existsSync(skillDir)) {
    return {
      success: false,
      error: 'component_not_found',
      message: `Component '${component}' is not installed`,
    };
  }

  const localVersion = getLocalVersion(skillDir);
  if (!localVersion.success) {
    return {
      success: false,
      error: 'version_not_found',
      message: `Cannot read current version: ${localVersion.error}`,
    };
  }

  const repo = getRepo(component);
  const latest = getLatestVersion(component, repo);
  if (!latest.success) {
    return {
      success: false,
      error: 'remote_version_failed',
      message: `Cannot determine latest version: ${latest.error}`,
    };
  }

  const hasUpdate = localVersion.version !== latest.version;

  return {
    success: true,
    hasUpdate,
    current: localVersion.version,
    latest: latest.version,
    repo,
  };
}

// ---------------------------------------------------------------------------
// Public: downloadToTemp
// ---------------------------------------------------------------------------

/**
 * Download a component version to a temp directory.
 *
 * @param {string} repo - GitHub repo (org/name)
 * @param {string} version - Version to download
 * @returns {{ success: boolean, tempDir?: string, error?: string }}
 */
export function downloadToTemp(repo, version) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-'));

  const result = downloadArchive(repo, version, tempDir);
  if (!result.success) {
    // Fallback: try downloading main branch
    const branchResult = downloadBranch(repo, 'main', tempDir);
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
 *
 * @param {string} dir - Directory containing CHANGELOG.md
 * @returns {string|null}
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

/**
 * Filter changelog to only show entries between two versions.
 * Expects standard format: ## [version] or ## version headers.
 *
 * @param {string} changelog - Full changelog text
 * @param {string} fromVersion - Current installed version (excluded)
 * @returns {string|null} Filtered changelog or null if parsing fails
 */
export function filterChangelog(changelog, fromVersion) {
  if (!changelog || !fromVersion) return changelog;

  const lines = changelog.split('\n');
  const result = [];
  let capturing = false;
  let foundHeaders = false;
  let done = false;

  // Match ## headers containing version numbers: "## [1.0.0]", "## 1.0.0", "## v1.0.0 - date"
  const versionHeaderRe = /^##\s+\[?v?(\d+\.\d+[^\]\s]*)\]?/;

  for (const line of lines) {
    if (done) break;

    const match = line.match(versionHeaderRe);
    if (match) {
      foundHeaders = true;
      const headerVersion = match[1].replace(/^v/, '');
      // Stop when we reach the installed version (already known)
      if (headerVersion === fromVersion) {
        done = true;
        continue;
      }
      // Capture everything from the newest version down to (but not including) fromVersion
      capturing = true;
    }

    if (capturing) {
      result.push(line);
    }
  }

  if (!foundHeaders) return changelog; // Couldn't parse headers, return full text
  return result.join('\n').trim() || null;
}

// ---------------------------------------------------------------------------
// Public: cleanupTemp
// ---------------------------------------------------------------------------

/**
 * Remove a temp directory.
 *
 * @param {string} tempDir
 */
export function cleanupTemp(tempDir) {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Internal: create upgrade context
// ---------------------------------------------------------------------------

function createContext(component, { tempDir, newVersion } = {}) {
  const skillDir = path.join(SKILLS_DIR, component);
  const dataDir = path.join(COMPONENTS_DIR, component);

  return {
    component,
    skillDir,
    dataDir,
    tempDir: tempDir || null,
    newVersion: newVersion || null,
    // State tracking
    backupDir: null,
    serviceStopped: false,
    serviceExists: true,
    serviceWasRunning: false,
    // Results
    steps: [],
    from: null,
    to: null,
    success: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// 8-step upgrade pipeline
// ---------------------------------------------------------------------------

/**
 * Step 1: pre-upgrade hook
 */
function step1_preUpgradeHook(ctx) {
  const startTime = Date.now();
  const hookPath = path.join(ctx.skillDir, 'hooks', 'pre-upgrade.js');

  if (!fs.existsSync(hookPath)) {
    return { step: 1, name: 'pre_upgrade_hook', status: 'skipped', duration: Date.now() - startTime };
  }

  try {
    execSync(`node "${hookPath}"`, {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ZYLOS_COMPONENT: ctx.component,
        ZYLOS_SKILL_DIR: ctx.skillDir,
        ZYLOS_DATA_DIR: ctx.dataDir,
      },
    });
    return { step: 1, name: 'pre_upgrade_hook', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 1, name: 'pre_upgrade_hook', status: 'failed', error: err.stderr?.trim() || err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 2: stop PM2 service
 */
function step2_stopService(ctx) {
  const startTime = Date.now();
  const parsed = parseSkillMd(ctx.skillDir);
  const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;

  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const service = processes.find(p => p.name === serviceName);

    if (!service) {
      ctx.serviceExists = false;
      return { step: 2, name: 'stop_service', status: 'skipped', message: 'no service', duration: Date.now() - startTime };
    }

    ctx.serviceExists = true;
    ctx.serviceWasRunning = service.pm2_env?.status === 'online';

    if (!ctx.serviceWasRunning) {
      return { step: 2, name: 'stop_service', status: 'skipped', message: 'not running', duration: Date.now() - startTime };
    }

    execSync(`pm2 stop ${serviceName} 2>/dev/null`, { stdio: 'pipe' });
    ctx.serviceStopped = true;

    return { step: 2, name: 'stop_service', status: 'done', message: serviceName, duration: Date.now() - startTime };
  } catch {
    return { step: 2, name: 'stop_service', status: 'skipped', message: 'pm2 not available', duration: Date.now() - startTime };
  }
}

/**
 * Step 3: filesystem backup to .backup/<timestamp>/
 */
function step3_backup(ctx) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(ctx.skillDir, '.backup', timestamp);

  try {
    copyTree(ctx.skillDir, backupDir, { excludes: ['node_modules', '.backup', '.zylos'] });

    ctx.backupDir = backupDir;
    return { step: 3, name: 'backup', status: 'done', message: path.basename(backupDir), duration: Date.now() - startTime };
  } catch (err) {
    return { step: 3, name: 'backup', status: 'failed', error: `Backup failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 4: copy new files from temp dir to skill dir
 */
function step4_copyNewFiles(ctx) {
  const startTime = Date.now();

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 4, name: 'copy_new_files', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  // Exclude list: always exclude meta dirs, plus lifecycle.preserve entries
  const excludes = ['node_modules', '.backup', '.zylos'];

  // Read preserve list from the NEW SKILL.md (in tempDir)
  const newParsed = parseSkillMd(ctx.tempDir);
  const preserveList = newParsed?.frontmatter?.lifecycle?.preserve || [];
  for (const entry of preserveList) {
    excludes.push(entry);
  }

  try {
    syncTree(ctx.tempDir, ctx.skillDir, { excludes });
    return { step: 4, name: 'copy_new_files', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 4, name: 'copy_new_files', status: 'failed', error: `Copy failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 5: npm install
 */
function step5_npmInstall(ctx) {
  const startTime = Date.now();
  const packageJson = path.join(ctx.skillDir, 'package.json');

  if (!fs.existsSync(packageJson)) {
    return { step: 5, name: 'npm_install', status: 'skipped', message: 'no package.json', duration: Date.now() - startTime };
  }

  try {
    execSync('npm install --omit=dev', {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { step: 5, name: 'npm_install', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 5, name: 'npm_install', status: 'failed', error: err.stderr?.trim() || err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 6: generate manifest
 */
function step6_generateManifest(ctx) {
  const startTime = Date.now();

  try {
    const manifest = generateManifest(ctx.skillDir);
    saveManifest(ctx.skillDir, manifest);
    return { step: 6, name: 'generate_manifest', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 6, name: 'generate_manifest', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 7: post-upgrade hook
 */
function step7_postUpgradeHook(ctx) {
  const startTime = Date.now();
  const hookPath = path.join(ctx.skillDir, 'hooks', 'post-upgrade.js');

  if (!fs.existsSync(hookPath)) {
    return { step: 7, name: 'post_upgrade_hook', status: 'skipped', duration: Date.now() - startTime };
  }

  try {
    execSync(`node "${hookPath}"`, {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ZYLOS_COMPONENT: ctx.component,
        ZYLOS_SKILL_DIR: ctx.skillDir,
        ZYLOS_DATA_DIR: ctx.dataDir,
      },
    });
    return { step: 7, name: 'post_upgrade_hook', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 7, name: 'post_upgrade_hook', status: 'failed', error: err.stderr?.trim() || err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 8: start service and verify
 *
 * Three cases:
 * - Service was running before upgrade → restart it
 * - Service exists in PM2 but was stopped → leave it stopped (user intent)
 * - Service not registered in PM2 but SKILL.md declares one → start it
 */
function step8_startAndVerify(ctx) {
  const startTime = Date.now();

  // Read service config from SKILL.md
  const parsed = parseSkillMd(ctx.skillDir);
  const serviceConfig = parsed?.frontmatter?.lifecycle?.service;
  const serviceName = serviceConfig?.name || `zylos-${ctx.component}`;

  // Case: service was stopped but still registered — leave it stopped
  if (ctx.serviceExists && !ctx.serviceWasRunning) {
    return { step: 8, name: 'start_and_verify', status: 'skipped', message: 'service was stopped', duration: Date.now() - startTime };
  }

  // Case: service not registered in PM2 and no service declared in SKILL.md — skip
  if (!ctx.serviceWasRunning && !serviceConfig) {
    return { step: 8, name: 'start_and_verify', status: 'skipped', message: 'no service configured', duration: Date.now() - startTime };
  }

  try {
    if (!ctx.serviceExists && serviceConfig) {
      // Service not in PM2 but declared in SKILL.md — start fresh
      const ecosystemPath = path.join(ctx.skillDir, 'ecosystem.config.cjs');
      if (fs.existsSync(ecosystemPath)) {
        // Use ecosystem config (custom PM2 options)
        execSync(`pm2 start "${ecosystemPath}"`, { cwd: ctx.skillDir, stdio: 'pipe' });
      } else if (serviceConfig.entry) {
        // Use entry point from SKILL.md
        const entryPath = path.join(ctx.skillDir, serviceConfig.entry);
        execSync(`pm2 start "${entryPath}" --name "${serviceName}"`, { stdio: 'pipe' });
      } else {
        return { step: 8, name: 'start_and_verify', status: 'skipped', message: 'no entry point', duration: Date.now() - startTime };
      }
      execSync('pm2 save 2>/dev/null', { stdio: 'pipe' });
    } else {
      // Service was running — restart it
      execSync(`pm2 restart ${serviceName} 2>/dev/null`, { stdio: 'pipe' });
    }

    // Poll for service status (max 5 attempts, 500ms apart)
    let service = null;
    for (let i = 0; i < 5; i++) {
      const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
      const processes = JSON.parse(output);
      service = processes.find(p => p.name === serviceName);

      if (service?.pm2_env?.status === 'online') break;

      const waitUntil = Date.now() + 500;
      while (Date.now() < waitUntil) { /* busy wait */ }
    }

    if (!service || service.pm2_env?.status !== 'online') {
      return { step: 8, name: 'start_and_verify', status: 'failed', error: 'Service startup verification failed', duration: Date.now() - startTime };
    }

    ctx.serviceStopped = false;
    return { step: 8, name: 'start_and_verify', status: 'done', message: serviceName, duration: Date.now() - startTime };
  } catch (err) {
    return { step: 8, name: 'start_and_verify', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

// ---------------------------------------------------------------------------
// Public: rollback
// ---------------------------------------------------------------------------

/**
 * Rollback from .backup/ directory.
 *
 * @param {object} ctx - Upgrade context
 * @returns {object[]} Array of rollback action results
 */
export function rollback(ctx) {
  const results = [];

  // Restore files from backup (--delete removes files added by the failed upgrade)
  if (ctx.backupDir && fs.existsSync(ctx.backupDir)) {
    try {
      syncTree(ctx.backupDir, ctx.skillDir, { excludes: ['node_modules', '.backup', '.zylos'] });
      results.push({ action: 'restore_files', success: true });
    } catch (err) {
      results.push({ action: 'restore_files', success: false, error: err.message });
    }

    // Restore dependencies
    const packageJson = path.join(ctx.skillDir, 'package.json');
    if (fs.existsSync(packageJson)) {
      try {
        execSync('npm install --omit=dev', {
          cwd: ctx.skillDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        results.push({ action: 'restore_dependencies', success: true });
      } catch (err) {
        results.push({ action: 'restore_dependencies', success: false, error: err.message });
      }
    }
  }

  // Restart service if it was running
  if (ctx.serviceWasRunning) {
    const parsed = parseSkillMd(ctx.skillDir);
    const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;
    try {
      execSync(`pm2 restart ${serviceName} 2>/dev/null || true`, { stdio: 'pipe' });
      results.push({ action: 'restart_service', success: true });
    } catch (err) {
      results.push({ action: 'restart_service', success: false, error: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public: runUpgrade
// ---------------------------------------------------------------------------

/**
 * Run the 8-step upgrade pipeline.
 * Lock must be acquired by caller (component.js).
 *
 * @param {string} component
 * @param {{ tempDir: string, newVersion: string }} opts
 * @returns {object} Upgrade result
 */
export function runUpgrade(component, { tempDir, newVersion, onStep } = {}) {
  const ctx = createContext(component, { tempDir, newVersion });

  if (!fs.existsSync(ctx.skillDir)) {
    return {
      action: 'upgrade',
      component,
      success: false,
      error: `Component directory not found: ${ctx.skillDir}`,
      steps: [],
    };
  }

  // Record current version
  const localVersion = getLocalVersion(ctx.skillDir);
  if (localVersion.success) {
    ctx.from = localVersion.version;
  }
  ctx.to = newVersion || null;

  const steps = [
    step1_preUpgradeHook,
    step2_stopService,
    step3_backup,
    step4_copyNewFiles,
    step5_npmInstall,
    step6_generateManifest,
    step7_postUpgradeHook,
    step8_startAndVerify,
  ];

  const total = steps.length;
  let failedStep = null;

  for (const stepFn of steps) {
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

  // If failed, rollback
  if (failedStep) {
    const rollbackResults = rollback(ctx);
    return {
      action: 'upgrade',
      component,
      success: false,
      from: ctx.from,
      to: null,
      failedStep: failedStep.step,
      error: failedStep.error,
      steps: ctx.steps,
      rollback: { performed: true, steps: rollbackResults },
    };
  }

  // Success — read the new version from the updated SKILL.md
  const updatedVersion = getLocalVersion(ctx.skillDir);
  if (updatedVersion.success) {
    ctx.to = updatedVersion.version;
  }

  return {
    action: 'upgrade',
    component,
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
  };
}
