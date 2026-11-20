import { InitEndpointConfigurationError, savedInitBaseUrl } from '../shared/init-base-url.js';
import { writeEnvFile } from '../../env.js';
import { writePrivateFile } from '../../private-file.js';
import { createIdentity } from '../shared/identity.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseClaudeAuthStatus } from '../../auth-parsers.js';
import { isOfficialClaudeBaseUrl, verifyApiKey } from '../../init-api-auth.js';
import { cyan, dim, error, success, warn } from '../../colors.js';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { CLAUDE_BUILTIN_ENV_KEYS, CLAUDE_CREDENTIAL_KEYS, ZYLOS_DIR } from '../../config.js';
import { env as runtimeEnv } from './launch.js';
import { launchEnvironment, readLaunchDotenv } from '../session-command.js';
import { childRuntimeEnv } from '../../child-runtime-env.js';
import { credentialEnvValue, upsertEnvValue, warnUnrestrictedCredentialFiles } from '../../runtime-setup.js';

const { findExecutable } = createIdentity('claude');

const execFileAsync = promisify(execFile);
const ENV_VARS_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/**
 * Live auth check via `claude -p ping --max-turns 1` (30s timeout).
 * End-to-end validation through the same path Claude Code uses at runtime.
 * Works with all credential types (API keys, setup tokens, OAuth tokens).
 *
 * Return values:
 *   { status: 'success' }   — authenticated
 *   { status: 'failure' }   — explicit auth failure
 *   { status: 'uncertain' } — probe could not confirm either way
 *
 * @returns {Promise<{status: 'success'|'failure'|'uncertain', reason: string}>}
 */
export async function checkAuth(options = {}) {
  // Build subprocess env: inherit current env, but take the built-in Claude
  // variables (CLAUDE_BUILTIN_ENV_KEYS) exactly as a new session gets them.
  const injectedEnv = childRuntimeEnv(claudeProbeEnvironment(options.root || ZYLOS_DIR, options.env || process.env));

  // Strip vars that would make Claude refuse to start ("already running" guard).
  for (const v of ENV_VARS_TO_STRIP) delete injectedEnv[v];

  // Live CLI probe — `claude -p ping --max-turns 1`.
  // End-to-end validation: works with all credential types (API keys, setup tokens,
  // OAuth tokens) without needing to know the correct HTTP header format.
  // Claude Code handles credential routing internally.
  // Use async execFile — spawnSync would block the event loop for up to 30s.
  try {
    const { stdout } = await (options.execFile || execFileAsync)(injectedEnv.CLAUDE_BIN || 'claude', ['-p', 'ping', '--max-turns', '1'], {
      env: injectedEnv,
      timeout: 30_000,
      encoding: 'utf8',
    });
    // Safety net: some Claude versions exit 0 with "Not logged in" on stdout.
    if (stdout.includes('Not logged in')) {
      return { status: 'failure', reason: 'cli_probe_not_logged_in' };
    }
    return { status: 'success', reason: 'cli_probe' };
  } catch (err) {
    const output = (err.stdout ?? '') + (err.stderr ?? '');
    if (typeof err.code === 'number' && output.includes('authentication_error')) {
      return { status: 'failure', reason: 'cli_probe_authentication_error' };
    }
    const isTransient =
      output.includes('rate_limit_error') ||
      output.includes('api_error') ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ENOTFOUND' ||
      err.killed;
    if (isTransient) {
      return { status: 'uncertain', reason: 'cli_probe_uncertain' };
    }
    if (typeof err.code === 'number' && output.includes('Not logged in')) {
      return { status: 'failure', reason: 'cli_probe_not_logged_in' };
    }
    if (typeof err.code === 'number' && [
      'Invalid API key', 'Invalid auth token', 'Authentication required',
    ].some(message => output.includes(message))) {
      return { status: 'failure', reason: 'cli_probe_credentials_rejected' };
    }
    return { status: 'uncertain', reason: 'cli_probe_unexpected_error' };
  }
}

function credentialFiles() {
  return [path.join(os.homedir(), '.claude', 'settings.json'), path.join(os.homedir(), '.claude.json')];
}
const credentialKinds = Object.freeze({ apiKey: 'sk-ant-api-xxx', setupToken: 'sk-ant-oat-xxx' });
const nativeLogin = Object.freeze({ args: Object.freeze(['auth', 'login']), deviceArgs: null });

function saveCredential(kind, value, warnings) {
  if (kind === 'setupToken') {
    if (!saveSetupToken(value)) return false;
    saveSetupTokenToEnv(value);
  } else if (kind === 'apiKey') {
    if (!saveApiKey(value)) return false;
    saveApiKeyToEnv(value);
  } else {
    return false;
  }
  if (!syncClaudeRelayTraffic()) return false;
  warnUnrestrictedCredentialFiles(credentialFiles(), warnings);
  return true;
}

function saveBaseUrl(url, warnings) {
  if (!saveClaudeBaseUrlToEnv(url) || !syncClaudeRelayTraffic()) return false;
  warnUnrestrictedCredentialFiles(credentialFiles(), warnings);
  return true;
}

async function afterLogin() {
  if (!syncClaudeRelayTraffic()) {
    return { ok: false, message: 'Authenticated, but CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC could not be updated', warnings: [] };
  }
  const message = relayLoginNotice();
  return { ok: true, warnings: message ? [{ code: 'RELAY_BASE_URL_KEPT', message }] : [] };
}

function overrideWarnings({ against }) {
  const message = against === 'probe'
    ? claudeSettingsOverrideNotice(claudeProbeEnvironment(ZYLOS_DIR, process.env))
    : claudeSettingsOverrideNotice();
  return message ? [{ code: 'CLAUDE_SETTINGS_OVERRIDE', message }] : [];
}

/**
 * Pre-approve an API key / setup token in ~/.claude.json so Claude Code skips
 * the interactive "Detected a custom API key" confirmation prompt.
 * Also marks onboarding as complete.
 * @param {string} keyOrToken
 */
export function approveApiKey(keyOrToken) {
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch {}
    if (!config.customApiKeyResponses) config.customApiKeyResponses = { approved: [], rejected: [] };
    if (!config.customApiKeyResponses.approved) config.customApiKeyResponses.approved = [];
    const keySuffix = keyOrToken.slice(-20);
    if (!config.customApiKeyResponses.approved.includes(keySuffix)) {
      config.customApiKeyResponses.approved.push(keySuffix);
    }
    if (!config.hasCompletedOnboarding) {
      config.hasCompletedOnboarding = true;
      try {
        const ver = execFileSync(findExecutable() ?? 'claude', ['--version'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        config.lastOnboardingVersion = ver;
      } catch { /* omit if claude binary not yet available */ }
    }
    if (!config.projects) config.projects = {};
    const projectPath = path.resolve(ZYLOS_DIR);
    if (!config.projects[projectPath]) config.projects[projectPath] = {};
    if (!config.projects[projectPath].hasTrustDialogAccepted) {
      config.projects[projectPath].hasTrustDialogAccepted = true;
      config.projects[projectPath].hasCompletedProjectOnboarding = true;
    }
    writePrivateFile(claudeJsonPath, JSON.stringify(config, null, 2) + '\n');
  } catch {}
}

const CLAUDE_CREDENTIAL_COMMENTS = {
  ANTHROPIC_API_KEY: 'Anthropic API key (set by zylos init)',
  ANTHROPIC_AUTH_TOKEN: 'Anthropic auth token (set by zylos init)',
  CLAUDE_CODE_OAUTH_TOKEN: 'Claude Code setup token (set by zylos init)',
};

/**
 * Select a Claude credential for this run: validate it, pre-approve it in
 * ~/.claude.json and make it the only Claude credential in process.env. It is
 * persisted only to ~/zylos/.env (saveClaudeCredentialToEnv); zylos does not
 * read or write Claude credentials in ~/.claude/settings.json.
 */
function saveClaudeCredential(key, value) {
  if (credentialEnvValue(value) === null) return false;
  approveApiKey(value);
  for (const other of CLAUDE_CREDENTIAL_KEYS) delete process.env[other];
  process.env[key] = value;
  return true;
}

/** Select an x-api-key credential for this run and pre-approve it. */
export function saveApiKey(apiKey) {
  return saveClaudeCredential('ANTHROPIC_API_KEY', apiKey);
}

/** Select an Anthropic-compatible Bearer credential for this run without treating it as an API key. */
export function saveAuthToken(token) {
  return saveClaudeCredential('ANTHROPIC_AUTH_TOKEN', token);
}

function saveClaudeCredentialToEnv(key, value) {
  const encoded = credentialEnvValue(value);
  if (encoded === null) return false;
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    // Remove all assignments, including exported, colon, spaced and duplicate entries.
    // Keeping an older duplicate would let a later loader select the wrong auth method.
    const names = CLAUDE_CREDENTIAL_KEYS.join('|');
    content = content.replace(new RegExp(`^[^\\S\\r\\n]*(?:export[^\\S\\r\\n]+)?(?:${names})(?:[^\\S\\r\\n]*=|:[^\\S\\r\\n]+).*(?:\\r?\\n|$)`, 'gm'), '');
    for (const comment of Object.values(CLAUDE_CREDENTIAL_COMMENTS)) {
      content = content.split('\n').filter(line => line.trim() !== '# ' + comment).join('\n');
    }
    content = upsertEnvValue(content, key, encoded, CLAUDE_CREDENTIAL_COMMENTS[key]);
    writeEnvFile(envPath, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write ANTHROPIC_API_KEY to ~/zylos/.env.
 * @param {string} apiKey
 */
export function saveApiKeyToEnv(apiKey) {
  return saveClaudeCredentialToEnv('ANTHROPIC_API_KEY', apiKey);
}

/** Write the selected Bearer credential to the deployed Zylos environment file. */
export function saveAuthTokenToEnv(token) {
  return saveClaudeCredentialToEnv('ANTHROPIC_AUTH_TOKEN', token);
}

/**
 * Select a Claude Code setup token for this run and pre-approve it.
 * Removes competing API key and Bearer credentials from process.env.
 * @param {string} token - The setup token (sk-ant-oat...)
 * @returns {boolean}
 */
export function saveSetupToken(token) {
  return saveClaudeCredential('CLAUDE_CODE_OAUTH_TOKEN', token);
}

/**
 * Write CLAUDE_CODE_OAUTH_TOKEN to ~/zylos/.env.
 * Removes all competing API key and Bearer assignments.
 * @param {string} token
 */
export function saveSetupTokenToEnv(token) {
  return saveClaudeCredentialToEnv('CLAUDE_CODE_OAUTH_TOKEN', token);
}

/**
 * Set ANTHROPIC_BASE_URL in process.env for the current process.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveClaudeBaseUrl(baseUrl) {
  try {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    if (computeRelayTraffic({ baseUrl, credential: claudeCredentialIn(process.env) })) process.env[CLAUDE_RELAY_TRAFFIC_FLAG] = '1';
    else delete process.env[CLAUDE_RELAY_TRAFFIC_FLAG];
    return true;
  } catch {
    return false;
  }
}

/**
 * Write ANTHROPIC_BASE_URL to ~/zylos/.env and process.env.
 * ~/.claude/settings.json is not touched.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveClaudeBaseUrlToEnv(baseUrl) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'ANTHROPIC_BASE_URL', baseUrl, 'Anthropic base URL for Claude Code (set by zylos init)');
    writeEnvFile(envPath, content);
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

// ── Relay traffic setting ───────────────────────────────────────────────────
// Claude Code runs with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 behind a relay
// (non-official ANTHROPIC_BASE_URL) or with an Anthropic API credential
// (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN). It is absent only for a setup
// token or no saved credential (subscription login) on the official API. It is
// computed from the saved credentials alone: credentials saved for Claude always
// win over a subscription login. It is a setting, not a credential: keep it out
// of CLAUDE_CREDENTIAL_KEYS.
export const CLAUDE_RELAY_TRAFFIC_FLAG = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
const CLAUDE_RELAY_TRAFFIC_COMMENT = 'Required with a relay ANTHROPIC_BASE_URL or an Anthropic API key (set by zylos)';
const CREDENTIALS_WITHOUT_RELAY_TRAFFIC = new Set(['setupToken', 'none']);

/**
 * The pairing rule.
 * @param {{ baseUrl?: string, credential?: 'apiKey'|'authToken'|'setupToken'|'none' }} state
 * @returns {boolean} true when the setting must be on
 */
export function computeRelayTraffic({ baseUrl, credential = 'none' } = {}) {
  return isClaudeRelayBaseUrl(baseUrl) || !CREDENTIALS_WITHOUT_RELAY_TRAFFIC.has(credential);
}

/** The Claude credential a set of variables selects, in Claude Code's precedence order. */
export function claudeCredentialIn(values) {
  if (values.ANTHROPIC_AUTH_TOKEN) return 'authToken';
  if (values.ANTHROPIC_API_KEY) return 'apiKey';
  if (values.CLAUDE_CODE_OAUTH_TOKEN) return 'setupToken';
  return 'none';
}

/**
 * Saved Claude base URL and credential, from ~/zylos/.env only, read exactly
 * as a new session reads it. ~/.claude/settings.json is not consulted.
 */
function savedClaudeState() {
  const values = savedClaudeEnv();
  return { baseUrl: values.ANTHROPIC_BASE_URL, credential: claudeCredentialIn(values) };
}

/** ~/zylos/.env read exactly as a new session reads it; empty when unreadable. */
function savedClaudeEnv() {
  try { return readLaunchDotenv(ZYLOS_DIR); } catch { return {}; }
}

/**
 * A warning naming the built-in keys whose ~/.claude/settings.json `env` value
 * would override the Claude values zylos gives Claude Code (set there with a
 * different value, or set there while zylos does not set it). Claude Code
 * applies that file's `env` over the environment zylos passes, so the zylos
 * setting would silently not apply. Called after zylos saves Claude auth or
 * relay settings (compared with ~/zylos/.env, the default), and when a Claude
 * auth check fails (compared with the values that check used).
 * settings.json is only read, never written. Values are never included.
 * Missing, env-less or unparseable settings.json: no warning.
 * @param {Record<string, string|undefined>} [values] - the Claude values to compare with
 * @returns {string|null}
 */
export function claudeSettingsOverrideNotice(values = savedClaudeEnv()) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let env;
  try { env = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))?.env; } catch { return null; }
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const keys = CLAUDE_BUILTIN_ENV_KEYS.filter(key => Object.hasOwn(env, key) && String(env[key] ?? '') !== (values[key] ?? ''));
  if (keys.length === 0) return null;
  return `${settingsPath} sets ${keys.join(', ')} in its env block. Claude Code uses those values instead of the ones zylos gives it, so the zylos setting will not take effect until you remove ${keys.length === 1 ? 'that key' : 'those keys'} from ${settingsPath} by hand.`;
}

/** True when a Claude base URL points anywhere other than the official API. */
export function isClaudeRelayBaseUrl(baseUrl) {
  return !!baseUrl && !isOfficialClaudeBaseUrl(baseUrl);
}

/** Turn the relay setting on or off in ~/zylos/.env and process.env. */
function setClaudeRelayTrafficFlag(on) {
  const name = CLAUDE_RELAY_TRAFFIC_FLAG;
  const assignment = new RegExp(`^[^\\S\\r\\n]*(?:export[^\\S\\r\\n]+)?${name}[^\\S\\r\\n]*=.*(?:\\r?\\n|$)`, 'gm');
  try {
    const envPath = path.join(ZYLOS_DIR, '.env');
    let content = null;
    try { content = fs.readFileSync(envPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const current = content?.match(assignment) ?? [];
    const alreadyOn = current.length === 1 && /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\r?\n?$/.test(current[0]);
    if (on ? !alreadyOn : current.length > 0) {
      let next = (content ?? '').replace(assignment, '')
        .split('\n').filter(line => line.trim() !== `# ${CLAUDE_RELAY_TRAFFIC_COMMENT}`).join('\n');
      next = on ? upsertEnvValue(next, name, '1', CLAUDE_RELAY_TRAFFIC_COMMENT) : next.replace(/\n+$/, '\n');
      writeEnvFile(envPath, next);
    }

    if (on) process.env[name] = '1';
    else delete process.env[name];
    return true;
  } catch {
    return false;
  }
}

/**
 * Recompute the setting from the saved Claude state alone. Call once after
 * every save of a Claude credential or base URL, and after a login.
 * @returns {boolean}
 */
export function syncClaudeRelayTraffic() {
  return setClaudeRelayTrafficFlag(computeRelayTraffic(savedClaudeState()));
}

/** The command that switches Claude back to the official API. */
export const DIRECT_CLAUDE_BASE_URL_COMMAND = 'zylos runtime claude --save-base-url https://api.anthropic.com';

/**
 * After a subscription or setup-token login that gave no new base URL: a
 * notice when a saved relay base URL stays in use (it is never removed).
 * @returns {string|null}
 */
export function relayLoginNotice() {
  const { baseUrl } = savedClaudeState();
  if (!isClaudeRelayBaseUrl(baseUrl)) return null;
  return `Still using the relay ${baseUrl}: the login token will pass through it. To connect directly to Anthropic, run: ${DIRECT_CLAUDE_BASE_URL_COMMAND}`;
}

/**
 * Claude auth probe environment: the inherited env, with the built-in Claude
 * variables taken exactly as a new Claude session gets them.
 */
export function claudeProbeEnvironment(root, processEnv) {
  const env = { ...processEnv };
  let sessionEnv;
  try { sessionEnv = launchEnvironment(root, processEnv, { runtimeEnv }); }
  catch { return env; /* unreadable .env: session launch fails too; probe the inherited env */ }
  for (const key of CLAUDE_BUILTIN_ENV_KEYS) {
    if (Object.hasOwn(sessionEnv, key)) env[key] = sessionEnv[key];
    else delete env[key];
  }
  return env;
}

/**
 * Verify a setup token by running `claude -p "hi" --max-turns 1`.
 * The token must already be saved (via saveSetupToken) so claude picks it up.
 *
 * @returns {{ valid: boolean, authError?: boolean, message?: string }}
 */
function verifySetupToken() {
  try {
    const result = spawnSync(findExecutable() ?? 'claude', ['-p', 'hi', '--max-turns', '1'], {
      timeout: 30000,
      env: childRuntimeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status === 0) {
      return { valid: true };
    }

    const output = ((result.stdout?.toString() || '') + (result.stderr?.toString() || '')).trim();
    const lower = output.toLowerCase();
    const isAuthError = lower.includes('401') || lower.includes('unauthorized') ||
      lower.includes('authentication') || lower.includes('invalid token') ||
      lower.includes('invalid key') || lower.includes('expired') ||
      lower.includes('does not have access') || lower.includes('login again') ||
      lower.includes('permission denied');

    return { valid: false, authError: isAuthError, message: output };
  } catch (err) {
    return { valid: false, authError: false, message: err.message };
  }
}

/**
 * Undo saveSetupToken(): remove CLAUDE_CODE_OAUTH_TOKEN from the current
 * process environment. saveSetupToken() does not write settings.json, so
 * there is nothing to undo there.
 */
function rollbackSetupToken() {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/** Check the credentials a new session would use, without validating their value. */
export function localAuthStatus({ root = ZYLOS_DIR, env = process.env, spawn = spawnSync } = {}) {
  const probeEnv = claudeProbeEnvironment(root, env);
  if (CLAUDE_CREDENTIAL_KEYS.some(key => probeEnv[key])) return true;
  try {
    return parseClaudeAuthStatus(spawn(findExecutable(env) ?? 'claude', ['auth', 'status', '--json'], {
      env: probeEnv, stdio: 'pipe', encoding: 'utf8', timeout: 10000,
    }).stdout);
  } catch { return false; }
}

export async function promptClaudeApiCredential({ baseUrl } = {}, {
  choose, secret, validate, log = console.log,
} = {}) {
  const custom = !isOfficialClaudeBaseUrl(baseUrl);
  const kind = custom ? await choose('  Which credential does this endpoint require?',
    ['API key (x-api-key header)', 'Auth token (Authorization: Bearer header)']) : 1;
  log(`  ${dim(kind === 2 ? 'Paste the Bearer auth token for this endpoint:'
    : custom ? 'Paste the API key for this endpoint:' : 'Paste your Anthropic API key (starts with sk-ant-):')}`);
  const value = await secret(kind === 2 ? '  Auth token: ' : '  API key: ');
  if (!value) { log(`  ${warn('No credential entered. Skipped.')}`); return null; }
  const credential = kind === 2 ? { authToken: value } : { apiKey: value };
  const validation = validate({ ...credential, baseUrl });
  if (validation) { log(`  ${error(validation)}`); return null; }
  return credential;
}

/** Verify only the selected Claude header, then persist to the matching credential store. */
export async function authenticateClaudeApiCredential({ apiKey, authToken, baseUrl }, {
  quiet = false, log = console.log, reportError = console.error,
  verify = verifyApiKey, saveKey = saveApiKey, saveToken = saveAuthToken,
} = {}) {
  if (!quiet) log(`  ${dim('Verifying Claude API credential...')}`);
  const result = await verify(authToken || apiKey, { baseUrl: baseUrl || undefined, authToken: !!authToken });
  if (result === false) {
    reportError(`  ${error('Claude API credential was rejected (HTTP 401/403).')}`);
    return false;
  }
  if (!(authToken ? saveToken(authToken) : saveKey(apiKey))) {
    reportError(`  ${error('Failed to prepare the Claude API credential.')}`);
    return false;
  }
  if (!quiet) log(result === true ? `  ${success('Claude API credential verified. Saving it to ~/zylos/.env is pending.')}`
    : `  ${warn('Claude API verification was inconclusive (network or server response). Saving it to ~/zylos/.env and runtime verification are still required.')}`);
  return true;
}

export function resolveInitBaseUrl(opts, { zylosDir = ZYLOS_DIR, home = os.homedir() } = {}) {
  if (opts.baseUrl !== null) return;
  opts.baseUrl = savedInitBaseUrl({
    key: 'ANTHROPIC_BASE_URL', zylosDir, nativeFile: path.join(home, '.claude/settings.json'),
    parseNative: text => JSON.parse(text)?.env?.ANTHROPIC_BASE_URL,
  });
}

function initOptionsFromEnv(opts, { root, log, authenticated = () => findExecutable() !== null && localAuthStatus({ root }) }) {
  // An explicit Claude credential selects its kind and overrides ambient auth variables.
  // Preserve an existing login when credential variables are merely ambient.
  const hasCliAuth = opts.setupToken != null || opts.apiKey != null || opts.authToken != null;
  if (!hasCliAuth) {
    const saved = readLaunchDotenv(root);
    if (CLAUDE_CREDENTIAL_KEYS.some(key => saved[key])
        && CLAUDE_CREDENTIAL_KEYS.some(key => process.env[key] && process.env[key] !== saved[key])) {
      log('Claude credentials from environment variables were not adopted: .env already has credentials. Use --api-key/--auth-token or edit .env to replace them.');
    }
  }
  if (!hasCliAuth && !authenticated()) {
    // Keep the existing OAuth environment priority; never infer a relay header kind.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      opts.setupToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      if (process.env.ANTHROPIC_API_KEY) opts.apiKey = process.env.ANTHROPIC_API_KEY;
      if (process.env.ANTHROPIC_AUTH_TOKEN) opts.authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    }
    opts.authFromEnv = !!(opts.setupToken || opts.apiKey || opts.authToken);
  }
  if (opts.baseUrl === null && process.env.ANTHROPIC_BASE_URL) {
    opts.baseUrl = process.env.ANTHROPIC_BASE_URL;
  }
}

function initApplyBaseUrl(opts, { apiAttempted, deps = {} }) {
  if (!opts.baseUrl || apiAttempted || opts.apiKey || opts.authToken) return null;
  (deps.saveClaudeBase ?? saveClaudeBaseUrl)(opts.baseUrl);
  return opts.baseUrl;
}

function initPersist({ authToken, apiKey, setupToken, subscriptionLogin, baseUrl }, {
  log, deps: { saveTokenEnv = saveAuthTokenToEnv, saveKeyEnv = saveApiKeyToEnv, saveSetupEnv = saveSetupTokenToEnv,
    saveClaudeBase = saveClaudeBaseUrlToEnv, syncRelayTraffic = syncClaudeRelayTraffic, notice = relayLoginNotice } = {},
}) {
  for (const [value, save] of [[authToken, saveTokenEnv], [apiKey, saveKeyEnv], [setupToken, saveSetupEnv], [baseUrl, saveClaudeBase]]) {
    if (value && save(value) !== true) return false;
  }
  if (syncRelayTraffic() !== true) return false;
  if ((setupToken || subscriptionLogin) && !baseUrl) {
    const relay = notice();
    if (relay) log(`  ${warn(relay)}`);
  }
  const override = claudeSettingsOverrideNotice();
  if (override) log(`  ${warn(override)}`);
  return true;
}

async function initAuthenticate(opts, {
  skipConfirm, quiet, choose, secret, validate, nativeLogin, log, reportError, deps = {},
}) {
  const { findExecutable: findCli = findExecutable, claudeStatus = localAuthStatus,
    authClaude = authenticateClaudeApiCredential, promptClaude = promptClaudeApiCredential,
    resolveBase = resolveInitBaseUrl, saveClaudeBase: saveBase = saveClaudeBaseUrl,
    setupSave = saveSetupToken, setupVerify = verifySetupToken, setupRollback = rollbackSetupToken } = deps;
  let claudeAuthenticated = false;
  let pendingAuthToken = null;
  let pendingApiKey = null;
  let pendingSetupToken = null;
  let subscriptionLogin = false;

  let apiAttempted = false;
  let exitCode = 0;
  let pendingBase = null;
  const activateBase = () => {
    if (!opts.baseUrl) return;
    saveBase(opts.baseUrl);
    pendingBase = opts.baseUrl;
  };
  const prepareApi = () => {
    apiAttempted = true;
    try { resolveBase(opts); }
    catch (err) {
      if (err instanceof InitEndpointConfigurationError) return err.message;
      throw err;
    }
    return validate(opts);
  };
  const configurationFailure = message => {
    reportError(`  ${error(message)}`);
    return { failed: true, exitCode: 1 };
  };

  const login = (...args) => { activateBase(); return nativeLogin(...args); };
  const verifySetup = () => {
    activateBase();
    const result = setupVerify();
    const override = result.valid ? null : claudeSettingsOverrideNotice(process.env);
    if (override) log(`  ${warn(override)}`);
    return result;
  };

  if (findCli() !== null) {
    const explicit = !opts.authFromEnv && !!(opts.apiKey || opts.authToken);
    claudeAuthenticated = !explicit && claudeStatus();
    if (claudeAuthenticated) {
      if (!quiet) log(`  ${success('Claude Code authenticated')}`);
    } else if (opts.setupToken) {
      // Setup token provided via flag/env — save, verify via actual API call, rollback on failure
      if (setupSave(opts.setupToken)) {
        if (!quiet) log(`  ${dim('Verifying setup token...')}`);
        const tokenResult = verifySetup();
        if (tokenResult.valid) {
          pendingSetupToken = opts.setupToken;
          claudeAuthenticated = true;
          if (!quiet) log(`  ${success('Setup token verified and saved')}`);
        } else {
          setupRollback();
          if (tokenResult.authError) {
            reportError(`  ${error('Setup token is invalid or expired.')}`);
            reportError(`    ${dim('Generate a new one: claude setup-token')}`);
          } else {
            reportError(`  ${error('Could not verify setup token. Check network and try again.')}`);
            if (tokenResult.message) reportError(`    ${dim(tokenResult.message.split('\n')[0])}`);
          }
          if (skipConfirm) exitCode = 1;
        }
      }
    } else if (opts.apiKey || opts.authToken) {
      const validation = prepareApi();
      if (validation) return configurationFailure(validation);
      claudeAuthenticated = await authClaude(opts, { quiet, log, reportError });
      if (claudeAuthenticated) {
        if (opts.baseUrl) activateBase();
        if (opts.authToken) pendingAuthToken = opts.authToken;
        else pendingApiKey = opts.apiKey;
      } else if (skipConfirm) exitCode = 1;
    } else {
      if (!quiet) log(`  ${warn('Claude Code not authenticated')}`);
      if (!skipConfirm) {
        const authChoice = await choose(
          '\n  How would you like to authenticate?',
          ['Claude subscription (opens browser login)', isOfficialClaudeBaseUrl(opts.baseUrl) ? 'Anthropic API key' : 'API credential (API key or Bearer token)', 'Setup token (from claude setup-token)'],
        );

        if (authChoice === 1) {
          // Option 1: Subscription login (existing flow)
          log(`\n  ${cyan('Starting Claude Code for authentication...')}`);
          log(`  ${dim('After login, type /exit to return to zylos init.')}\n`);
          const sigintListeners = process.rawListeners('SIGINT');
          process.removeAllListeners('SIGINT');
          process.on('SIGINT', () => {});
          try {
            // On macOS, spawning Claude from a curl|bash pipeline leaves stdin
            // in a state where ink's TUI can't receive keyboard input — even with
            // /dev/tty redirects. Use `script` to allocate a fresh pseudo-terminal
            // that gives Claude full terminal control.
            if (process.platform === 'darwin') {
              login('script', ['-q', '/dev/null', findCli() ?? 'claude']);
            } else {
              login(findCli() ?? 'claude', []);
            }
          } catch { /* user may Ctrl+C */ }
          process.removeAllListeners('SIGINT');
          for (const l of sigintListeners) process.on('SIGINT', l);
          claudeAuthenticated = claudeStatus();
          if (claudeAuthenticated) {
            subscriptionLogin = true;
            log(`\n  ${success('Claude Code authenticated')}`);
          } else {
            log(`\n  ${warn('Authentication not completed.')}`);
            log(`    ${dim('Run "claude" to authenticate then "zylos init" again.')}`);
          }
        } else if (authChoice === 2) {
          const validation = prepareApi();
          if (validation) return configurationFailure(validation);
          const credential = await promptClaude({ baseUrl: opts.baseUrl }, { choose, secret, log, validate });
          if (credential) {
            claudeAuthenticated = await authClaude({ ...credential, baseUrl: opts.baseUrl }, { log, reportError });
            if (claudeAuthenticated) {
              if (opts.baseUrl) activateBase();
              if (credential.authToken) pendingAuthToken = credential.authToken;
              else pendingApiKey = credential.apiKey;
            }
          }
        } else if (authChoice === 3) {
          // Option 3: Setup token (OAuth token from claude setup-token)
          log(`\n  ${dim('Paste your setup token (starts with sk-ant-oat):')}`);
          log(`  ${dim('Generate one by running "claude setup-token" on a machine with a browser.')}`);
          const token = await secret('  Setup token: ');
          const tokenValidation = token ? validate({ setupToken: token }) : null;
          if (!token) {
            log(`  ${warn('No token entered. Skipped.')}`);
          } else if (tokenValidation) {
            log(`  ${error(tokenValidation)}`);
            log(`    ${dim('Run "claude setup-token" to generate a valid token.')}`);
          } else if (setupSave(token)) {
            log(`  ${dim('Verifying setup token...')}`);
            const tokenResult = verifySetup();
            if (tokenResult.valid) {
              pendingSetupToken = token;
              claudeAuthenticated = true;
              log(`  ${success('Setup token verified and saved')}`);
            } else {
              setupRollback();
              if (tokenResult.authError) {
                log(`  ${error('Setup token is invalid or expired.')}`);
                log(`    ${dim('Generate a new one: claude setup-token')}`);
              } else {
                log(`  ${error('Could not verify setup token. Check network and try again.')}`);
                if (tokenResult.message) log(`    ${dim(tokenResult.message.split('\n')[0])}`);
              }
            }
          }
        }
      } else {
        if (!quiet) log(`    ${dim('Run "zylos init" again to authenticate.')}`);
      }
    }
  }

  const fixCmd = (opts.setupToken || opts.apiKey || opts.authToken)
    ? (opts.setupToken ? 'zylos init --setup-token <valid-token>' : opts.authToken ? 'zylos init --auth-token <valid-token>' : 'zylos init --api-key <valid-key>')
    : 'zylos init';
  return {
    authenticated: claudeAuthenticated, exitCode, apiAttempted,
    pending: { authToken: pendingAuthToken, apiKey: pendingApiKey, setupToken: pendingSetupToken, subscriptionLogin, baseUrl: pendingBase },
    unauthenticatedBox: [
      '⚠  Claude is not authenticated                       ',
      '                                                      ',
      'Zylos is installed, but Claude will not work until    ',
      'a valid credential is provided.                       ',
      '                                                      ',
      'To fix:                                               ',
      `  ${fixCmd}${' '.repeat(Math.max(0, 52 - fixCmd.length))}`,
    ],
  };
}

export const auth = Object.freeze({
  checkAuth,
  cliHelp: Object.freeze([
    '--save-apikey <sk-ant-api...>   Anthropic API key',
    '--save-base-url <url>           Claude base URL',
    '--save-setup-token <sk-ant-oat...>  Setup token',
    'claude auth login               Browser OAuth (then retry)',
  ]),
  initOptionsFromEnv,
  initAuthenticate,
  initApplyBaseUrl,
  initPersist,
  remedy: 'replace credentials or log in again with zylos auth claude',
  credentialFiles,
  credentialKinds,
  saveCredential,
  saveBaseUrl,
  baseUrlExample: 'https://claude-proxy.example.com',
  nativeLogin,
  afterLogin,
  overrideWarnings,
});
