/**
 * Shared utilities for hook management.
 * Used by self-upgrade.js and sync-settings-hooks.js.
 */

import path from 'node:path';
import os from 'node:os';

const SCRIPT_EXT_RE = /\.(?:[cm]?js|jsx|tsx?|sh|bash|zsh|py|rb|pl|php|lua)$/i;
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno']);

function expandHome(scriptPath) {
  return scriptPath.startsWith('~/') ? path.join(os.homedir(), scriptPath.slice(2)) : scriptPath;
}

function commandSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
  }

  segments.push(current);
  return segments.map(segment => segment.trim()).filter(Boolean);
}

function shellTokens(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const ch of segment) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

function interpreterName(token) {
  return path.basename(token.replaceAll('\\', '/'));
}

function looksLikeScript(token) {
  return SCRIPT_EXT_RE.test(token);
}

function fallbackScriptPath(command) {
  let result = null;
  for (const raw of shellTokens(command)) {
    const token = raw.replace(/^["']|["']$/g, '');
    if (token.includes('/') && looksLikeScript(token)) {
      result = token;
    }
  }
  return result;
}

/**
 * Extract the script file path from a hook command.
 * e.g. "node ~/zylos/.claude/skills/foo/scripts/bar.js --flag"
 *   -> "/home/user/zylos/.claude/skills/foo/scripts/bar.js"
 * Falls back to the full command if no path-like token is found.
 */
export function extractScriptPath(command) {
  if (typeof command !== 'string') return '';

  const segments = commandSegments(command);
  const lastSegment = segments.at(-1) || command;
  const tokens = shellTokens(lastSegment);
  const interpreterIndex = tokens.findIndex(token => INTERPRETERS.has(interpreterName(token)));
  if (interpreterIndex !== -1) {
    for (const token of tokens.slice(interpreterIndex + 1)) {
      if (token.startsWith('-')) continue;
      if (looksLikeScript(token)) return expandHome(token);
      break;
    }
  }

  const result = fallbackScriptPath(command);
  return result ? expandHome(result) : command;
}

function zylosClaudeRoot() {
  const zylosDir = path.resolve(process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'));
  return `${path.resolve(zylosDir, '.claude').replaceAll('\\', '/').replace(/\/+$/, '')}/`;
}

function normalizedAbsolutePath(scriptPath) {
  return path.resolve(scriptPath).replaceAll('\\', '/');
}

/**
 * Extract the value of a `--shard <name>` argument from a hook command, or
 * null when the command has none.
 */
export function extractShardArg(command) {
  if (typeof command !== 'string') return null;
  const lastSegment = commandSegments(command).at(-1) || command;
  const tokens = shellTokens(lastSegment);
  const index = tokens.indexOf('--shard');
  if (index === -1) return null;
  const value = tokens[index + 1];
  return value && !value.startsWith('-') ? value : null;
}

/**
 * Script-identity key without shard discrimination. This is the key used for
 * "is this a zylos-core-managed script" checks (CORE_MANAGED_HOOKS lists bare
 * script paths, and every `--shard` variant of a core script is core-managed).
 * Only hooks under the zylos-owned .claude directory are reduced to registry
 * suffixes; other paths keep their full normalized path to avoid user hook
 * collisions.
 */
export function hookScriptBaseKey(command) {
  const scriptPath = normalizedAbsolutePath(
    extractScriptPath(command).replaceAll('\\', '/').split(path.sep).join('/')
  );
  const root = zylosClaudeRoot();
  if (scriptPath.startsWith(root)) return scriptPath.slice(root.length);

  return scriptPath;
}

/**
 * Return the canonical key used to compare hook command identity. Shard-mode
 * commands (`--shard <name>`) get a `#shard=<name>` suffix so the N shard
 * commands of the same orchestrator script sync independently instead of
 * colliding on one script-path key.
 */
export function hookScriptKey(command) {
  const base = hookScriptBaseKey(command);
  const shard = extractShardArg(command);
  return shard ? `${base}#shard=${shard}` : base;
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
