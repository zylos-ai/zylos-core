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
 * Extract the script file path from a hook command.
 * e.g. "node ~/zylos/.claude/skills/foo/scripts/bar.js --flag"
 *   -> "~/zylos/.claude/skills/foo/scripts/bar.js"
 * Falls back to the full command if no path-like token is found.
 */
function extractScriptPath(command) {
  if (typeof command !== 'string') return '';
  // Use the LAST path-like token so that shell prefixes
  // (e.g. "source ~/.nvm/nvm.sh && node ~/path/script.js") are skipped
  let result = null;
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (token.includes('/') && /\.\w+$/.test(token)) {
      result = token;
    }
  }
  if (!result) return command;
  // Normalize ~ to absolute path for consistent comparison
  return result.startsWith('~/') ? path.join(os.homedir(), result.slice(2)) : result;
}

/**
 * Extract the skill name from a hook command's script path.
 * e.g. "node ~/zylos/.claude/skills/comm-bridge/scripts/c4-session-init.js"
 *   -> "comm-bridge"
 * Returns null if the pattern doesn't match.
 */
function extractSkillName(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/skills\/([^/]+)\//);
  return match ? match[1] : null;
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

  // Helper: safely get command hooks from a matcher entry
  const getCmds = (m) =>
    (m && typeof m === 'object' && Array.isArray(m.hooks) ? m.hooks : [])
      .filter(h => h && h.type === 'command');

  // Collect core skill names from template hooks (for removed_hook scoping)
  const coreSkillNames = new Set();
  for (const matchers of Object.values(templateHooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      for (const h of getCmds(m)) {
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
      for (const templateCmd of getCmds(matcher)) {
        const templateKey = extractScriptPath(templateCmd.command);

        // Find installed hook with the same script path
        let matched = null;
        for (const im of installedMatchers) {
          matched = getCmds(im).find(
            h => extractScriptPath(h.command) === templateKey
          );
          if (matched) break;
        }

        if (!matched) {
          hints.push({
            type: 'missing_hook',
            event,
            command: templateCmd.command,
            timeout: templateCmd.timeout,
          });
        } else if (matched.command !== templateCmd.command || matched.timeout !== templateCmd.timeout) {
          hints.push({
            type: 'modified_hook',
            event,
            command: templateCmd.command,
            timeout: templateCmd.timeout,
            oldCommand: matched.command,
            oldTimeout: matched.timeout,
          });
        }
      }
    }
  }

  // --- Reverse pass: detect removed hooks (core skills only) ---
  for (const [event, matchers] of Object.entries(installedHooks)) {
    if (!Array.isArray(matchers)) continue;
    const templateMatchers = Array.isArray(templateHooks[event]) ? templateHooks[event] : [];

    for (const matcher of matchers) {
      for (const installedCmd of getCmds(matcher)) {
        // Only flag hooks from core skills to avoid false positives
        // for optional component hooks
        const skillName = extractSkillName(installedCmd.command);
        if (!skillName || !coreSkillNames.has(skillName)) continue;

        const installedKey = extractScriptPath(installedCmd.command);
        const foundInTemplate = templateMatchers.some(tm =>
          getCmds(tm).some(
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
// 10-step self-upgrade pipeline
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

    // Backup CLAUDE.md (will be modified in step 6)
    const claudeMdPath = path.join(ZYLOS_DIR, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      fs.copyFileSync(claudeMdPath, path.join(backupDir, 'CLAUDE.md'));
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

      execSync('npm install --production', {
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
 * Step 7: sync CLAUDE.md managed sections
 */
function step7_syncClaudeMd(ctx) {
  const startTime = Date.now();

  const templateDir = path.join(ctx.tempDir, 'templates');
  if (!fs.existsSync(templateDir)) {
    return { step: 7, name: 'sync_claude_md', status: 'skipped', message: 'no templates in new version', duration: Date.now() - startTime };
  }

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
 * Step 8: post-upgrade hook (placeholder for future use)
 */
function step8_postUpgradeHook(ctx) {
  const startTime = Date.now();
  // No core post-upgrade hook yet — reserved for future
  return { step: 8, name: 'post_upgrade_hook', status: 'skipped', duration: Date.now() - startTime };
}

/**
 * Step 9: start core services
 */
function step9_startCoreServices(ctx) {
  const startTime = Date.now();

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 9, name: 'start_core_services', status: 'skipped', message: 'no services to restart', duration: Date.now() - startTime };
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
    return { step: 9, name: 'start_core_services', status: 'failed', error: `Failed to restart: ${failed.join(', ')}`, duration: Date.now() - startTime };
  }

  return { step: 9, name: 'start_core_services', status: 'done', message: started.join(', '), duration: Date.now() - startTime };
}

/**
 * Step 10: verify services
 */
function step10_verifyServices(ctx) {
  const startTime = Date.now();

  if (ctx.servicesWereRunning.length === 0) {
    return { step: 10, name: 'verify_services', status: 'skipped', message: 'no services to verify', duration: Date.now() - startTime };
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
      return { step: 10, name: 'verify_services', status: 'failed', error: `Not online: ${notOnline.join(', ')}`, duration: Date.now() - startTime };
    }

    return { step: 10, name: 'verify_services', status: 'done', duration: Date.now() - startTime };
  } catch (err) {
    return { step: 10, name: 'verify_services', status: 'failed', error: err.message, duration: Date.now() - startTime };
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

  // Restore CLAUDE.md from backup
  if (ctx.backupDir) {
    const backupClaudeMd = path.join(ctx.backupDir, 'CLAUDE.md');
    if (fs.existsSync(backupClaudeMd)) {
      try {
        fs.copyFileSync(backupClaudeMd, path.join(ZYLOS_DIR, 'CLAUDE.md'));
        results.push({ action: 'restore_claude_md', success: true });
      } catch (err) {
        results.push({ action: 'restore_claude_md', success: false, error: err.message });
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
 * Run the 10-step self-upgrade pipeline.
 * Template migration and Claude restart are handled by Claude after this completes.
 * Lock must be acquired by caller.
 *
 * @param {{ tempDir: string, newVersion: string, onStep?: function }} opts
 * @returns {object} Upgrade result
 */
export function runSelfUpgrade({ tempDir, newVersion, onStep } = {}) {
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
    step6_installSkillDeps,
    step7_syncClaudeMd,
    step8_postUpgradeHook,
    step9_startCoreServices,
    step10_verifyServices,
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

  // Generate migration hints for settings that need manual updates
  const migrationHints = generateMigrationHints(templatesDir);

  return {
    action: 'self_upgrade',
    success: true,
    from: ctx.from,
    to: ctx.to,
    steps: ctx.steps,
    backupDir: ctx.backupDir,
    templates,
    migrationHints,
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
