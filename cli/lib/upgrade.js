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
import { generateManifest, saveManifest, saveOriginals } from './manifest.js';
import { downloadArchive, downloadBranch } from './download.js';
import { fetchLatestTag, fetchRawFile, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';
import { applyCaddyRoutes } from './caddy.js';
import { smartSync, formatMergeResult } from './smart-merge.js';

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
export function getRepo(component) {
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
  try {
    const tagVersion = fetchLatestTag(repo);
    if (tagVersion) {
      return { success: true, version: tagVersion };
    }
  } catch {
    // Network/API error — fall through to SKILL.md fallback
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
 * @param {string} [branch] - Optional branch to download from (skips version tag)
 * @returns {{ success: boolean, tempDir?: string, error?: string }}
 */
export function downloadToTemp(repo, version, branch) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-upgrade-'));

  if (branch) {
    const branchResult = downloadBranch(repo, branch, tempDir);
    if (!branchResult.success) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { success: false, error: branchResult.error };
    }
    return { success: true, tempDir };
  }

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

// ---------------------------------------------------------------------------
// 5-step upgrade pipeline
// ---------------------------------------------------------------------------

/**
 * Step 1: stop PM2 service
 */
function step1_stopService(ctx) {
  const startTime = Date.now();
  const parsed = parseSkillMd(ctx.skillDir);
  const serviceName = parsed?.frontmatter?.lifecycle?.service?.name || `zylos-${ctx.component}`;

  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(output);
    const service = processes.find(p => p.name === serviceName);

    if (!service) {
      ctx.serviceExists = false;
      return { step: 1, name: 'stop_service', status: 'skipped', message: 'no service', duration: Date.now() - startTime };
    }

    ctx.serviceExists = true;
    ctx.serviceWasRunning = service.pm2_env?.status === 'online';

    if (!ctx.serviceWasRunning) {
      return { step: 1, name: 'stop_service', status: 'skipped', message: 'not running', duration: Date.now() - startTime };
    }

    execSync(`pm2 stop ${serviceName} 2>/dev/null`, { stdio: 'pipe' });
    ctx.serviceStopped = true;

    return { step: 1, name: 'stop_service', status: 'done', message: serviceName, duration: Date.now() - startTime };
  } catch {
    return { step: 1, name: 'stop_service', status: 'skipped', message: 'pm2 not available', duration: Date.now() - startTime };
  }
}

/**
 * Step 2: filesystem backup to .backup/<timestamp>/
 */
function step2_backup(ctx) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(ctx.skillDir, '.backup', timestamp);

  try {
    copyTree(ctx.skillDir, backupDir, { excludes: ['node_modules', '.backup', '.zylos'] });

    ctx.backupDir = backupDir;
    return { step: 2, name: 'backup', status: 'done', message: path.basename(backupDir), duration: Date.now() - startTime };
  } catch (err) {
    return { step: 2, name: 'backup', status: 'failed', error: `Backup failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 3: smart merge new files into skill dir
 *
 * Uses three-way merge when possible:
 * - Local unmodified → overwrite
 * - Local modified + new unchanged → keep local
 * - Both changed → diff3 merge or overwrite + backup local
 */
function step3_smartMerge(ctx) {
  const startTime = Date.now();

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 3, name: 'smart_merge', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  try {
    const conflictBackupDir = ctx.backupDir ? path.join(ctx.backupDir, 'conflicts') : null;
    const mergeResult = smartSync(ctx.tempDir, ctx.skillDir, {
      label: ctx.component,
      backupDir: conflictBackupDir,
    });

    // Store merge info on context for final result
    ctx.mergeConflicts = mergeResult.conflicts;
    ctx.mergedFiles = mergeResult.merged;

    const msg = formatMergeResult(mergeResult);

    if (mergeResult.errors.length > 0) {
      return { step: 3, name: 'smart_merge', status: 'failed', error: mergeResult.errors.join('; '), duration: Date.now() - startTime };
    }

    // Delete files that were in the old version but removed in the new version.
    // Only delete files tracked in the old manifest — user-added files are preserved.
    const oldManifest = mergeResult._oldManifest;
    if (oldManifest) {
      const newFiles = new Set(Object.keys(generateManifest(ctx.tempDir).files));
      for (const file of Object.keys(oldManifest)) {
        if (!newFiles.has(file)) {
          const destFile = path.join(ctx.skillDir, file);
          try {
            fs.unlinkSync(destFile);
            // Clean up empty parent directories
            let dir = path.dirname(destFile);
            while (dir !== ctx.skillDir) {
              const entries = fs.readdirSync(dir);
              if (entries.length > 0) break;
              fs.rmdirSync(dir);
              dir = path.dirname(dir);
            }
          } catch {
            // Ignore deletion errors
          }
        }
      }
    }

    return { step: 3, name: 'smart_merge', status: 'done', message: msg, duration: Date.now() - startTime };
  } catch (err) {
    return { step: 3, name: 'smart_merge', status: 'failed', error: `Merge failed: ${err.message}`, duration: Date.now() - startTime };
  }
}

/**
 * Step 4: npm install
 */
function step4_npmInstall(ctx) {
  const startTime = Date.now();
  const packageJson = path.join(ctx.skillDir, 'package.json');

  if (!fs.existsSync(packageJson)) {
    return { step: 4, name: 'npm_install', status: 'skipped', message: 'no package.json', duration: Date.now() - startTime };
  }

  try {
    execSync('npm install --omit=dev', {
      cwd: ctx.skillDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { step: 4, name: 'npm_install', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 4, name: 'npm_install', status: 'failed', error: err.stderr?.trim() || err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 5: generate manifest
 */
function step5_generateManifest(ctx) {
  const startTime = Date.now();

  try {
    const manifest = generateManifest(ctx.skillDir);
    saveManifest(ctx.skillDir, manifest);
    return { step: 5, name: 'generate_manifest', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 5, name: 'generate_manifest', status: 'failed', error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 6: update Caddy routes (if http_routes declared in SKILL.md)
 */
function step6_updateCaddyRoutes(ctx) {
  const startTime = Date.now();
  const parsed = parseSkillMd(ctx.skillDir);
  const httpRoutes = parsed?.frontmatter?.http_routes;

  if (!httpRoutes || !Array.isArray(httpRoutes) || httpRoutes.length === 0) {
    return { step: 6, name: 'caddy_routes', status: 'skipped', message: 'no http_routes', duration: Date.now() - startTime };
  }

  const result = applyCaddyRoutes(ctx.component, httpRoutes);
  if (result.success) {
    return { step: 6, name: 'caddy_routes', status: 'done', message: result.action, duration: Date.now() - startTime };
  }
  // Caddy failures are non-fatal for upgrades
  return { step: 6, name: 'caddy_routes', status: 'skipped', message: result.error, duration: Date.now() - startTime };
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
 * Run the 6-step upgrade pipeline (mechanical operations only).
 * Hooks and service management are handled by Claude after this completes.
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
    step1_stopService,
    step2_backup,
    step3_smartMerge,
    step4_npmInstall,
    step5_generateManifest,
    step6_updateCaddyRoutes,
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

  // Success — read the new version and SKILL.md metadata
  const updatedVersion = getLocalVersion(ctx.skillDir);
  if (updatedVersion.success) {
    ctx.to = updatedVersion.version;
  }

  // Include SKILL.md metadata for Claude (hooks, config, service info)
  const skillMeta = parseSkillMd(ctx.skillDir);
  const fm = skillMeta?.frontmatter || {};
  const lifecycle = fm.lifecycle || {};
  const hooks = lifecycle.hooks || {};
  const config = fm.config || {};

  // Extract Caddy result from steps
  const caddyStep = ctx.steps.find(s => s.name === 'caddy_routes');
  const caddyResult = caddyStep ? { action: caddyStep.message, status: caddyStep.status } : null;

  return {
    action: 'upgrade',
    component,
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
    skill: {
      hooks: Object.keys(hooks).length > 0 ? hooks : null,
      config: Object.keys(config).length > 0 ? config : null,
      service: lifecycle.service || null,
      caddy: caddyResult,
    },
    mergeConflicts: ctx.mergeConflicts.length > 0 ? ctx.mergeConflicts : null,
    mergedFiles: ctx.mergedFiles.length > 0 ? ctx.mergedFiles : null,
  };
}
