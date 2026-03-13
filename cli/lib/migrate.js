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
import { ZYLOS_DIR } from './config.js';

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

  return { migrated };
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

  // Prepare new CLAUDE.md content from templates
  let newClaudeContent;
  if (fs.existsSync(zylosMdTemplate) && fs.existsSync(claudeAddonTemplate)) {
    newClaudeContent = fs.readFileSync(zylosMdTemplate, 'utf8').trimEnd()
      + '\n\n'
      + fs.readFileSync(claudeAddonTemplate, 'utf8').trimEnd()
      + '\n';
  } else {
    // Templates missing — keep old CLAUDE.md content in both files
    newClaudeContent = fs.readFileSync(CLAUDE_MD, 'utf8');
  }

  // Write new CLAUDE.md content to temp file
  const claudeMdNew = CLAUDE_MD + `.new.${process.pid}`;
  fs.writeFileSync(claudeMdNew, newClaudeContent, 'utf8');

  // Atomic sequence:
  //   rename CLAUDE.md → ZYLOS.md  (user's existing content is now ZYLOS.md)
  //   rename CLAUDE.md.new → CLAUDE.md  (generated content is now CLAUDE.md)
  fs.renameSync(CLAUDE_MD, ZYLOS_MD);
  fs.renameSync(claudeMdNew, CLAUDE_MD);

  return true;
}
