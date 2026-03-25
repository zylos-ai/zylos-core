/**
 * Self-upgrade logic for zylos-core itself.
 * Downloads new version via GitHub tarball, syncs Core Skills with
 * manifest-based preservation, and runs npm install -g from local path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { SKILLS_DIR, ZYLOS_DIR, getZylosConfig } from './config.js';
import { downloadArchive, downloadBranch } from './download.js';
import { generateManifest, saveManifest, saveOriginals } from './manifest.js';
import { fetchRawFile, fetchLatestTag, compareSemverDesc, sanitizeError } from './github.js';
import { copyTree, syncTree } from './fs-utils.js';
import { extractScriptPath, extractSkillName, getCommandHooks } from './hook-utils.js';
import { smartSync, formatMergeResult } from './smart-merge.js';
import { runMigrations } from './migrate.js';
import { writeCodexConfig } from './runtime-setup.js';

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
export function downloadCoreToTemp(version, branch) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-'));

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
 * @returns {{ synced: string[], added: string[], merged: string[], conflicts: { skill: string, file: string, backupPath: string }[], errors: string[] }}
 */
export function syncCoreSkills(newSkillsSrc, backupBase, opts = {}) {
  const result = { synced: [], added: [], merged: [], deleted: [], conflicts: [], errors: [] };

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
      // New skill — copy entirely + save originals and manifest
      try {
        copyTree(srcDir, destDir);
        const manifest = generateManifest(destDir);
        saveManifest(destDir, manifest);
        saveOriginals(destDir, srcDir);
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
      if (mergeResult.overwritten.length || mergeResult.added.length || mergeResult.deleted.length) {
        result.synced.push(skillName);
      }
      if (mergeResult.merged.length) {
        result.merged.push(...mergeResult.merged.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.deleted.length) {
        result.deleted.push(...mergeResult.deleted.map(f => `${skillName}/${f}`));
      }
      if (mergeResult.conflicts.length) {
        for (const c of mergeResult.conflicts) {
          result.conflicts.push({ skill: skillName, file: c.file, backupPath: c.backupPath });
        }
      }
      if (mergeResult.errors.length) {
        result.errors.push(...mergeResult.errors.map(e => `${skillName}: ${e}`));
      }

    } catch (err) {
      result.errors.push(`${skillName}: ${err.message}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLAUDE.md managed sections sync
// ---------------------------------------------------------------------------

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Blank out fenced code blocks while preserving character positions. */
function blankCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '));
}

/**
 * Find the byte range of a ## section in markdown, skipping code blocks.
 * @returns {{ start: number, end: number } | null}
 */
function findSection(text, heading) {
  const blanked = blankCodeBlocks(text);
  const start = blanked.search(new RegExp(`^## ${escapeRegExp(heading)}$`, 'm'));
  if (start === -1) return null;

  const nextMatch = blanked.slice(start).match(/\n## \S/m);
  const end = nextMatch ? start + nextMatch.index : text.length;
  return { start, end };
}

const MANAGED_RE = /<!-- zylos-managed:(\S+):begin -->([\s\S]*?)<!-- zylos-managed:\1:end -->/g;

/**
 * Update managed sections in ~/zylos/CLAUDE.md from the new template.
 *
 * Template uses markers: <!-- zylos-managed:<name>:begin/end -->
 * - Markers exist in user file → replace between them
 * - No markers → locate by ## heading, replace, and inject markers
 * - No heading → append at end
 * User content outside managed sections is always preserved.
 */
function syncClaudeMd(templateDir) {
  const result = { updated: [], added: [], skipped: false };
  const templatePath = path.join(templateDir, 'CLAUDE.md');
  const userPath = path.join(ZYLOS_DIR, 'CLAUDE.md');

  if (!fs.existsSync(templatePath)) {
    result.skipped = true;
    return result;
  }
  if (!fs.existsSync(userPath)) {
    fs.copyFileSync(templatePath, userPath);
    result.added.push('CLAUDE.md (new)');
    return result;
  }

  const templateContent = fs.readFileSync(templatePath, 'utf8');
  let userContent = fs.readFileSync(userPath, 'utf8');

  // Extract managed sections from template
  const sections = [...templateContent.matchAll(MANAGED_RE)]
    .map(m => ({ name: m[1], block: m[0] }));

  if (sections.length === 0) {
    result.skipped = true;
    return result;
  }

  for (const { name, block } of sections) {
    const beginMarker = `<!-- zylos-managed:${name}:begin -->`;
    const endMarker = `<!-- zylos-managed:${name}:end -->`;

    if (userContent.includes(beginMarker) && userContent.includes(endMarker)) {
      // Replace existing managed section by markers
      const re = new RegExp(
        `${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
      );
      userContent = userContent.replace(re, block);
      result.updated.push(name);
      continue;
    }

    // No markers — fall back to heading-based detection
    const headingMatch = block.match(/^## (.+)/m);
    if (!headingMatch) continue;

    const section = findSection(userContent, headingMatch[1].trim());
    if (section) {
      const tail = userContent.slice(section.end).replace(/^\n+/, '');
      userContent = userContent.slice(0, section.start) + block + '\n\n' + tail;
      result.updated.push(name);
    } else {
      userContent = userContent.trimEnd() + '\n\n' + block + '\n';
      result.added.push(name);
    }
  }

  fs.writeFileSync(userPath, userContent);
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

/**
 * Compare template settings.json hooks with installed settings.json.
 * Matches hooks by script path (not full command string) to detect:
 *  - missing_hook:  in template, not installed
 *  - modified_hook: same script path, different command or timeout
 *  - removed_hook:  in installed, not in template (core skills only)
 */
function generateMigrationHints(templatesDir) {
  const hints = [];

  const templateSettingsPath = path.join(templatesDir, '.claude', 'settings.json');
  if (!fs.existsSync(templateSettingsPath)) return hints;

  const installedSettingsPath = path.join(ZYLOS_DIR, '.claude', 'settings.json');

  let templateSettings, installedSettings;
  try {
    templateSettings = JSON.parse(fs.readFileSync(templateSettingsPath, 'utf8'));
  } catch {
    return hints;
  }
  try {
    installedSettings = fs.existsSync(installedSettingsPath)
      ? JSON.parse(fs.readFileSync(installedSettingsPath, 'utf8'))
      : {};
  } catch {
    installedSettings = {};
  }

  const templateHooks = templateSettings.hooks || {};
  const installedHooks = installedSettings.hooks || {};

  // Collect core skill names from template hooks (for removed_hook scoping)
  const coreSkillNames = new Set();
  for (const matchers of Object.values(templateHooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      for (const h of getCommandHooks(m)) {
        const name = extractSkillName(h.command);
        if (name) coreSkillNames.add(name);
      }
    }
  }

  // --- Forward pass: detect missing and modified hooks ---
  for (const [event, matchers] of Object.entries(templateHooks)) {
    if (!Array.isArray(matchers)) continue;
    const installedMatchers = Array.isArray(installedHooks[event]) ? installedHooks[event] : [];

    for (const matcher of matchers) {
      for (const templateCmd of getCommandHooks(matcher)) {
        const templateKey = extractScriptPath(templateCmd.command);

        // Find installed hook with the same script path
        let matched = null;
        for (const im of installedMatchers) {
          matched = getCommandHooks(im).find(
            h => extractScriptPath(h.command) === templateKey
          );
          if (matched) break;
        }

        if (!matched) {
          hints.push({
            type: 'missing_hook',
            event,
            hook: { ...templateCmd },
            matcher: matcher.matcher !== undefined ? matcher.matcher : null,
            // Keep flat fields for backward compatibility
            command: templateCmd.command,
            timeout: templateCmd.timeout,
          });
        } else if (matched.command !== templateCmd.command || matched.timeout !== templateCmd.timeout) {
          hints.push({
            type: 'modified_hook',
            event,
            hook: { ...templateCmd },
            command: templateCmd.command,
            timeout: templateCmd.timeout,
            oldCommand: matched.command,
            oldTimeout: matched.timeout,
          });
        }
      }
    }
  }

  // --- statusLine sync ---
  if (templateSettings.statusLine) {
    const tsl = JSON.stringify(templateSettings.statusLine);
    const isl = JSON.stringify(installedSettings.statusLine || null);
    if (tsl !== isl) {
      hints.push({
        type: 'statusLine',
        value: templateSettings.statusLine,
      });
    }
  } else if (installedSettings.statusLine) {
    // Template removed statusLine — generate removal hint
    hints.push({
      type: 'statusLine_remove',
    });
  }

  // --- Reverse pass: detect removed hooks (core skills only) ---
  for (const [event, matchers] of Object.entries(installedHooks)) {
    if (!Array.isArray(matchers)) continue;
    const templateMatchers = Array.isArray(templateHooks[event]) ? templateHooks[event] : [];

    for (const matcher of matchers) {
      for (const installedCmd of getCommandHooks(matcher)) {
        // Only flag hooks from core skills to avoid false positives
        // for optional component hooks
        const skillName = extractSkillName(installedCmd.command);
        if (!skillName || !coreSkillNames.has(skillName)) continue;

        const installedKey = extractScriptPath(installedCmd.command);
        const foundInTemplate = templateMatchers.some(tm =>
          getCommandHooks(tm).some(
            h => extractScriptPath(h.command) === installedKey
          )
        );

        if (!foundInTemplate) {
          hints.push({
            type: 'removed_hook',
            event,
            command: installedCmd.command,
            timeout: installedCmd.timeout,
          });
        }
      }
    }
  }

  return hints;
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
    tempDir: tempDir || null,
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

    // Backup instruction files (will be modified in step 7)
    for (const name of ['CLAUDE.md', 'ZYLOS.md', 'AGENTS.md']) {
      const src = path.join(ZYLOS_DIR, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, name));
      }
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
 * Find PM2 services running from SKILLS_DIR by matching exec paths.
 * This catches ALL zylos-managed services regardless of SKILL.md declarations.
 *
 * @returns {{ name: string, status: string }[]} PM2 processes whose scripts are under SKILLS_DIR
 */
function getSkillsServices() {
  try {
    const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
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
function step3_stopCoreServices(ctx) {
  const startTime = Date.now();

  // Find all PM2 services running from skills directory
  const services = getSkillsServices();
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
      execSync(`pm2 stop ${svc.name} 2>/dev/null`, { stdio: 'pipe' });
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
function step4_npmInstallGlobal(ctx) {
  const startTime = Date.now();

  if (!ctx.tempDir || !fs.existsSync(ctx.tempDir)) {
    return { step: 4, name: 'npm_install_global', status: 'failed', error: 'Temp directory not available', duration: Date.now() - startTime };
  }

  try {
    // Pack first — creates a .tgz tarball (copies, not symlinks)
    const tarballName = execSync('npm pack --pack-destination .', {
      cwd: ctx.tempDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const tarballPath = path.join(ctx.tempDir, tarballName);

    // Install from tarball — npm copies files into global node_modules
    execSync(`npm install -g "${tarballPath}"`, {
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
function step5_syncCoreSkills(ctx) {
  const startTime = Date.now();

  const newSkillsSrc = path.join(ctx.tempDir, 'skills');
  if (!fs.existsSync(newSkillsSrc)) {
    return { step: 5, name: 'sync_core_skills', status: 'skipped', message: 'no skills in new version', duration: Date.now() - startTime };
  }

  try {
    // Use backup dir from step 1 as base for conflict backups
    const conflictBackupDir = ctx.backupDir ? path.join(ctx.backupDir, 'conflicts') : null;
    const syncResult = syncCoreSkills(newSkillsSrc, conflictBackupDir, { mode: ctx.mode });

    const parts = [];
    if (syncResult.synced.length) parts.push(`${syncResult.synced.length} synced`);
    if (syncResult.added.length) parts.push(`${syncResult.added.length} added`);
    if (syncResult.merged.length) parts.push(`${syncResult.merged.length} merged`);
    if (syncResult.deleted.length) parts.push(`${syncResult.deleted.length} deleted`);
    if (syncResult.conflicts.length) parts.push(`${syncResult.conflicts.length} conflicts`);
    if (syncResult.errors.length) parts.push(`${syncResult.errors.length} errors`);
    const msg = parts.join(', ') || 'no changes';

    // Store conflicts on ctx for the final result
    ctx.mergeConflicts = syncResult.conflicts;
    ctx.mergedFiles = syncResult.merged;

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
function step6_installSkillDeps(ctx) {
  const startTime = Date.now();
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  let installed = 0;
  const failed = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const pkgPath = path.join(skillDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (!pkg.dependencies || Object.keys(pkg.dependencies).length === 0) continue;

      execSync('npm install --omit=dev', {
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
 * Step 7: update instruction files from new templates.
 *
 * v0.4.0+ installs (ZYLOS.md present): rebuild CLAUDE.md and AGENTS.md from
 * ZYLOS.md + new addon templates (from ctx.tempDir). This keeps both files
 * current after upgrade without touching user customizations in ZYLOS.md.
 *
 * Pre-v0.4.0 installs (ZYLOS.md absent): fall through to the managed-section
 * sync on CLAUDE.md (legacy path).
 */
function step7_syncClaudeMd(ctx) {
  const startTime = Date.now();

  const templateDir = path.join(ctx.tempDir, 'templates');
  if (!fs.existsSync(templateDir)) {
    return { step: 7, name: 'sync_claude_md', status: 'skipped', message: 'no templates in new version', duration: Date.now() - startTime };
  }

  // For legacy installs (ZYLOS.md absent, CLAUDE.md present): run v0.4.0 migration
  // first so the rebuild block below has a ZYLOS.md to work with.
  const zylosMd = path.join(ZYLOS_DIR, 'ZYLOS.md');
  if (!fs.existsSync(zylosMd)) {
    try {
      runMigrations();
    } catch { /* non-fatal — migration failure falls through to legacy sync */ }
  }

  // v0.4.0+ path: rebuild instruction files from ZYLOS.md + new addon templates
  if (fs.existsSync(zylosMd)) {
    try {
      const core = fs.readFileSync(zylosMd, 'utf8');
      const rebuilt = [];
      for (const [addonFile, destFile] of [
        ['claude-addon.md', 'CLAUDE.md'],
        ['codex-addon.md', 'AGENTS.md'],
      ]) {
        const addonPath = path.join(templateDir, addonFile);
        if (!fs.existsSync(addonPath)) continue;
        const content = core.trimEnd() + '\n\n' + fs.readFileSync(addonPath, 'utf8').trimEnd() + '\n';
        fs.writeFileSync(path.join(ZYLOS_DIR, destFile), content, 'utf8');
        rebuilt.push(destFile);
      }
      const msg = rebuilt.length ? `rebuilt ${rebuilt.join(', ')} from ZYLOS.md` : 'no addon templates found';
      return { step: 7, name: 'sync_claude_md', status: 'done', message: msg, duration: Date.now() - startTime };
    } catch (err) {
      return { step: 7, name: 'sync_claude_md', status: 'skipped', message: err.message, duration: Date.now() - startTime };
    }
  }

  // Pre-v0.4.0 path: sync managed sections in CLAUDE.md
  try {
    const syncResult = syncClaudeMd(templateDir);
    if (syncResult.skipped) {
      return { step: 7, name: 'sync_claude_md', status: 'skipped', message: 'no managed sections', duration: Date.now() - startTime };
    }

    const parts = [];
    if (syncResult.updated.length) parts.push(`${syncResult.updated.length} updated`);
    if (syncResult.added.length) parts.push(`${syncResult.added.length} added`);
    const msg = parts.join(', ') || 'no changes';

    return { step: 7, name: 'sync_claude_md', status: 'done', message: msg, duration: Date.now() - startTime };
  } catch (err) {
    // Non-fatal — CLAUDE.md update failure shouldn't block the upgrade
    return { step: 7, name: 'sync_claude_md', status: 'skipped', message: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Apply migration hints to installed settings.json.
 * Adds missing hooks, updates modified hooks, removes obsolete hooks.
 * Preserves user-added hooks (hooks not from core skills).
 *
 * @param {object[]} hints - Output from generateMigrationHints()
 * @returns {{ applied: number, errors: string[] }}
 */
function applyMigrationHints(hints) {
  const result = { applied: 0, errors: [] };
  if (!hints || hints.length === 0) return result;

  const settingsPath = path.join(ZYLOS_DIR, '.claude', 'settings.json');
  let settings;
  try {
    settings = fs.existsSync(settingsPath)
      ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      : {};
  } catch {
    settings = {};
  }

  if (!settings.hooks) settings.hooks = {};

  for (const hint of hints) {
    try {
      if (hint.type === 'missing_hook') {
        // Add the hook to the appropriate event
        if (!Array.isArray(settings.hooks[hint.event])) {
          settings.hooks[hint.event] = [];
        }

        // Use the full hook object from the hint (includes async, timeout, etc.)
        const hookObj = hint.hook
          ? { ...hint.hook }
          : { type: 'command', command: hint.command };
        if (!hint.hook && hint.timeout !== undefined) hookObj.timeout = hint.timeout;

        // Find or create a matcher group
        const matcherValue = hint.matcher !== undefined ? hint.matcher : null;
        let targetGroup = null;

        if (matcherValue !== null) {
          // Look for an existing group with this matcher
          targetGroup = settings.hooks[hint.event].find(
            g => g.matcher === matcherValue
          );
        }

        if (!targetGroup) {
          targetGroup = { hooks: [] };
          if (matcherValue !== null) targetGroup.matcher = matcherValue;
          settings.hooks[hint.event].push(targetGroup);
        }

        targetGroup.hooks.push(hookObj);
        result.applied++;

      } else if (hint.type === 'modified_hook') {
        // Find and update the hook by script path
        const matchers = settings.hooks[hint.event];
        if (!Array.isArray(matchers)) continue;

        const oldScriptPath = extractScriptPath(hint.oldCommand);
        let updated = false;

        for (const group of matchers) {
          if (!Array.isArray(group.hooks)) continue;
          for (let i = 0; i < group.hooks.length; i++) {
            const h = group.hooks[i];
            if (h.type === 'command' && extractScriptPath(h.command) === oldScriptPath) {
              // Update command and timeout
              group.hooks[i].command = hint.command;
              if (hint.timeout !== undefined) {
                group.hooks[i].timeout = hint.timeout;
              }
              updated = true;
              break;
            }
          }
          if (updated) break;
        }

        if (updated) result.applied++;

      } else if (hint.type === 'statusLine') {
        settings.statusLine = hint.value;
        result.applied++;

      } else if (hint.type === 'statusLine_remove') {
        if (settings.statusLine) {
          delete settings.statusLine;
          result.applied++;
        }

      } else if (hint.type === 'removed_hook') {
        // Remove the hook by script path
        const matchers = settings.hooks[hint.event];
        if (!Array.isArray(matchers)) continue;

        const scriptPath = extractScriptPath(hint.command);
        let removed = false;

        for (let gi = matchers.length - 1; gi >= 0; gi--) {
          const group = matchers[gi];
          if (!Array.isArray(group.hooks)) continue;

          group.hooks = group.hooks.filter(h => {
            if (h.type === 'command' && extractScriptPath(h.command) === scriptPath) {
              removed = true;
              return false;
            }
            return true;
          });

          // Remove empty groups
          if (group.hooks.length === 0) {
            matchers.splice(gi, 1);
          }
        }

        // Clean up empty event arrays
        if (matchers.length === 0) {
          delete settings.hooks[hint.event];
        }

        if (removed) result.applied++;
      }
    } catch (err) {
      result.errors.push(`${hint.type}/${hint.event}: ${err.message}`);
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  // Write back
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  return result;
}

/**
 * Step 8: migrate state.md for existing users.
 *
 * If state.md exists but has no Onboarding section, this is an existing user
 * upgrading. Add `onboarding: skipped` so the onboarding flow is not triggered.
 * New installs already have `Status: pending` from the template.
 */
function step8_migrateStateMd() {
  const startTime = Date.now();
  const statePath = path.join(ZYLOS_DIR, 'memory', 'state.md');

  if (!fs.existsSync(statePath)) {
    return { step: 8, name: 'migrate_state_md', status: 'skipped', message: 'state.md not found', duration: Date.now() - startTime };
  }

  try {
    const content = fs.readFileSync(statePath, 'utf8');

    // Already has onboarding section — nothing to do
    if (/## Onboarding/i.test(content)) {
      return { step: 8, name: 'migrate_state_md', status: 'skipped', message: 'onboarding section exists', duration: Date.now() - startTime };
    }

    // Existing user without onboarding — add skipped status
    const section = '\n\n## Onboarding\n- Status: skipped\n';
    fs.writeFileSync(statePath, content.trimEnd() + section);

    return { step: 8, name: 'migrate_state_md', status: 'done', message: 'added onboarding: skipped', duration: Date.now() - startTime };
  } catch (err) {
    // Non-fatal
    return { step: 8, name: 'migrate_state_md', status: 'skipped', message: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Step 9: sync settings.json hooks from template and refresh upgrade-safe
 * config backfills via the newly installed package.
 *
 * Shells out to the NEWLY INSTALLED sync-settings-hooks.js instead of using
 * the in-memory generateMigrationHints(). This avoids bootstrap problems where
 * the old version's sync logic misses new config fields or backfills
 * (e.g. statusLine, Codex config refreshes).
 */
function step9_syncSettingsHooks(ctx) {
  const startTime = Date.now();

  // Resolve the newly installed package path (from step 4) to use the latest sync logic.
  const syncScript = resolveInstalledSyncScript();

  if (!syncScript) {
    // Fallback to in-memory hints if new script not found
    const templatesDir = path.join(ctx.tempDir, 'templates');
    const hints = generateMigrationHints(templatesDir);
    if (hints.length === 0) {
      return { step: 9, name: 'sync_settings_hooks', status: 'done', message: 'no changes needed', duration: Date.now() - startTime };
    }
    const result = applyMigrationHints(hints);
    if (result.errors.length > 0) {
      return { step: 9, name: 'sync_settings_hooks', status: 'failed', error: result.errors.join('; '), duration: Date.now() - startTime };
    }
    return { step: 9, name: 'sync_settings_hooks', status: 'done', message: `${result.applied} hooks updated`, duration: Date.now() - startTime };
  }

  try {
    const output = execSync(`node "${syncScript}"`, { encoding: 'utf8', stdio: 'pipe', timeout: 60000 }).trim();
    // Extract last line as the summary (script outputs per-hook details before summary)
    const lines = output.split('\n').filter(l => l.trim());
    const summary = lines.length > 0 ? lines[lines.length - 1].trim() : 'no changes';
    return { step: 9, name: 'sync_settings_hooks', status: 'done', message: summary, duration: Date.now() - startTime };
  } catch (err) {
    const errMsg = err.stderr ? err.stderr.toString().trim() : err.message;
    return { step: 9, name: 'sync_settings_hooks', status: 'failed', error: errMsg, duration: Date.now() - startTime };
  }
}

/**
 * Resolve the path to sync-settings-hooks.js in the globally installed package.
 * Reads the package name from package.json to avoid hardcoding.
 * @returns {string|null} Absolute path to the script, or null if not found.
 */
function resolveInstalledSyncScript() {
  try {
    // import.meta.dirname points to cli/lib/, go up two levels to package root
    const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const pkgName = pkg.name || 'zylos';
    const npmRoot = execSync('npm root -g', { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }).trim();
    const script = path.join(npmRoot, pkgName, 'cli', 'lib', 'sync-settings-hooks.js');
    return fs.existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

/**
 * Step 10: ensure Codex config is current for existing Codex-capable installs.
 *
 * Fresh install/init and `zylos runtime codex` already call writeCodexConfig().
 * This upgrade-time step covers existing deployments so newly required config
 * keys (for example [features].multi_agent) are backfilled during self-upgrade.
 */
export function step10_ensureCodexConfig(deps = {}) {
  const startTime = Date.now();
  const cfg = deps.cfg ?? getZylosConfig();
  const codexDir = deps.codexDir ?? path.join(os.homedir(), '.codex');
  const writeConfig = deps.writeConfig ?? writeCodexConfig;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const hasCodexState = existsSync(path.join(codexDir, 'config.toml'))
    || existsSync(path.join(codexDir, 'auth.json'));

  if (cfg.runtime !== 'codex' && !hasCodexState) {
    return { step: 10, name: 'ensure_codex_config', status: 'skipped', message: 'codex not in use', duration: Date.now() - startTime };
  }

  if (!writeConfig(ZYLOS_DIR)) {
    if (cfg.runtime !== 'codex') {
      return {
        step: 10,
        name: 'ensure_codex_config',
        status: 'skipped',
        message: 'warning: failed to refresh ~/.codex/config.toml outside codex runtime',
        duration: Date.now() - startTime
      };
    }
    return { step: 10, name: 'ensure_codex_config', status: 'failed', error: 'failed to write ~/.codex/config.toml', duration: Date.now() - startTime };
  }

  return { step: 10, name: 'ensure_codex_config', status: 'done', message: 'updated ~/.codex/config.toml', duration: Date.now() - startTime };
}

/**
 * Step 11: start core services
 */
function step11_startCoreServices(ctx) {
  const startTime = Date.now();

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
  const pm2Dir = path.join(ZYLOS_DIR, 'pm2');
  const ecosystemDest = path.join(pm2Dir, 'ecosystem.config.cjs');
  if (ecosystemTemplateSrc && fs.existsSync(ecosystemTemplateSrc)) {
    try {
      fs.mkdirSync(pm2Dir, { recursive: true });
      fs.copyFileSync(ecosystemTemplateSrc, ecosystemDest);
      ecosystemPath = ecosystemDest;
    } catch {
      // Non-fatal — fall back to pm2 restart below
    }
  } else if (fs.existsSync(ecosystemDest)) {
    // No new template available; use the existing ecosystem file
    ecosystemPath = ecosystemDest;
  }

  const started = [];
  const failed = [];

  for (const name of ctx.servicesWereRunning) {
    try {
      if (ecosystemPath) {
        // Re-read the ecosystem file so PM2 picks up updated env vars
        execSync(`pm2 start "${ecosystemPath}" --only ${name} 2>/dev/null`, { stdio: 'pipe' });
      } else {
        execSync(`pm2 restart ${name} 2>/dev/null`, { stdio: 'pipe' });
      }
      started.push(name);
    } catch {
      failed.push(name);
    }
  }

  if (failed.length > 0) {
    return { step: 11, name: 'start_core_services', status: 'failed', error: `Failed to restart: ${failed.join(', ')}`, duration: Date.now() - startTime };
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
function step12_verifyServices(ctx) {
  const startTime = Date.now();

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 12, name: 'verify_services', status: 'skipped', message: 'no services to verify', duration: Date.now() - startTime };
  }

  const POLL_INTERVAL_MS = 2000;
  const TIMEOUT_MS = 30000;

  while (Date.now() - startTime < TIMEOUT_MS) {
    try { execSync('sleep 2', { stdio: 'pipe' }); } catch { /* ignore */ }

    try {
      const output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
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

  // Restore instruction files from backup
  if (ctx.backupDir) {
    for (const name of ['CLAUDE.md', 'ZYLOS.md', 'AGENTS.md']) {
      const backup = path.join(ctx.backupDir, name);
      if (fs.existsSync(backup)) {
        try {
          fs.copyFileSync(backup, path.join(ZYLOS_DIR, name));
          results.push({ action: `restore_${name.toLowerCase().replace('.', '_')}`, success: true });
        } catch (err) {
          results.push({ action: `restore_${name.toLowerCase().replace('.', '_')}`, success: false, error: err.message });
        }
      }
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
 * Run the 11-step self-upgrade pipeline.
 * Template migration and Claude restart are handled by Claude after this completes.
 * Lock must be acquired by caller.
 *
 * @param {{ tempDir: string, newVersion: string, onStep?: function }} opts
 * @returns {object} Upgrade result
 */
export function runSelfUpgrade({ tempDir, newVersion, mode, onStep } = {}) {
  const ctx = createContext({ tempDir, newVersion, mode });

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
    step6_installSkillDeps,
    step7_syncClaudeMd,
    step8_migrateStateMd,
    step9_syncSettingsHooks,
    step10_ensureCodexConfig,
    step11_startCoreServices,
    step12_verifyServices,
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

  // List template files for Claude to compare with local structure
  const templatesDir = path.join(ctx.tempDir, 'templates');
  const templates = listTemplateFiles(templatesDir);

  // Migration hints: step 8 already applied settings sync via the newly installed script.
  const migrationHints = [];

  // Check if instruction files were rebuilt (CLAUDE.md / AGENTS.md) — used by
  // component.js to auto-enqueue a Claude restart after the reply is sent, so
  // Claude does not prompt the user about restarting.
  const step7 = ctx.steps.find(s => s.step === 7);
  const instructionFilesRebuilt = step7?.status === 'done' && Boolean(step7?.message?.includes('rebuilt'));

  return {
    action: 'self_upgrade',
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
    templates,
    migrationHints,
    instructionFilesRebuilt,
    mergeConflicts: ctx.mergeConflicts.length > 0 ? ctx.mergeConflicts : null,
    mergedFiles: ctx.mergedFiles.length > 0 ? ctx.mergedFiles : null,
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
