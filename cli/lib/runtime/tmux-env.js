import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BASE_VARS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SHELL'];

// Built-in allowlist exceptions — auto-inherited from processEnv when present.
const PROXY_VARS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];

/**
 * Parse a comma-separated manifest string into validated variable names.
 * Invalid names are skipped and recorded in warnings.
 */
export function parseManifest(manifestStr, warnings = []) {
  if (!manifestStr) return [];
  return manifestStr
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(name => {
      if (VALID_NAME.test(name)) return true;
      warnings.push(`Invalid env var name skipped: "${name}"`);
      return false;
    });
}

/**
 * Build a clean PATH ensuring key directories exist.
 * Extracts .nvm segments from the current processEnv.PATH.
 */
function _buildPath(processEnv) {
  const home = processEnv.HOME || os.homedir();
  const basePaths = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'bin'),
    '/usr/local/sbin', '/usr/local/bin',
    '/usr/sbin', '/usr/bin',
    '/sbin', '/bin',
  ];

  // Extract .nvm path segments from current PATH
  const currentParts = (processEnv.PATH || '').split(':').filter(Boolean);
  const nvmParts = currentParts.filter(p => p.includes('.nvm'));

  const allParts = [...basePaths.slice(0, 2), ...nvmParts, ...basePaths.slice(2)];
  return [...new Set(allParts)].join(':');
}

/**
 * Build a clean environment object (ZYLOS_CLEAN_ENV=true).
 * Starts from an empty object; only explicitly declared variables are included.
 *
 * @param {object} opts
 * @param {object} opts.processEnv - AM's process.env
 * @param {object} opts.dotenvVars - Parsed .env file key-value pairs
 * @param {string} [opts.platform] - os.platform() value, defaults to current
 * @param {number} [opts.uid] - Process UID; when 0, IS_SANDBOX is set for root/Docker safety
 * @returns {{ env: object, warnings: string[] }}
 */
export function buildCleanEnv({ processEnv, dotenvVars, platform, uid }) {
  const plat = platform || os.platform();
  const warnings = [];
  const env = {};

  // 1. Base set
  env.PATH = _buildPath(processEnv);
  env.HOME = processEnv.HOME || os.homedir();
  env.USER = processEnv.USER || os.userInfo().username;
  env.LOGNAME = processEnv.LOGNAME || env.USER;
  env.LANG = processEnv.LANG || 'en_US.UTF-8';
  env.LC_ALL = processEnv.LC_ALL || 'en_US.UTF-8';
  env.TERM = processEnv.TERM || 'xterm-256color';
  env.SHELL = processEnv.SHELL || '/bin/bash';

  // 2. Platform-specific
  if (plat === 'darwin' && processEnv.TMPDIR) {
    env.TMPDIR = processEnv.TMPDIR;
  }

  // 3. Built-in allowlist exceptions (auto-inherit from processEnv)
  for (const name of PROXY_VARS) {
    if (processEnv[name]) env[name] = processEnv[name];
  }
  if (processEnv.IS_SANDBOX) {
    env.IS_SANDBOX = processEnv.IS_SANDBOX;
  } else if (uid === 0) {
    env.IS_SANDBOX = '1';
  }

  // 4. ZYLOS_TMUX_ENV — read values from dotenvVars
  const tmuxEnvNames = parseManifest(dotenvVars.ZYLOS_TMUX_ENV, warnings);
  for (const name of tmuxEnvNames) {
    if (dotenvVars[name] !== undefined) {
      env[name] = dotenvVars[name];
    }
  }

  // 5. ZYLOS_TMUX_INHERIT — read values from processEnv (lower priority)
  const tmuxInheritNames = parseManifest(dotenvVars.ZYLOS_TMUX_INHERIT, warnings);
  for (const name of tmuxInheritNames) {
    if (env[name] === undefined && processEnv[name] !== undefined) {
      env[name] = processEnv[name];
    }
  }

  return { env, warnings };
}

/**
 * Build a compat environment object (ZYLOS_CLEAN_ENV=false, default).
 * Passes through full processEnv with manifest variable overrides from dotenvVars.
 *
 * Security note: the resulting env contains the full processEnv and may include
 * secrets. Protected by spec file 0600 permissions + unlink-before-spawn.
 *
 * @param {object} opts
 * @param {object} opts.processEnv
 * @param {object} opts.dotenvVars
 * @returns {{ env: object }}
 */
export function buildCompatEnv({ processEnv, dotenvVars }) {
  const env = { ...processEnv };

  // Deduplicate PATH to prevent bloat across restarts (PR #499 defense)
  if (env.PATH) {
    env.PATH = [...new Set(env.PATH.split(':').filter(Boolean))].join(':');
  }

  // Override with ZYLOS_TMUX_ENV manifest vars from dotenvVars
  const warnings = [];
  const tmuxEnvNames = parseManifest(dotenvVars.ZYLOS_TMUX_ENV, warnings);
  for (const name of tmuxEnvNames) {
    if (dotenvVars[name] !== undefined) {
      env[name] = dotenvVars[name];
    }
  }

  return { env };
}

/**
 * Write a launch spec to a temp JSON file with 0600 permissions.
 *
 * @param {object} spec - { command, args, env, cwd }
 * @returns {string} Path to the spec file
 */
export function writeLaunchSpec(spec) {
  const specPath = path.join(os.tmpdir(), `.zylos-launch-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  return specPath;
}

/**
 * Read and immediately delete a spec file (unlink-before-spawn).
 *
 * @param {string} specPath
 * @returns {object} The parsed spec object
 */
export function readAndDeleteSpec(specPath) {
  const content = fs.readFileSync(specPath, 'utf8');
  fs.unlinkSync(specPath);
  return JSON.parse(content);
}
