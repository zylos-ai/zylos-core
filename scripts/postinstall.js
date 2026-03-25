/**
 * Postinstall script - runs after `npm install -g zylos`
 *
 * Two responsibilities:
 * 1. Sync Core Skills (skipped during self-upgrade — step 5 handles it)
 * 2. Sync settings.json hooks/statusLine and refresh Codex config backfills
 *    (ALWAYS runs when zylos is initialized)
 *
 * Settings sync runs even when ZYLOS_SKIP_POSTINSTALL is set because this is
 * the only reliable hook where the NEWLY INSTALLED code executes during
 * self-upgrade. The old version's in-memory upgrader may not know about new
 * config fields or backfills, so this postinstall catches them.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { smartSync, formatMergeResult } from '../cli/lib/smart-merge.js';
import { copyTree } from '../cli/lib/fs-utils.js';
import { generateManifest, saveManifest, saveOriginals } from '../cli/lib/manifest.js';

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
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const backupBase = path.join(os.tmpdir(), `zylos-postinstall-backup-${Date.now()}`);

  const entries = fs.readdirSync(CORE_SKILLS_SRC, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const srcDir = path.join(CORE_SKILLS_SRC, entry.name);
    const destDir = path.join(SKILLS_DIR, entry.name);

    if (!fs.existsSync(destDir)) {
      // New skill — copy fresh + initialize manifest/originals
      try {
        copyTree(srcDir, destDir);
        const manifest = generateManifest(destDir);
        saveManifest(destDir, manifest);
        saveOriginals(destDir, srcDir);
        console.log(`  + ${entry.name}`);
        added++;
      } catch (err) {
        console.log(`  Warning: Failed to sync ${entry.name}: ${err.message}`);
      }
      continue;
    }

    // Existing skill — smart merge (three-way when manifest exists, overwrite otherwise)
    try {
      const backupDir = path.join(backupBase, entry.name);
      const mergeResult = smartSync(srcDir, destDir, { backupDir });
      const hasChanges = mergeResult.overwritten.length || mergeResult.added.length
        || mergeResult.merged.length || mergeResult.deleted.length || mergeResult.conflicts.length;
      if (hasChanges) {
        const summary = formatMergeResult(mergeResult);
        console.log(`  ~ ${entry.name} (${summary})`);
        updated++;
      } else {
        unchanged++;
      }
      if (mergeResult.conflicts.length) {
        for (const c of mergeResult.conflicts) {
          if (c.backupPath) console.log(`    Conflict backup: ${c.backupPath}`);
        }
      }
    } catch (err) {
      console.log(`  Warning: Failed to update ${entry.name}: ${err.message}`);
    }
  }

  if (added > 0 || updated > 0 || unchanged > 0) {
    console.log(`Core Skills: ${added} added, ${updated} updated, ${unchanged} unchanged.`);
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
