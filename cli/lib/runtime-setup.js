/**
 * runtime-setup.js — runtime setup utilities and Codex TOML writers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';
import { parse as parseDotEnv } from 'dotenv';
import { checkPrivateFile } from './private-file.js';
import { installCoreCodexHook } from './codex-hooks.js';

export function upsertEnvValue(content, key, value, comment = null) {
  const line = `${key}=${value}`;
  if (content.match(new RegExp(`^${key}=.*$`, 'm'))) {
    return content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  const prefix = comment ? `\n\n# ${comment}\n` : '\n';
  return content.trimEnd() + `${prefix}${line}\n`;
}

export function credentialEnvValue(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) return null;
  // Preserve the exact credential without adding escape bytes. Use only a
  // lossless dotenv representation and reject unrepresentable input before writing.
  for (const candidate of [value, `'${value}'`, `"${value}"`]) {
    const literal = candidate.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (literal === value && parseDotEnv(`CREDENTIAL=${candidate}\n`).CREDENTIAL === value) return candidate;
  }
  return null;
}

export function isValidBaseUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.host
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

// ── Install ────────────────────────────────────────────────────────────────

/**
 * Install an npm global package.
 * @param {string} pkg - Package name (e.g. "@openai/codex")
 * @returns {boolean}
 */
export function installGlobalPackage(pkg) {
  try {
    execFileSync('npm', ['install', '-g', pkg], { stdio: 'pipe', timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep credential files owner-only and describe the ones that could not be
 * restricted (foreign-owned or read-only). Never throws.
 *
 * @param {string[]} files
 * @returns {string[]} one message per file other users can still read
 */
export function credentialFilePermissionWarnings(files) {
  const warnings = [];
  for (const file of files) {
    const result = checkPrivateFile(file);
    if (!result.ok) {
      warnings.push(`${file} holds credentials but is mode ${result.mode} and could not be restricted; run: chmod 600 ${file}`);
    }
  }
  return warnings;
}

export function warnUnrestrictedCredentialFiles(files, warnings) {
  for (const message of credentialFilePermissionWarnings(files)) {
    warnings.push({ code: 'CREDENTIAL_FILE_NOT_PRIVATE', message });
  }
}

// ── Codex credential helpers ───────────────────────────────────────────────

const CODEX_PROJECT_HEADER = [
  '# Zylos project-level Codex config.',
  '# Zylos applies overwrite, backfill, key-level, and exact-replacement settings; other settings are preserved.',
].join('\n');

const CODEX_GLOBAL_HEADER = [
  '# Codex global config.',
  '# Zylos manages its project trust entry and optional base URL; other settings are preserved.',
].join('\n');

const CODEX_NOTICE = {
  hide_full_access_warning: true,
  hide_world_writable_warning: true,
  hide_rate_limit_model_nudge: true,
  hide_gpt5_1_migration_prompt: true,
  'hide_gpt-5.1-codex-max_migration_prompt': true,
};

const CODEX_MODEL_MIGRATIONS = {
  'gpt-5.3-codex': 'gpt-5.4',
};

function parseCodexToml(content) {
  if (!content.trim()) return {};
  try {
    return parse(content);
  } catch {
    return {};
  }
}

function tomlWithHeader(header, obj) {
  return `${header}\n\n${stringify(obj)}`;
}

function isTomlSectionValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

// This comment records only keys inserted by Zylos, never user values/secrets.
// Keeping it in the same file makes config + ownership one write. If another
// TOML writer strips it, the values become user-owned and are not auto-removed.
const PERMISSION_MARKER = '# zylos-managed-permission-defaults: ';
const PERMISSION_DEFAULTS = { approval_policy: 'never', sandbox_mode: 'danger-full-access' };

function applyCodexPermissionDefaults(obj, content, bypass) {
  const marker = content.split('\n').find(line => line.startsWith(PERMISSION_MARKER));
  const previous = new Set(marker?.slice(PERMISSION_MARKER.length).split(',') ?? []);
  const owned = [];
  for (const [key, value] of Object.entries(PERMISSION_DEFAULTS)) {
    const stillOwned = previous.has(key) && obj[key] === value;
    // Explicit named or workspace configuration takes over sandbox ownership.
    const sandboxConfigured = obj.default_permissions !== undefined || obj.sandbox_workspace_write !== undefined;
    const enabled = bypass && !(key === 'sandbox_mode' && sandboxConfigured);
    if (!enabled) {
      if (stillOwned) delete obj[key];
    } else if (obj[key] === undefined || stillOwned) {
      obj[key] = value;
      owned.push(key);
    }
  }
  return owned.length ? PERMISSION_MARKER + owned.join(',') : '';
}

export function resolveCodexBypassPermissions(projectDir, opts = {}) {
  if (opts.bypassPermissions != null) return opts.bypassPermissions;
  if (process.env.CODEX_BYPASS_PERMISSIONS !== undefined) {
    return process.env.CODEX_BYPASS_PERMISSIONS !== 'false';
  }
  try {
    const env = parseDotEnv(fs.readFileSync(path.join(projectDir, '.env'), 'utf8'));
    if (env.CODEX_BYPASS_PERMISSIONS !== undefined) return env.CODEX_BYPASS_PERMISSIONS !== 'false';
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return true;
}

function writeCodexProjectConfigAtomically(configPath, content) {
  // Preserve a user-managed symlink instead of replacing the link itself.
  let target = configPath;
  let mode = 0o600;
  let existing;
  try { existing = fs.lstatSync(configPath); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (existing) {
    if (existing.isSymbolicLink()) target = fs.realpathSync(configPath);
    mode = fs.statSync(target).mode & 0o777;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${randomUUID()}`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    created = true;
    fs.fchmodSync(fd, mode); // Preserve existing mode even under a stricter umask.
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
    if (created) try { fs.unlinkSync(temporary); } catch { /* renamed or already absent */ }
  }
}

export function writeCodexProjectConfig(projectDir, opts = {}) {
  const configPath = path.join(path.resolve(projectDir), '.codex', 'config.toml');
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const bypassPermissions = resolveCodexBypassPermissions(projectDir, opts);
  const content = renderCodexProjectConfig(existing, { bypassPermissions });
  if (bypassPermissions) {
    const config = parse(content);
    if (config.approval_policy !== 'never'
      || (config.default_permissions !== undefined
        ? config.default_permissions !== ':danger-full-access'
        : config.sandbox_mode !== 'danger-full-access')) {
      console.warn('Warning: explicit Codex project permissions are preserved; unattended resume may be restricted or require approval.');
    }
  }
  if (content !== existing) {
    writeCodexProjectConfigAtomically(configPath, content);
    opts.onWrite?.(configPath);
  }
}

/**
 * Render project-level .codex/config.toml with headless configuration.
 *
 * Contains settings required for zylos unattended operation: interactive prompt
 * suppression, feature flags, and model migration acknowledgements. These are
 * project requirements, not user preferences.
 *
 * Written to <projectDir>/.codex/config.toml (Codex project-level config).
 *
 * @param {string} existingContent - Existing project config.toml contents (optional)
 * @param {{ bypassPermissions?: boolean }} opts - Whether to backfill unattended permissions
 * @returns {string}
 */
export function renderCodexProjectConfig(existingContent = '', opts = {}) {
  // Do not turn malformed user configuration into unattended full access.
  const obj = existingContent.trim() ? parse(existingContent) : {};
  const permissionHeader = applyCodexPermissionDefaults(obj, existingContent, opts.bypassPermissions ?? true);

  // Always overwrite: these values are required for unattended Zylos runtime behavior.
  obj.check_for_update_on_startup = false;
  obj.model_availability_nux = 'gpt-5.4';

  // Backfill: default only when the user has not configured a value.
  if (obj.model === undefined) obj.model = 'gpt-6.2-sol';
  if (obj.model_reasoning_effort === undefined) obj.model_reasoning_effort = 'medium';

  obj.features = isTomlSectionValue(obj.features) ? obj.features : {};
  obj.features.multi_agent = true;
  obj.features.fast_mode = false;
  obj.features.hooks = true;

  const existingNotice = isTomlSectionValue(obj.notice) ? obj.notice : {};
  const notice = { ...CODEX_NOTICE };
  for (const [key, value] of Object.entries(existingNotice)) {
    if (key !== 'model_migrations' && isTomlSectionValue(value)) {
      notice[key] = value;
    }
  }
  notice.model_migrations = { ...CODEX_MODEL_MIGRATIONS };
  obj.notice = notice;

  return tomlWithHeader([CODEX_PROJECT_HEADER, permissionHeader].filter(Boolean).join('\n'), obj);
}

/**
 * Render global ~/.codex/config.toml with user/environment-level settings.
 *
 * Contains only trust declarations and optional base URL override.
 * Existing [projects.*] trust entries are preserved; the zylos project trust
 * entry is always regenerated.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 * @param {string} existingContent - Existing global config.toml contents (optional)
 * @param {{ openaiBaseUrl?: string }} opts - Optional Codex config overrides
 * @returns {string}
 */
export function renderCodexGlobalConfig(projectDir, existingContent = '', opts = {}) {
  const absProject = path.resolve(projectDir);
  const openaiBaseUrl = opts.openaiBaseUrl || process.env.OPENAI_BASE_URL || '';
  const obj = parseCodexToml(existingContent);
  if (openaiBaseUrl) {
    obj.openai_base_url = openaiBaseUrl;
  }
  obj.features = isTomlSectionValue(obj.features) ? obj.features : {};
  obj.features.hooks = true;
  obj.projects = isTomlSectionValue(obj.projects) ? obj.projects : {};
  obj.projects[absProject] = { trust_level: 'trusted' };
  return tomlWithHeader(CODEX_GLOBAL_HEADER, obj);
}

/**
 * Write Codex configuration to both project-level and global locations.
 *
 * - Project config (<projectDir>/.codex/config.toml): headless settings,
 *   features, notice suppression — required for zylos unattended operation.
 * - Global config (~/.codex/config.toml): trust declarations, optional
 *   base URL override.
 *
 * Called by both `zylos init` (Codex runtime) and `zylos runtime codex` so the
 * config is always present when switching to Codex.
 *
 * @param {string} projectDir - The zylos working directory to pre-trust
 * @returns {boolean} true on success
 */
export function writeCodexConfig(projectDir, opts = {}) {
  try {
    writeCodexProjectConfig(projectDir, opts);

    // Write global config
    const globalCodexDir = path.join(os.homedir(), '.codex');
    const globalConfigPath = path.join(globalCodexDir, 'config.toml');
    let existing = '';
    try {
      existing = fs.readFileSync(globalConfigPath, 'utf8');
    } catch { /* new file — nothing to preserve */ }
    fs.mkdirSync(globalCodexDir, { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      renderCodexGlobalConfig(projectDir, existing, opts),
      'utf8'
    );
    opts.onWrite?.(globalConfigPath);

    installCoreCodexHook({ zylosDir: projectDir, onWrite: opts.onWrite });

    return true;
  } catch {
    return false;
  }
}
