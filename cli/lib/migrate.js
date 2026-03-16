/**
 * migrate.js
 *
 * Handles data migrations between zylos-core versions.
 * Called during `zylos upgrade` and at `zylos init` re-init.
 *
 * Current migrations:
 *   - v0.4.0: CLAUDE.md → ZYLOS.md split (multi-runtime support)
 */

import fs from 'node:fs';
import path from 'node:path';
import { COMPONENTS_DIR, ENV_FILE, SKILLS_DIR, ZYLOS_DIR } from './config.js';
import { parsePortNumber } from './service-runtime.js';

const CLAUDE_MD = path.join(ZYLOS_DIR, 'CLAUDE.md');
const AGENTS_MD = path.join(ZYLOS_DIR, 'AGENTS.md');
const ZYLOS_MD = path.join(ZYLOS_DIR, 'ZYLOS.md');

/**
 * Run all pending migrations.
 * Safe to call multiple times (idempotent).
 *
 * @returns {{ migrated: string[] }} List of migrations that ran
 */
export function runMigrations() {
  const migrated = [];

  if (migrateClaudeMdToZylosMd()) {
    migrated.push('v0.4.0/claude-md-to-zylos-md');
  }

  if (migrateLegacyPortKeys()) {
    migrated.push('v0.4.0/legacy-port-keys');
  }

  return { migrated };
}

function migrateLegacyPortKeys() {
  let changed = false;

  if (migrateWebConsoleEnvKey()) {
    changed = true;
  }

  if (migrateComponentPortConfig('telegram')) {
    changed = true;
  }

  if (migrateComponentPortConfig('hxa')) {
    changed = true;
  }

  return changed;
}

function migrateWebConsoleEnvKey() {
  if (!fs.existsSync(ENV_FILE)) return false;

  const content = fs.readFileSync(ENV_FILE, 'utf8');
  if (/^WEB_CONSOLE_PORT=/m.test(content)) return false;

  const legacyMatch = content.match(/^ZYLOS_WEB_PORT=(.+)$/m);
  const legacyPort = parsePortNumber(legacyMatch?.[1] ?? null);
  if (!legacyPort) return false;

  const nextContent = content.trimEnd()
    + '\n\n# Canonicalized by zylos init\n'
    + `WEB_CONSOLE_PORT=${legacyPort}\n`;
  fs.writeFileSync(ENV_FILE, nextContent, 'utf8');
  return true;
}

function migrateComponentPortConfig(componentName) {
  const roots = [
    path.join(COMPONENTS_DIR, componentName),
    path.join(SKILLS_DIR, componentName),
  ];

  let changed = false;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkJsonFiles(root)) {
      if (normalizePortJsonFile(file)) {
        changed = true;
      }
    }
  }
  return changed;
}

function *walkJsonFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield *walkJsonFiles(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) {
      yield fullPath;
    }
  }
}

function normalizePortJsonFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== 'object') return false;
  if (!normalizePortKeysInObject(parsed)) return false;

  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return true;
}

function normalizePortKeysInObject(value) {
  let changed = false;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && normalizePortKeysInObject(item)) {
        changed = true;
      }
    }
    return changed;
  }

  if (!value || typeof value !== 'object') return false;

  if (Object.hasOwn(value, 'internalPort') || Object.hasOwn(value, 'internal_port')) {
    const camelPort = parsePortNumber(value.internalPort);
    const snakePort = parsePortNumber(value.internal_port);
    const canonical = camelPort || snakePort;

    if (canonical && value.internalPort !== canonical) {
      value.internalPort = canonical;
      changed = true;
    }
    if (Object.hasOwn(value, 'internal_port')) {
      delete value.internal_port;
      changed = true;
    }
  }

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && normalizePortKeysInObject(nested)) {
      changed = true;
    }
  }

  return changed;
}

/**
 * v0.4.0 migration: CLAUDE.md → ZYLOS.md split
 *
 * If ZYLOS.md doesn't exist but CLAUDE.md does:
 *   1. Rename CLAUDE.md → ZYLOS.md  (preserves user customizations)
 *   2. Regenerate CLAUDE.md = ZYLOS.md template + claude-addon.md
 *
 * Atomic sequence to avoid a window with no CLAUDE.md:
 *   a. Write new content to CLAUDE.md.new
 *   b. rename CLAUDE.md → ZYLOS.md  (user content safe)
 *   c. rename CLAUDE.md.new → CLAUDE.md  (new generated content in place)
 *
 * Idempotent: no-op if ZYLOS.md already exists.
 * Crash recovery: if ZYLOS.md exists but CLAUDE.md is missing, regenerate CLAUDE.md.
 *
 * @returns {boolean} true if migration ran
 */
function migrateClaudeMdToZylosMd() {
  const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..');
  const zylosMdTemplate = path.join(PACKAGE_ROOT, 'templates', 'ZYLOS.md');
  const claudeAddonTemplate = path.join(PACKAGE_ROOT, 'templates', 'claude-addon.md');

  const codexAddonTemplate = path.join(PACKAGE_ROOT, 'templates', 'codex-addon.md');

  // Already migrated
  if (fs.existsSync(ZYLOS_MD)) {
    // Crash recovery: regenerate CLAUDE.md if it went missing.
    // ZYLOS_MD is guaranteed to exist here (we're inside the existsSync check above).
    if (!fs.existsSync(CLAUDE_MD) && fs.existsSync(claudeAddonTemplate)) {
      const content = fs.readFileSync(ZYLOS_MD, 'utf8').trimEnd()
        + '\n\n'
        + fs.readFileSync(claudeAddonTemplate, 'utf8').trimEnd()
        + '\n';
      const tmp = CLAUDE_MD + `.tmp.${process.pid}`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, CLAUDE_MD);
    }
    // Crash recovery: regenerate AGENTS.md if it went missing.
    if (!fs.existsSync(AGENTS_MD) && fs.existsSync(codexAddonTemplate)) {
      const content = fs.readFileSync(ZYLOS_MD, 'utf8').trimEnd()
        + '\n\n'
        + fs.readFileSync(codexAddonTemplate, 'utf8').trimEnd()
        + '\n';
      const tmp = AGENTS_MD + `.tmp.${process.pid}`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, AGENTS_MD);
    }
    return false;
  }

  // Nothing to migrate (fresh install — no CLAUDE.md yet either)
  if (!fs.existsSync(CLAUDE_MD)) {
    return false;
  }

  // Prepare new CLAUDE.md content: user's existing CLAUDE.md (which becomes ZYLOS.md)
  // plus the Claude addon. Using the user's file as the base preserves customizations.
  const userContent = fs.readFileSync(CLAUDE_MD, 'utf8');
  let newClaudeContent;
  if (fs.existsSync(claudeAddonTemplate)) {
    newClaudeContent = userContent.trimEnd()
      + '\n\n'
      + fs.readFileSync(claudeAddonTemplate, 'utf8').trimEnd()
      + '\n';
  } else {
    // Addon template missing — keep old content unchanged in both files
    newClaudeContent = userContent;
  }

  // Prepend a migration notice to ZYLOS.md so users know to review it before
  // switching runtimes. The old CLAUDE.md may contain Claude-specific rules
  // (e.g. EnterPlanMode, Task agents) that should be removed from the
  // runtime-agnostic base before AGENTS.md is generated for Codex.
  const migrationNotice = `<!-- MIGRATION NOTE (zylos v0.4.0): This file was created from your previous
     CLAUDE.md. It may contain Claude-specific instructions. If you plan to
     use Codex, review this file and remove any Claude-only rules before
     switching runtimes via "zylos init --runtime codex". -->\n\n`;

  // Write both outputs to temp files first, then perform two atomic renames.
  // This avoids a crash window where CLAUDE.md has been overwritten but not
  // yet renamed to ZYLOS.md — which would leave the user's content corrupted
  // and cause the migration notice to be prepended again on the next run.
  const claudeMdNew = CLAUDE_MD + `.new.${process.pid}`;
  const zylosMdTmp = ZYLOS_MD + `.tmp.${process.pid}`;
  fs.writeFileSync(claudeMdNew, newClaudeContent, 'utf8');
  fs.writeFileSync(zylosMdTmp, migrationNotice + userContent, 'utf8');

  // Atomic sequence:
  //   rename CLAUDE.md.tmp → ZYLOS.md  (user's existing content is now ZYLOS.md)
  //   rename CLAUDE.md.new → CLAUDE.md  (new generated content in place)
  // CLAUDE.md is overwritten atomically on the final rename — no window
  // where the file is missing or contains the wrong content.
  fs.renameSync(zylosMdTmp, ZYLOS_MD);
  fs.renameSync(claudeMdNew, CLAUDE_MD);

  return true;
}
