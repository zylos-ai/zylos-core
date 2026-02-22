#!/usr/bin/env node
/**
 * Sync settings.json hooks from template to installed settings.
 *
 * Compares template hooks with installed hooks by script path:
 * - Missing hooks → add
 * - Modified hooks → update (command, timeout)
 * - Removed hooks (core skills only) → remove
 * - User hooks (non-core skills) → preserve
 *
 * Called from postinstall.js and from self-upgrade step 8 (which shells
 * out to the newly installed copy of this script).
 *
 * Usage:
 *   node sync-settings-hooks.js           # Sync hooks
 *   node sync-settings-hooks.js --dry-run # Show what would change
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { extractScriptPath, extractSkillName, getCommandHooks } from './hook-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZYLOS_DIR = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
const TEMPLATE_SETTINGS = path.join(__dirname, '..', '..', 'templates', '.claude', 'settings.json');
const INSTALLED_SETTINGS = path.join(ZYLOS_DIR, '.claude', 'settings.json');

function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(TEMPLATE_SETTINGS)) {
    console.log('Settings hooks: template not found, skipping.');
    return;
  }

  let templateSettings, installedSettings;
  try {
    templateSettings = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS, 'utf8'));
  } catch {
    console.log('Settings hooks: failed to parse template, skipping.');
    return;
  }
  try {
    installedSettings = fs.existsSync(INSTALLED_SETTINGS)
      ? JSON.parse(fs.readFileSync(INSTALLED_SETTINGS, 'utf8'))
      : {};
  } catch {
    installedSettings = {};
  }

  const templateHooks = templateSettings.hooks || {};
  const installedHooks = installedSettings.hooks || {};

  // Collect core skill names from template
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

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Ensure hooks object exists
  if (!installedSettings.hooks) installedSettings.hooks = {};

  // --- Forward pass: add missing, update modified ---
  for (const [event, matchers] of Object.entries(templateHooks)) {
    if (!Array.isArray(matchers)) continue;
    if (!Array.isArray(installedSettings.hooks[event])) {
      installedSettings.hooks[event] = [];
    }
    const installedMatchers = installedSettings.hooks[event];

    for (const matcher of matchers) {
      for (const templateCmd of getCommandHooks(matcher)) {
        const templateKey = extractScriptPath(templateCmd.command);

        // Find installed hook with the same script path
        let matched = null;
        let matchedGroup = null;
        for (const im of installedMatchers) {
          const found = getCommandHooks(im).find(
            h => extractScriptPath(h.command) === templateKey
          );
          if (found) {
            matched = found;
            matchedGroup = im;
            break;
          }
        }

        if (!matched) {
          // Missing — add it
          if (!dryRun) {
            const matcherValue = matcher.matcher !== undefined ? matcher.matcher : null;
            let targetGroup = null;
            if (matcherValue !== null) {
              targetGroup = installedMatchers.find(g => g.matcher === matcherValue);
            }
            if (!targetGroup) {
              targetGroup = { hooks: [] };
              if (matcherValue !== null) targetGroup.matcher = matcherValue;
              installedMatchers.push(targetGroup);
            }
            targetGroup.hooks.push({ ...templateCmd });
          }
          added++;
          console.log(`  + ${event}: ${templateCmd.command}`);
        } else if (matched.command !== templateCmd.command || matched.timeout !== templateCmd.timeout) {
          // Modified — update
          if (!dryRun) {
            matched.command = templateCmd.command;
            if (templateCmd.timeout !== undefined) matched.timeout = templateCmd.timeout;
          }
          updated++;
          console.log(`  ~ ${event}: ${templateCmd.command}`);
        }
      }
    }
  }

  // --- Reverse pass: remove obsolete core hooks ---
  for (const [event, matchers] of Object.entries(installedSettings.hooks)) {
    if (!Array.isArray(matchers)) continue;

    const templateMatchers = Array.isArray(templateHooks[event]) ? templateHooks[event] : [];

    for (let gi = matchers.length - 1; gi >= 0; gi--) {
      const group = matchers[gi];
      if (!Array.isArray(group.hooks)) continue;

      for (let hi = group.hooks.length - 1; hi >= 0; hi--) {
        const h = group.hooks[hi];
        if (h.type !== 'command') continue;

        const skillName = extractSkillName(h.command);
        if (!skillName || !coreSkillNames.has(skillName)) continue;

        const installedKey = extractScriptPath(h.command);
        const foundInTemplate = templateMatchers.some(tm =>
          getCommandHooks(tm).some(th => extractScriptPath(th.command) === installedKey)
        );

        if (!foundInTemplate) {
          if (!dryRun) {
            group.hooks.splice(hi, 1);
          }
          removed++;
          console.log(`  - ${event}: ${h.command}`);
        }
      }

      // Remove empty groups
      if (!dryRun && group.hooks.length === 0) {
        matchers.splice(gi, 1);
      }
    }

    // Clean up empty event arrays
    if (!dryRun && matchers.length === 0) {
      delete installedSettings.hooks[event];
    }
  }

  // --- Sync top-level statusLine from template ---
  let statusLineChanged = false;
  if (templateSettings.statusLine) {
    const tsl = JSON.stringify(templateSettings.statusLine);
    const isl = JSON.stringify(installedSettings.statusLine || null);
    if (tsl !== isl) {
      const symbol = installedSettings.statusLine ? '~' : '+';
      if (!dryRun) {
        installedSettings.statusLine = templateSettings.statusLine;
      }
      statusLineChanged = true;
      console.log(`  ${symbol} statusLine: ${templateSettings.statusLine.command || '(set)'}`);
    }
  } else if (installedSettings.statusLine) {
    // Template removed statusLine — clean up installed copy
    if (!dryRun) {
      delete installedSettings.statusLine;
    }
    statusLineChanged = true;
    console.log(`  - statusLine: (removed)`);
  }

  if (added === 0 && updated === 0 && removed === 0 && !statusLineChanged) {
    console.log('Settings hooks: all up to date (no changes).');
    return;
  }

  if (dryRun) {
    console.log(`Settings hooks (dry run): ${added} to add, ${updated} to update, ${removed} to remove${statusLineChanged ? ', statusLine to update' : ''}.`);
    return;
  }

  // Write back
  const dir = path.dirname(INSTALLED_SETTINGS);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(INSTALLED_SETTINGS, JSON.stringify(installedSettings, null, 2) + '\n');
  console.log(`Settings hooks: ${added} added, ${updated} updated, ${removed} removed${statusLineChanged ? ', statusLine updated' : ''}.`);
}

main();
