/**
 * Pending instruction-migration prompt shard emitter.
 *
 * This script deliberately inspects the stable on-disk protocol directly.
 * The deployed skill lives under ~/.claude and cannot import the package CLI
 * through a repository-relative path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function migrationPromptPaths({ env = process.env, zylosDir } = {}) {
  const root = path.resolve(zylosDir || env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  return {
    markerPath: path.join(root, '.zylos', 'instructions', 'meta.json'),
    promptPath: path.join(root, '.zylos', 'pending-migration-prompt.md'),
  };
}

/**
 * Emit the pending prompt only while the split marker is inactive.
 *
 * Once the marker exists, activation is authoritative: stale prompt cleanup
 * is best-effort and cleanup failure must never allow the prompt to reappear.
 * `io` is injectable so marker/read/unlink failures can be fault-tested without
 * depending on where this installed script is located.
 */
export function emitMigrationPrompt({
  env = process.env,
  zylosDir,
  io = fs,
} = {}) {
  const { markerPath, promptPath } = migrationPromptPaths({ env, zylosDir });
  const active = io.existsSync(markerPath);

  if (active) {
    try {
      if (io.existsSync(promptPath)) io.unlinkSync(promptPath);
    } catch {
      // Activation remains authoritative. Retry cleanup on a later session.
    }
    return '';
  }

  try {
    if (!io.existsSync(promptPath)) return '';
    const content = io.readFileSync(promptPath, 'utf8').trim();
    if (!content) return '';
    return `=== PENDING MIGRATION ===\n${content}`;
  } catch {
    // An unreadable prompt must not break the session-start chain.
    return '';
  }
}
