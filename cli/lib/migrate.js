/** Data migrations between zylos-core versions. */

import fs from 'node:fs';
import path from 'node:path';
import { ZYLOS_DIR } from './config.js';

const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..');
const DEFAULT_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');

export function runMigrations({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
} = {}) {
  const root = path.resolve(zylosDir);
  const migrated = [];
  if (migrateClaudeMdToZylosMd({ zylosDir: root, templatesDir })) {
    migrated.push('v0.4.0/claude-md-to-zylos-md');
  }
  if (migrateNewSessionThresholdDefaults({ zylosDir: root })) {
    migrated.push('v0.4.11/new-session-threshold-defaults');
  }
  return { migrated };
}

/**
 * Preserve the legacy CLAUDE.md byte-for-byte and seed the user-owned layer.
 * Split activation is intentionally not performed here: P1 marker writers are
 * fresh init and the later P2 migration tool only.
 */
export function migrateClaudeMdToZylosMd({
  zylosDir = ZYLOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  faultInjector = () => {},
} = {}) {
  const root = path.resolve(zylosDir);
  const claudePath = path.join(root, 'CLAUDE.md');
  const zylosPath = path.join(root, 'ZYLOS.md');

  if (fs.existsSync(zylosPath)) {
    return false;
  }
  if (!fs.existsSync(claudePath)) return false;

  // templatesDir is explicit even though the conservative legacy migration
  // needs no template bytes. Validate the caller did not accidentally bind a
  // live package root while operating on an isolated fixture.
  if (typeof templatesDir !== 'string' || templatesDir.length === 0) {
    throw new TypeError('templatesDir must be a non-empty path');
  }

  const userContent = fs.readFileSync(claudePath, 'utf8');
  const migrationNotice = `<!-- MIGRATION NOTE (zylos v0.4.0): This file was created from your previous
     CLAUDE.md. It may contain Claude-specific instructions. If you plan to
     use Codex, review this file and remove any Claude-only rules before
     switching runtimes via "zylos init --runtime codex". -->\n\n`;
  const tmpPath = `${zylosPath}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(root, { recursive: true });
  try {
    faultInjector('stage:user');
    fs.writeFileSync(tmpPath, migrationNotice + userContent, 'utf8');
    faultInjector('rename:user');
    fs.renameSync(tmpPath, zylosPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { }
  }
  return true;
}

function migrateNewSessionThresholdDefaults({ zylosDir = ZYLOS_DIR } = {}) {
  const configPath = path.join(path.resolve(zylosDir), '.zylos', 'config.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { }
  const updates = {};
  if (config.new_session_threshold === undefined) updates.new_session_threshold = 70;
  if (config.codex_new_session_threshold === undefined) updates.codex_new_session_threshold = 75;
  if (Object.keys(updates).length === 0) return false;
  Object.assign(config, updates);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, configPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { }
  }
  return true;
}
