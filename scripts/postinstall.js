/**
 * Postinstall script - runs after `npm install -g zylos`
 *
 * Two responsibilities:
 * 1. Sync Core Skills (skipped during self-upgrade — step 5 handles it)
 * 2. Sync settings.json hooks/statusLine (ALWAYS runs when zylos is initialized)
 *
 * Settings sync runs even when ZYLOS_SKIP_POSTINSTALL is set because this is
 * the only reliable hook where the NEWLY INSTALLED code executes during
 * self-upgrade. The old version's step 8 may not know about new config fields
 * (e.g. statusLine added in v0.2.1), so this postinstall catches them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const SKILLS_DIR = path.join(ZYLOS_DIR, '.claude', 'skills');
const CORE_SKILLS_SRC = path.join(__dirname, '..', 'skills');

function syncSkills() {
  if (!fs.existsSync(CORE_SKILLS_SRC)) {
    // No skills bundled — shouldn't happen in a normal install
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
      execFileSync('cp', ['-r', srcDir, destDir], { stdio: 'pipe' });
      console.log(`  + ${entry.name}`);
      synced++;
    } catch (err) {
      console.log(`  Warning: Failed to sync ${entry.name}: ${err.message}`);
    }
  }

  if (synced > 0 || skipped > 0) {
    console.log(`Core Skills: ${synced} synced, ${skipped} already present.`);
  }
}

function syncSettings() {
  const syncHooks = path.join(__dirname, '..', 'cli', 'lib', 'sync-settings-hooks.js');
  const templateSettings = path.join(__dirname, '..', 'templates', '.claude', 'settings.json');

  if (!fs.existsSync(syncHooks) || !fs.existsSync(templateSettings)) {
    return;
  }

  try {
    execFileSync(process.execPath, [syncHooks], {
      stdio: 'inherit',
      env: { ...process.env, ZYLOS_DIR }
    });
  } catch (err) {
    console.log(`  Warning: Failed to sync settings hooks: ${err.message}`);
  }
}

function main() {
  // CI: skip everything
  if (process.env.CI) return;

  // Zylos must be initialized — .claude/ directory exists after `zylos init`
  const claudeDir = path.join(ZYLOS_DIR, '.claude');
  if (!fs.existsSync(claudeDir)) {
    console.log('Zylos not initialized. Run "zylos init" to set up.');
    return;
  }

  const isSelfUpgrade = !!process.env.ZYLOS_SKIP_POSTINSTALL;

  if (!isSelfUpgrade) {
    // Fresh install or manual `npm install -g` — sync skills
    // During self-upgrade, step 5 handles skill sync with smart merge
    syncSkills();
  }

  // Settings sync ALWAYS runs when zylos is initialized.
  // During self-upgrade this is defense-in-depth: the old version's step 8
  // may lack knowledge of new config fields. This postinstall is the only
  // code path where the newly installed version's logic executes.
  syncSettings();
}

main();
