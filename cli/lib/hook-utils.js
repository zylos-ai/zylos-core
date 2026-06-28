/**
 * Shared utilities for hook management.
 * Used by self-upgrade.js and sync-settings-hooks.js.
 */

import path from 'node:path';
import os from 'node:os';

/**
 * Extract the script file path from a hook command.
 * e.g. "node ~/zylos/.claude/skills/foo/scripts/bar.js --flag"
 *   -> "/home/user/zylos/.claude/skills/foo/scripts/bar.js"
 * Falls back to the full command if no path-like token is found.
 */
export function extractScriptPath(command) {
  if (typeof command !== 'string') return '';
  // Use the LAST path-like token so that shell prefixes
  // (e.g. "source ~/.nvm/nvm.sh && node ~/path/script.js") are skipped
  let result = null;
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (token.includes('/') && /\.\w+$/.test(token)) {
      result = token;
    }
  }
  if (!result) return command;
  // Normalize ~ to absolute path for consistent comparison
  return result.startsWith('~/') ? path.join(os.homedir(), result.slice(2)) : result;
}

/**
 * Return the canonical key used to compare hook script identity. The key is a
 * normalized path suffix rooted at the zylos-owned skills directory when
 * possible, so equivalent absolute and ~/ commands compare equal.
 */
export function hookScriptKey(command) {
  const scriptPath = extractScriptPath(command).replaceAll('\\', '/').split(path.sep).join('/');
  const marker = '/.claude/';
  const markerIndex = scriptPath.indexOf(marker);
  if (markerIndex !== -1) return scriptPath.slice(markerIndex + marker.length);

  const skillsIndex = scriptPath.indexOf('skills/');
  if (skillsIndex !== -1) return scriptPath.slice(skillsIndex);

  return scriptPath;
}

/**
 * Safely get command hooks from a matcher entry.
 */
export function getCommandHooks(matcherEntry) {
  return (matcherEntry && typeof matcherEntry === 'object' && Array.isArray(matcherEntry.hooks)
    ? matcherEntry.hooks
    : []
  ).filter(h => h && h.type === 'command');
}
