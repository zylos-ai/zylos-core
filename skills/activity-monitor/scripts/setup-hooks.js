#!/usr/bin/env node
/**
 * Setup activity tracking hooks in Claude Code settings.json.
 *
 * Merges hook-activity.js as an async hook on UserPromptSubmit,
 * PreToolUse, PostToolUse, Stop, and Notification(idle_prompt).
 *
 * Safe to run multiple times — only adds hooks that aren't already present.
 * Never removes or modifies existing user hooks.
 *
 * Usage:
 *   node setup-hooks.js           # Install hooks
 *   node setup-hooks.js --remove  # Remove hooks (for uninstall)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

function expandHomeDir(p) {
  if (p === '~') {
    return os.homedir();
  }
  if (typeof p === 'string' && p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

const ZYLOS_DIR = path.resolve(expandHomeDir(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos')));
const SETTINGS_PATH = path.join(ZYLOS_DIR, '.claude', 'settings.json');

// The hook command — used both for adding and for identifying our hooks
const HOOK_SCRIPT_PATH = path.join(ZYLOS_DIR, '.claude', 'skills', 'activity-monitor', 'scripts', 'hook-activity.js');
const HOOK_SCRIPT = `node "${HOOK_SCRIPT_PATH}"`;
const HOOK_IDENTIFIER = 'hook-activity.js';

// Hook definitions: event → matcher (empty string = match all, null = no matcher support)
const HOOK_EVENTS = {
  UserPromptSubmit: null,
  PreToolUse: '',
  PostToolUse: '',
  Stop: null,
  Notification: 'idle_prompt'
};

function makeHookEntry(matcher) {
  const entry = { hooks: [{ type: 'command', command: HOOK_SCRIPT, async: true, timeout: 5 }] };
  if (matcher !== null) {
    entry.matcher = matcher;
  }
  return entry;
}

function hasOurHook(matcherGroups) {
  if (!Array.isArray(matcherGroups)) return false;
  return matcherGroups.some(group =>
    Array.isArray(group?.hooks) && group.hooks.some(
      h => typeof h?.command === 'string' && h.command.includes(HOOK_IDENTIFIER)
    )
  );
}

function removeOurHook(matcherGroups) {
  if (!Array.isArray(matcherGroups)) return matcherGroups;
  return matcherGroups.filter(group => {
    if (!Array.isArray(group?.hooks)) return true;
    return !group.hooks.some(
      h => typeof h?.command === 'string' && h.command.includes(HOOK_IDENTIFIER)
    );
  });
}

function install() {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Activity hooks: failed to parse ${SETTINGS_PATH}: ${message}`);
      process.exit(1);
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  let added = 0;
  let skipped = 0;

  for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
    }

    if (hasOurHook(settings.hooks[event])) {
      skipped++;
      continue;
    }

    settings.hooks[event].push(makeHookEntry(matcher));
    added++;
  }

  // Ensure directory exists
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

  if (added > 0) {
    console.log(`Activity hooks: ${added} added, ${skipped} already present.`);
  } else {
    console.log(`Activity hooks: all ${skipped} already present (no changes).`);
  }
}

function remove() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log('Activity hooks: settings.json not found, nothing to remove.');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    console.log('Activity hooks: failed to parse settings.json, skipping removal.');
    return;
  }

  if (!settings.hooks) {
    console.log('Activity hooks: no hooks section found, nothing to remove.');
    return;
  }

  let removed = 0;

  for (const event of Object.keys(HOOK_EVENTS)) {
    if (!Array.isArray(settings.hooks[event])) continue;

    const before = settings.hooks[event].length;
    settings.hooks[event] = removeOurHook(settings.hooks[event]);
    const after = settings.hooks[event].length;

    if (after < before) removed++;

    // Clean up empty arrays
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Activity hooks: ${removed} removed.`);
}

const mode = process.argv[2];
if (mode === '--remove') {
  remove();
} else {
  install();
}
