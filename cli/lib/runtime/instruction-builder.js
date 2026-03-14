/**
 * instruction-builder.js
 *
 * Builds the runtime-specific instruction file from layered templates:
 *   ZYLOS.md (runtime-agnostic core)
 *   + claude-addon.md  → CLAUDE.md   (Claude Code runtime)
 *   + codex-addon.md   → AGENTS.md   (Codex runtime)
 *
 * The generated file is written to the zylos data directory (~/zylos/).
 * The templates live in the zylos-core package (templates/).
 */

import fs from 'node:fs';
import path from 'node:path';
import { ZYLOS_DIR } from '../config.js';

// cli/lib/runtime/ → cli/lib/ → cli/ → package root
const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');

// Generated file locations
const OUTPUT_FILES = {
  claude: path.join(ZYLOS_DIR, 'CLAUDE.md'),
  codex: path.join(ZYLOS_DIR, 'AGENTS.md'),
};

// Template paths
const TEMPLATE_FILES = {
  core: path.join(TEMPLATES_DIR, 'ZYLOS.md'),
  claudeAddon: path.join(TEMPLATES_DIR, 'claude-addon.md'),
  codexAddon: path.join(TEMPLATES_DIR, 'codex-addon.md'),
};

/**
 * Build the instruction file for the given runtime.
 *
 * @param {'claude'|'codex'} runtime
 * @param {object} [opts]
 * @param {string} [opts.memorySnapshot] - Optional memory content to append (e.g. for AGENTS.md)
 * @returns {string} Path to the generated file
 */
export function buildInstructionFile(runtime, opts = {}) {
  // Prefer user's ~/zylos/ZYLOS.md (may contain customizations) over the package template.
  // The package template is used as fallback on first install before deployTemplates() copies it.
  const userZylosMd = path.join(ZYLOS_DIR, 'ZYLOS.md');
  const addonSrc = runtime === 'codex' ? TEMPLATE_FILES.codexAddon : TEMPLATE_FILES.claudeAddon;
  const destPath = OUTPUT_FILES[runtime];

  // Guard: if ZYLOS.md doesn't exist, this is a pre-v0.4 install that hasn't been
  // migrated yet (migration runs during `zylos init` and creates ZYLOS.md). Preserve
  // the existing instruction file to avoid overwriting user customizations with the
  // package template. Once the user runs `zylos init`, ZYLOS.md is created and this
  // guard no longer applies.
  if (!fs.existsSync(userZylosMd) && fs.existsSync(destPath)) {
    return destPath;
  }

  const coreSrc = fs.existsSync(userZylosMd) ? userZylosMd : TEMPLATE_FILES.core;

  if (!fs.existsSync(coreSrc)) {
    throw new Error(`Core template not found: ${coreSrc}`);
  }
  if (!fs.existsSync(addonSrc)) {
    throw new Error(`Addon template not found: ${addonSrc}`);
  }

  const core = fs.readFileSync(coreSrc, 'utf8');
  const addon = fs.readFileSync(addonSrc, 'utf8');

  // If ZYLOS.md was converted from a legacy CLAUDE.md (migration marker present)
  // and we're building AGENTS.md for Codex, prepend a plain-text warning that
  // Codex can read. The migrated file may contain Claude-specific directives
  // (EnterPlanMode, Task, WebFetch) that Codex cannot follow.
  const MIGRATION_MARKER = '<!-- MIGRATION NOTE (zylos v0.4.0)';
  const migrationWarning = (runtime === 'codex' && core.includes(MIGRATION_MARKER))
    ? '> **MIGRATION WARNING**: This AGENTS.md was generated from a CLAUDE.md that' +
      ' may contain Claude-only instructions. Review ~/zylos/ZYLOS.md and remove' +
      ' any Claude-specific rules (e.g. EnterPlanMode, Task) before relying on this file.\n\n'
    : '';

  let content = migrationWarning + core.trimEnd() + '\n\n' + addon.trimEnd() + '\n';

  // memorySnapshot is codex-only: injected into AGENTS.md before launch so the
  // agent has memory context from the previous session.
  if (runtime === 'codex' && opts.memorySnapshot) {
    content += '\n' + opts.memorySnapshot.trimEnd() + '\n';
  }

  // Atomic write: write to temp then rename
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = destPath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, destPath);

  return destPath;
}

/**
 * Build both CLAUDE.md and AGENTS.md.
 * Used after upgrade migration to ensure both files are current.
 */
export function buildAllInstructionFiles() {
  buildInstructionFile('claude');
  buildInstructionFile('codex');
}

/**
 * Check whether the instruction files need rebuilding.
 * Returns true if either the core template or the relevant addon is newer
 * than the generated output file.
 *
 * @param {'claude'|'codex'} runtime
 * @returns {boolean}
 */
export function needsRebuild(runtime) {
  const destPath = OUTPUT_FILES[runtime];
  if (!fs.existsSync(destPath)) return true;

  const destMtime = fs.statSync(destPath).mtimeMs;
  const userZylosMd = path.join(ZYLOS_DIR, 'ZYLOS.md');
  const coreFile = fs.existsSync(userZylosMd) ? userZylosMd : TEMPLATE_FILES.core;
  const coreMtime = fs.existsSync(coreFile)
    ? fs.statSync(coreFile).mtimeMs : 0;
  const addonSrc = runtime === 'codex' ? TEMPLATE_FILES.codexAddon : TEMPLATE_FILES.claudeAddon;
  const addonMtime = fs.existsSync(addonSrc)
    ? fs.statSync(addonSrc).mtimeMs : 0;

  return coreMtime > destMtime || addonMtime > destMtime;
}

/**
 * Get the instruction file path for a runtime without building it.
 * @param {'claude'|'codex'} runtime
 * @returns {string}
 */
export function getInstructionFilePath(runtime) {
  return OUTPUT_FILES[runtime];
}
