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

const EMPTY_MANIFEST = Object.freeze({
  envNames: [], inheritNames: [], pathPrepend: [], pathAppend: [],
});

/**
 * Parse runtime-env.manifest content into structured directives.
 * Line-based format: env NAME, inherit NAME, path_prepend PATH, path_append PATH.
 */
export function parseRuntimeEnvManifest(content, warnings = []) {
  const result = { envNames: [], inheritNames: [], pathPrepend: [], pathAppend: [] };
  if (!content) return result;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const tokens = line.split(/\s+/);
    const directive = tokens[0];
    const arg = tokens[1];

    if (tokens.length > 2) {
      warnings.push(`runtime-env.manifest: too many tokens: "${line}"`);
      continue;
    }

    if (!arg) {
      warnings.push(`runtime-env.manifest: missing argument: "${line}"`);
      continue;
    }

    switch (directive) {
      case 'env':
        if (VALID_NAME.test(arg)) {
          result.envNames.push(arg);
        } else {
          warnings.push(`runtime-env.manifest: invalid env var name: "${arg}"`);
        }
        break;
      case 'inherit':
        if (VALID_NAME.test(arg)) {
          result.inheritNames.push(arg);
        } else {
          warnings.push(`runtime-env.manifest: invalid env var name: "${arg}"`);
        }
        break;
      case 'path_prepend':
        if (arg.startsWith('/')) {
          result.pathPrepend.push(arg);
        } else {
          warnings.push(`runtime-env.manifest: relative path skipped: "${arg}"`);
        }
        break;
      case 'path_append':
        if (arg.startsWith('/')) {
          result.pathAppend.push(arg);
        } else {
          warnings.push(`runtime-env.manifest: relative path skipped: "${arg}"`);
        }
        break;
      default:
        warnings.push(`runtime-env.manifest: unknown directive: "${directive}"`);
    }
  }

  return result;
}

/**
 * Deploy runtime-env.manifest from template if it does not already exist.
 * @returns {'created'|'exists'|'template_missing'} Status of the deployment.
 */
export function deployManifestTemplate(templatePath, zylosDir) {
  const dest = path.join(zylosDir, '.zylos', 'runtime-env.manifest');
  if (fs.existsSync(dest)) return 'exists';
  if (!fs.existsSync(templatePath)) return 'template_missing';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(templatePath, dest);
  return 'created';
}

/**
 * Load and parse runtime-env.manifest from ZYLOS_DIR/.zylos/.
 * Returns empty manifest if file is missing.
 */
export function loadRuntimeEnvManifest(zylosDir, warnings = []) {
  try {
    const content = fs.readFileSync(
      path.join(zylosDir, '.zylos', 'runtime-env.manifest'), 'utf8',
    );
    return parseRuntimeEnvManifest(content, warnings);
  } catch {
    return { ...EMPTY_MANIFEST, envNames: [], inheritNames: [], pathPrepend: [], pathAppend: [] };
  }
}

/**
 * Parse a comma-separated PATH manifest into validated absolute paths.
 * Relative paths are skipped with a warning. Empty items are silently skipped.
 */
export function parsePathManifest(value, warnings, keyName) {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(p => {
      if (p.startsWith('/')) return true;
      warnings.push(`${keyName}: relative path skipped: "${p}"`);
      return false;
    });
}

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
 * Order: user dirs → nvm → PREPEND → platform (Homebrew) → system → APPEND.
 * PREPEND/APPEND are "before/after platform+system base paths", not before user dirs.
 */
function _buildPath(processEnv, platform, pathPrepend, pathAppend) {
  const home = processEnv.HOME || os.homedir();

  const userDirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'bin'),
  ];

  const currentParts = (processEnv.PATH || '').split(':').filter(Boolean);
  const nvmParts = currentParts.filter(p => p.includes('.nvm'));

  const platformPaths = [];
  if (platform === 'darwin') {
    platformPaths.push('/opt/homebrew/bin', '/opt/homebrew/sbin');
  }

  const systemPaths = [
    '/usr/local/sbin', '/usr/local/bin',
    '/usr/sbin', '/usr/bin',
    '/sbin', '/bin',
  ];

  const allParts = [
    ...userDirs, ...nvmParts,
    ...pathPrepend,
    ...platformPaths, ...systemPaths,
    ...pathAppend,
  ];
  return [...new Set(allParts)].join(':');
}

/**
 * Build a clean environment object (ZYLOS_CLEAN_ENV=true).
 * Merges manifest file directives with legacy .env keys (ZYLOS_TMUX_ENV, etc.).
 * Manifest entries take precedence (listed first in dedup).
 *
 * @param {object} opts
 * @param {object} opts.processEnv - AM's process.env
 * @param {object} opts.dotenvVars - Parsed .env file key-value pairs
 * @param {object} [opts.manifest] - Parsed runtime-env.manifest (from parseRuntimeEnvManifest)
 * @param {string} [opts.platform] - os.platform() value, defaults to current
 * @param {number} [opts.uid] - Process UID; when 0, IS_SANDBOX is set for root/Docker safety
 * @returns {{ env: object, warnings: string[] }}
 */
export function buildCleanEnv({ processEnv, dotenvVars, manifest, platform, uid }) {
  const plat = platform || os.platform();
  const m = manifest || EMPTY_MANIFEST;
  const warnings = [];
  const env = {};

  // Merge PATH manifest + .env PATH keys (manifest first → wins on dedup)
  const dotenvPrepend = parsePathManifest(
    dotenvVars.ZYLOS_TMUX_PATH_PREPEND, warnings, 'ZYLOS_TMUX_PATH_PREPEND',
  );
  const allPrepend = [...new Set([...m.pathPrepend, ...dotenvPrepend])];

  const dotenvAppend = parsePathManifest(
    dotenvVars.ZYLOS_TMUX_PATH_APPEND, warnings, 'ZYLOS_TMUX_PATH_APPEND',
  );
  const allAppend = [...new Set([...m.pathAppend, ...dotenvAppend])];

  // 1. Base set
  env.PATH = _buildPath(processEnv, plat, allPrepend, allAppend);
  env.HOME = processEnv.HOME || os.homedir();
  env.USER = processEnv.USER || os.userInfo().username;
  env.LOGNAME = processEnv.LOGNAME || env.USER;
  env.LANG = processEnv.LANG || 'en_US.UTF-8';
  env.LC_ALL = processEnv.LC_ALL || 'en_US.UTF-8';
  env.TERM = processEnv.TERM || 'xterm-256color';
  env.SHELL = processEnv.SHELL || '/bin/bash';

  // 2. Agent automation defaults
  env.GH_PROMPT_DISABLED = '1';

  // 3. Platform-specific
  if (plat === 'darwin' && processEnv.TMPDIR) {
    env.TMPDIR = processEnv.TMPDIR;
  }

  // 4. Built-in allowlist exceptions (auto-inherit from processEnv)
  for (const name of PROXY_VARS) {
    if (processEnv[name]) env[name] = processEnv[name];
  }
  if (processEnv.IS_SANDBOX) {
    env.IS_SANDBOX = processEnv.IS_SANDBOX;
  } else if (uid === 0) {
    env.IS_SANDBOX = '1';
  }

  // 5. env directives — merge manifest + .env key (manifest first → wins on dedup)
  const dotenvEnvNames = parseManifest(dotenvVars.ZYLOS_TMUX_ENV, warnings);
  const allEnvNames = [...new Set([...m.envNames, ...dotenvEnvNames])];
  for (const name of allEnvNames) {
    if (dotenvVars[name] !== undefined) {
      env[name] = dotenvVars[name];
    }
  }

  // 6. inherit directives — merge manifest + .env key (lower priority than env)
  const dotenvInheritNames = parseManifest(dotenvVars.ZYLOS_TMUX_INHERIT, warnings);
  const allInheritNames = [...new Set([...m.inheritNames, ...dotenvInheritNames])];
  for (const name of allInheritNames) {
    if (env[name] === undefined && processEnv[name] !== undefined) {
      env[name] = processEnv[name];
    }
  }

  return { env, warnings };
}

/**
 * Build a compat environment object (ZYLOS_CLEAN_ENV=false, default).
 * Passes through full processEnv with manifest variable overrides from dotenvVars.
 * Does NOT read the runtime-env.manifest file.
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
