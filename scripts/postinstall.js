/**
 * Postinstall script - runs after `npm install -g zylos`
 *
 * Syncs Core Skills from the installed package to the Zylos
 * skills directory, preserving any user modifications.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
const CORE_SKILLS_SRC = path.join(__dirname, '..', 'skills');

function main() {
  // Skip if running in CI or if zylos hasn't been initialized
  if (process.env.CI || process.env.ZYLOS_SKIP_POSTINSTALL) {
    return;
  }

  if (!fs.existsSync(SKILLS_DIR)) {
    // Zylos not initialized yet - init command will handle skill sync
    console.log('Zylos not initialized. Run "zylos init" to set up.');
    return;
  }

  if (!fs.existsSync(CORE_SKILLS_SRC)) {
    // No skills bundled (shouldn't happen in normal install)
    return;
  }

  console.log('Syncing Core Skills...');
  let synced = 0;
  let skipped = 0;

  const entries = fs.readdirSync(CORE_SKILLS_SRC, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const srcDir = path.join(CORE_SKILLS_SRC, entry.name);
    const destDir = path.join(SKILLS_DIR, entry.name);

    if (fs.existsSync(destDir)) {
      // Skill already exists - don't overwrite (preserves user modifications)
      skipped++;
      continue;
    }

    try {
      execSync(`cp -r "${srcDir}" "${destDir}"`, { stdio: 'pipe' });
      console.log(`  + ${entry.name}`);
      synced++;
    } catch {
      console.log(`  Warning: Failed to sync ${entry.name}`);
    }
  }

  if (synced > 0 || skipped > 0) {
    console.log(`Core Skills: ${synced} synced, ${skipped} already present.`);
  }

  // Configure activity tracking hooks in Claude Code settings.json
  const setupHooks = path.join(SKILLS_DIR, 'activity-monitor', 'scripts', 'setup-hooks.js');
  if (fs.existsSync(setupHooks)) {
    try {
      execSync(`node "${setupHooks}"`, {
        stdio: 'inherit',
        env: { ...process.env, ZYLOS_DIR }
      });
    } catch {
      console.log('  Warning: Failed to configure activity hooks');
    }
  }
}

main();
