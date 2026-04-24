#!/usr/bin/env node
/**
 * Codex PreToolUse/PermissionRequest guard for path-scoped shell writes.
 *
 * Codex hooks currently intercept Bash only, so this is a guardrail rather than
 * a complete filesystem sandbox. It blocks obvious mutating shell commands when
 * they target paths outside the configured write allowlist.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MUTATING_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'install',
  'tee', 'dd', 'truncate',
]);

const EXEC_WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'time']);

export function evaluateHookInput(input, env = process.env) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return { allow: true };
  }

  const cwd = path.resolve(input.cwd || env.PWD || process.cwd());
  const policy = buildPolicy({ cwd, env });
  const commandCheck = evaluateCommand(command, policy);
  if (!commandCheck.allow) return commandCheck;

  return { allow: true };
}

export function buildPolicy({ cwd, env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  const zylosDir = env.ZYLOS_DIR || findZylosDir(cwd);
  const tmpRoots = [env.TMPDIR, '/tmp'].filter(Boolean);
  const configuredAllowlist = splitPathList(env.ZYLOS_CODEX_RWX_ALLOWLIST);
  const configuredProtected = splitPathList(env.ZYLOS_CODEX_RWX_PROTECTED);

  const allowRoots = normalizeRoots([
    cwd,
    ...tmpRoots,
    ...configuredAllowlist,
  ], { cwd, home });

  const protectedExactRoots = normalizeRoots([
    home,
    cwd,
    zylosDir,
  ].filter(Boolean), { cwd, home });
  const protectedRoots = normalizeRoots([
    zylosDir && path.join(zylosDir, 'workspace'),
    zylosDir && path.join(zylosDir, 'memory'),
    ...configuredProtected,
  ].filter(Boolean), { cwd, home });

  return { cwd, home, allowRoots, protectedExactRoots, protectedRoots };
}

export function evaluateCommand(command, policy) {
  const tokens = tokenizeShell(command);
  if (tokens.length === 0) return { allow: true };

  if (isDestructiveGit(tokens)) {
    return deny('Destructive git operation blocked by Zylos path guard.');
  }

  const mutations = collectMutationTargets(tokens);
  for (const mutation of mutations) {
    const resolved = resolveShellPath(mutation.path, policy);
    if (!resolved) continue;

    if (isProtectedPath(resolved, policy) || !isAllowedPath(resolved, policy)) {
      return deny(`Path outside Codex write allowlist: ${mutation.path}`);
    }
  }

  return { allow: true };
}

export function tokenizeShell(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (';|&()'.includes(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push(char);
      continue;
    }
    if (char === '>') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push('>');
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function collectMutationTargets(tokens) {
  const targets = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '>' || token === '>>') {
      const next = tokens[i + 1];
      if (next) targets.push({ command: 'redirect', path: next });
      continue;
    }

    const commandIndex = findCommandStart(tokens, i);
    if (commandIndex !== i) continue;

    const command = basename(tokens[i]);
    if (!MUTATING_COMMANDS.has(command)) continue;

    const end = findCommandEnd(tokens, i + 1);
    const args = tokens.slice(i + 1, end);
    const pathArgs = args.filter((arg) => isPathArg(command, arg));
    for (const arg of pathArgs) {
      targets.push({ command, path: getMutationPath(command, arg) });
    }
  }

  return targets;
}

function findCommandStart(tokens, index) {
  let i = index;
  while (i > 0 && !isCommandSeparator(tokens[i - 1])) i--;
  return findExecutableIndex(tokens, i);
}

function findExecutableIndex(tokens, start) {
  let i = start;
  while (i < tokens.length && !isCommandSeparator(tokens[i])) {
    const command = basename(tokens[i]);
    if (command === 'env') {
      i++;
      while (
        i < tokens.length
        && !isCommandSeparator(tokens[i])
        && (tokens[i].startsWith('-') || isEnvAssignment(tokens[i]))
      ) {
        i++;
      }
      continue;
    }
    if (EXEC_WRAPPERS.has(command) || isEnvAssignment(tokens[i])) {
      i++;
      continue;
    }
    return i;
  }
  return start;
}

function findCommandEnd(tokens, start) {
  let i = start;
  while (i < tokens.length && !isCommandSeparator(tokens[i])) i++;
  return i;
}

function isCommandSeparator(token) {
  return token === ';' || token === '|' || token === '&' || token === '(' || token === ')';
}

function isPathArg(command, arg) {
  if (!arg || arg === '-' || arg.startsWith('--')) return false;
  if (command === 'dd') return arg.startsWith('of=');
  if (arg.startsWith('-') && command !== 'tee') return false;
  return true;
}

function getMutationPath(command, value) {
  if (command === 'dd' && value.startsWith('of=')) return value.slice(3);
  return value;
}

function isEnvAssignment(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function resolveShellPath(value, policy) {
  if (!value || value.startsWith('$') || value.includes('*')) return null;
  let expanded = value;
  if (expanded === '~') expanded = policy.home;
  else if (expanded.startsWith('~/')) expanded = path.join(policy.home, expanded.slice(2));
  else if (expanded.startsWith('$HOME/')) expanded = path.join(policy.home, expanded.slice(6));
  else if (expanded.startsWith('${HOME}/')) expanded = path.join(policy.home, expanded.slice(8));
  else if (!path.isAbsolute(expanded)) expanded = path.join(policy.cwd, expanded);
  return path.resolve(expanded);
}

function isAllowedPath(target, policy) {
  return policy.allowRoots.some((root) => isSameOrChild(target, root));
}

function isProtectedPath(target, policy) {
  return (policy.protectedExactRoots || []).some((root) => target === root)
    || policy.protectedRoots.some((root) => isSameOrChild(target, root));
}

function isSameOrChild(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeRoots(values, { cwd, home }) {
  const roots = [];
  for (const value of values) {
    const resolved = resolveShellPath(value, { cwd, home });
    if (resolved && !roots.includes(resolved)) roots.push(resolved);
  }
  return roots;
}

function splitPathList(value = '') {
  return value.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
}

function findZylosDir(cwd) {
  let dir = cwd;
  while (dir && dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'skills'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return cwd;
}

function isDestructiveGit(tokens) {
  const compact = tokens.filter((token) => !isCommandSeparator(token));
  for (let i = 0; i < compact.length - 2; i++) {
    if (compact[i] === 'git' && compact[i + 1] === 'reset' && compact.includes('--hard')) return true;
    if (compact[i] === 'git' && compact[i + 1] === 'clean' && compact.slice(i + 2).some((arg) => /^-.*f/.test(arg))) return true;
  }
  return false;
}

function basename(value) {
  return path.basename(value || '');
}

function deny(reason) {
  return { allow: false, reason };
}

function outputDecision(result) {
  if (result.allow) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.reason,
    },
  }) + '\n');
}

async function main() {
  const input = await readStdinJson();
  outputDecision(evaluateHookInput(input));
}

function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {});
}
