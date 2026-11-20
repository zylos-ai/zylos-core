import { parse as parseToml } from 'smol-toml';
import { InitEndpointConfigurationError, savedInitBaseUrl } from '../shared/init-base-url.js';
import { writeEnvFile } from '../../env.js';
import { upsertEnvValue } from '../shared/credential-env.js';
import { writePrivateFile } from '../../private-file.js';
import { createIdentity } from '../shared/identity.js';
import { verifyCodexApiKey } from '../../init-api-auth.js';
import { cyan, dim, error, success, warn } from '../../colors.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyCodexLoginStatus, parseCodexLoginStatus } from '../../auth-parsers.js';
import { ZYLOS_DIR } from '../../config.js';
import { warnUnrestrictedCredentialFiles, writeCodexConfig } from '../../runtime-setup.js';
import { UNSUPPORTED } from '../contract.js';

const { findExecutable } = createIdentity('codex');

const execFileAsync = promisify(execFile);

function getCodexApiBaseUrl(env) {
  try {
    const configPath = path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'config.toml');
    const config = fs.readFileSync(configPath, 'utf8');
    const match = config.match(/^\s*openai_base_url\s*=\s*"([^"]+)"\s*$/m);
    if (match?.[1]) {
      return match[1].replace(/\/+$/, '');
    }
  } catch { /* ignore missing config */ }

  if (env.OPENAI_BASE_URL) {
    return env.OPENAI_BASE_URL.replace(/\/+$/, '');
  }

  return 'https://api.openai.com/v1';
}

/**
 * Live auth check. Branches on auth_mode in ~/.codex/auth.json:
 *
 *   auth_mode = "apikey"  → live HTTP probe to OpenAI /v1/models with the stored key.
 *                           Detects revoked/expired keys that local file checks cannot catch.
 *   auth_mode = "chatgpt" → skip HTTP probe entirely; use `codex login status` (OAuth/device auth).
 *   auth.json absent      → fall through to `codex login status`.
 *
 * We do NOT read ~/zylos/.env — Codex CLI deliberately ignores OPENAI_API_KEY env vars,
 * so a stale key in .env must never override a later OAuth login in auth.json.
 *
 * Return values:
 *   { status: 'success' }   — authenticated
 *   { status: 'failure' }   — explicit auth failure
 *   { status: 'uncertain' } — probe could not confirm either way
 *
 * @returns {Promise<{status: 'success'|'failure'|'uncertain', reason: string}>}
 */
export async function checkAuth(options = {}) {
  const env = options.env || process.env;
  // Read auth.json to determine the auth mode.
  let authMode = null;
  let apiKey = '';
  try {
    const authJson = JSON.parse(fs.readFileSync(
      path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), 'auth.json'), 'utf8'
    ));
    authMode = authJson?.auth_mode || null;
    // Only extract the API key when the mode is explicitly "apikey".
    if (authMode === 'apikey') {
      apiKey = authJson?.OPENAI_API_KEY || authJson?.apiKey || '';
    }
  } catch { /* auth.json absent or malformed — fall through to codex login status */ }

  if (authMode === 'chatgpt' || (authMode !== 'apikey' && !apiKey)) {
    // OAuth/device auth, or no auth.json — defer to the CLI which reads auth.json natively.
    // Parse explicit status text even on exit 0: CLI versions can report
    // "Not logged in" with either exit 0 or exit 1. A failed command can
    // confirm logged-out status, but can never establish authenticated status.
    // The status line is written to STDERR (stdout is empty), so combine streams.
    try {
      const { stdout, stderr } = await (options.execFile || execFileAsync)(env.CODEX_BIN || 'codex', ['login', 'status'], {
        env, stdio: 'pipe', encoding: 'utf8', timeout: 10_000,
      });
      const status = classifyCodexLoginStatus((stdout || '') + (stderr || ''));
      if (status === 'success') return { status: 'success', reason: 'codex_login_status' };
      if (status === 'failure') return { status: 'failure', reason: 'not_logged_in' };
      return { status: 'uncertain', reason: 'codex_login_status_uncertain' };
    } catch (err) {
      const status = classifyCodexLoginStatus((err.stdout || '') + (err.stderr || ''));
      if (typeof err.code === 'number' && status === 'failure') return { status: 'failure', reason: 'not_logged_in' };
    }
    return { status: 'uncertain', reason: 'codex_login_status_unavailable' };
  }

  // auth_mode = "apikey" — live HTTP probe to OpenAI API.
  // Guard against corrupted auth.json (mode set to "apikey" but key missing).
  if (!apiKey) return { status: 'failure', reason: 'apikey_mode_but_no_key' };
  try {
    const baseUrl = getCodexApiBaseUrl(env);
    const res = await (options.fetch || fetch)(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 200) return { status: 'success', reason: 'http_probe_200' };
    if (res.status === 401) return { status: 'failure', reason: 'http_probe_401' };
    return { status: 'uncertain', reason: `http_probe_uncertain_${res.status}` };
  } catch {
    return { status: 'uncertain', reason: 'http_probe_network_error' };
  }
}

function credentialFiles() {
  return [path.join(os.homedir(), '.codex', 'auth.json')];
}

function saveCredential(kind, value, warnings) {
  if (kind !== 'apiKey' || !saveCodexApiKey(value)) return false;
  warnUnrestrictedCredentialFiles(credentialFiles(), warnings);
  return true;
}

function saveBaseUrl(url) {
  return saveCodexBaseUrlToEnv(url) && writeCodexConfig(ZYLOS_DIR, { openaiBaseUrl: url });
}

/**
 * Check if Codex CLI is authenticated.
 * Checks three paths in order:
 *   1. Process env vars (OPENAI_API_KEY / CODEX_API_KEY) — set in-process by saveCodexApiKey()
 *      during the current init run
 *   2. ~/.codex/auth.json — direct read for auth_mode=apikey (avoids relying on `codex login status`
 *      which may return non-zero for API-key-only auth on some Codex CLI versions)
 *   3. `codex login status` — authoritative CLI check for OAuth/device auth (chatgpt auth_mode)
 * Note: does NOT read ~/zylos/.env — Codex CLI deliberately ignores env vars, so an API key
 * in .env has no meaning for Codex. Keys are stored in ~/.codex/auth.json (see saveCodexApiKey).
 * @returns {boolean}
 */
function localAuthStatus() {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return true;

  // Direct auth.json check — handles auth_mode=apikey without relying on CLI behavior.
  try {
    const authJson = JSON.parse(fs.readFileSync(
      path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'
    ));
    if (authJson?.auth_mode === 'apikey' && (authJson?.OPENAI_API_KEY || authJson?.apiKey)) {
      return true;
    }
  } catch { /* auth.json absent or malformed — fall through */ }

  // Use `codex login status` as the authoritative check for OAuth/device auth.
  // NOTE: `codex login status` exits 0 in BOTH states ("Logged in using ..." and
  // "Not logged in"), so the exit code is meaningless — parse the output text.
  // The status line is written to STDERR (stdout is empty), so combine streams.
  try {
    const result = spawnSync(findExecutable() ?? 'codex', ['login', 'status'], {
      stdio: 'pipe', encoding: 'utf8', timeout: 10000,
    });
    return parseCodexLoginStatus((result.stdout || '') + (result.stderr || ''));
  } catch {
    return false;
  }
}

/**
 * Persist an OpenAI API key to ~/.codex/auth.json (Codex's native credential store).
 * Also sets OPENAI_API_KEY in process.env for the current init process so that
 * the local login check can detect it immediately without re-reading disk.
 *
 * We do NOT write to ~/zylos/.env — Codex CLI deliberately does not read OPENAI_API_KEY
 * from environment variables, so a key in .env has no effect on Codex. The canonical
 * credential store is auth.json.
 *
 * @param {string} apiKey - The OpenAI API key (sk-...)
 * @returns {boolean}
 */
export function saveCodexApiKey(apiKey) {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    const authPath = path.join(codexDir, 'auth.json');
    fs.mkdirSync(codexDir, { recursive: true });
    let authContent = {};
    try { authContent = JSON.parse(fs.readFileSync(authPath, 'utf8')); } catch { }
    authContent.auth_mode = 'apikey';
    authContent.OPENAI_API_KEY = apiKey;
    writePrivateFile(authPath, JSON.stringify(authContent, null, 2) + '\n');
    process.env.OPENAI_API_KEY = apiKey;
    return true;
  } catch {
    return false;
  }
}

/**
 * Write OPENAI_API_KEY to ~/zylos/.env for runtime processes that still read it there.
 * @param {string} apiKey - The OpenAI API key (sk-...)
 * @returns {boolean}
 */
export function saveCodexApiKeyToEnv(apiKey) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'OPENAI_API_KEY', apiKey, 'OpenAI API key for Codex (set by zylos init)');
    writeEnvFile(envPath, content);
    process.env.OPENAI_API_KEY = apiKey;
    return true;
  } catch {
    return false;
  }
}

/**
 * Set OPENAI_BASE_URL in process.env for the current process.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveCodexBaseUrl(baseUrl) {
  try {
    process.env.OPENAI_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

/**
 * Write OPENAI_BASE_URL to ~/zylos/.env.
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function saveCodexBaseUrlToEnv(baseUrl) {
  const envPath = path.join(ZYLOS_DIR, '.env');
  try {
    let content = '';
    try { content = fs.readFileSync(envPath, 'utf8'); } catch {}
    content = upsertEnvValue(content, 'OPENAI_BASE_URL', baseUrl, 'OpenAI base URL for Codex (set by zylos init)');
    writeEnvFile(envPath, content);
    process.env.OPENAI_BASE_URL = baseUrl;
    return true;
  } catch {
    return false;
  }
}

export async function authenticateCodexApiCredential(apiKey, {
  baseUrl, quiet = false, log = console.log, reportError = console.error,
  verify = verifyCodexApiKey, saveKey = saveCodexApiKey,
} = {}) {
  if (!quiet) log(`  ${dim('Verifying Codex API credential...')}`);
  const result = await verify(apiKey, { baseUrl: baseUrl || undefined });
  if (result === false) {
    reportError(`  ${error('Codex API credential was rejected (HTTP 401/403).')}`);
    return false;
  }
  if (!saveKey(apiKey)) {
    reportError(`  ${error('Failed to save Codex API credential to auth.json.')}`);
    return false;
  }
  if (!quiet) log(result === true ? `  ${success('Codex API credential verified and saved')}`
    : `  ${warn('Codex API verification was inconclusive (network or server response). Credential saved; runtime verification is still required.')}`);
  return true;
}

export function resolveInitBaseUrl(opts, { zylosDir = ZYLOS_DIR, home = os.homedir() } = {}) {
  if (opts.codexBaseUrl !== null) return;
  opts.codexBaseUrl = savedInitBaseUrl({
    key: 'OPENAI_BASE_URL', zylosDir, nativeFile: path.join(home, '.codex/config.toml'),
    parseNative: text => parseToml(text).openai_base_url,
  });
}

function initOptionsFromEnv(opts) {
  if (opts.codexApiKey === null && (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)) {
    opts.codexApiKey = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
  }
  if (opts.codexBaseUrl === null && process.env.OPENAI_BASE_URL) {
    opts.codexBaseUrl = process.env.OPENAI_BASE_URL;
  }
}

function initApplyBaseUrl(opts, { selected, apiAttempted, deps = {} }) {
  if (!opts.codexBaseUrl || apiAttempted || (selected && opts.codexApiKey)) return null;
  (deps.saveCodexBase ?? saveCodexBaseUrl)(opts.codexBaseUrl);
  return opts.codexBaseUrl;
}

function initPersist({ baseUrl }, { deps: { saveCodexBase = saveCodexBaseUrlToEnv, saveCodexConfig = writeCodexConfig } = {} }) {
  if (!baseUrl) return true;
  return saveCodexBase(baseUrl) === true && saveCodexConfig(ZYLOS_DIR, { openaiBaseUrl: baseUrl }) === true;
}

async function initAuthenticate(opts, {
  skipConfirm, quiet, choose, secret, validate, nativeLogin, log, reportError, deps = {},
}) {
  const { findExecutable: findCli = findExecutable, codexStatus = localAuthStatus,
    authCodex = authenticateCodexApiCredential, resolveBase = resolveInitBaseUrl,
    saveCodexBase: saveBase = saveCodexBaseUrl, writeCodex = writeCodexConfig } = deps;
  let codexAuthenticated = false;

  let apiAttempted = false;
  let exitCode = 0;
  let pendingBase = null;
  const activateBase = () => {
    if (!opts.codexBaseUrl) return;
    saveBase(opts.codexBaseUrl);
    pendingBase = opts.codexBaseUrl;
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

  const login = args => { activateBase(); return nativeLogin(findCli() ?? 'codex', args); };

  if (findCli() !== null) {
    if (opts.codexApiKey) {
      const validation = prepareApi();
      if (validation) return configurationFailure(validation);
      codexAuthenticated = await authCodex(opts.codexApiKey, { baseUrl: opts.codexBaseUrl, quiet, log, reportError });
      if (codexAuthenticated && opts.codexBaseUrl) activateBase();
      if (!codexAuthenticated && skipConfirm) exitCode = 1;
    } else {
      codexAuthenticated = codexStatus();
      if (codexAuthenticated) {
        if (!quiet) log(`  ${success('Codex authenticated')}`);
      } else {
        if (!quiet) log(`  ${warn('Codex not authenticated')}`);
        if (!skipConfirm) {
          const codexAuthChoice = await choose(
            '\n  How would you like to authenticate Codex?',
            ['OpenAI API key', 'Device auth (headless/server — no browser needed)', 'Browser login'],
          );
          if (codexAuthChoice === 1) {
            const configurationError = prepareApi();
            if (configurationError) return configurationFailure(configurationError);
            log(`\n  ${dim('Paste the API credential expected by this Codex endpoint:')}`);
            const apiKey = await secret('  API key: ');
            if (!apiKey) log(`  ${warn('No key entered. Skipped.')}`);
            else {
              const validation = validate({ ...opts, codexApiKey: apiKey });
              if (validation) return configurationFailure(validation);
              codexAuthenticated = await authCodex(apiKey, { baseUrl: opts.codexBaseUrl, log, reportError });
              if (codexAuthenticated && opts.codexBaseUrl) activateBase();
            }
          } else if (codexAuthChoice === 2) {
            // Option 2: device-auth (headless)
            log(`\n  ${cyan('Starting Codex device auth...')}`);
            log(`  ${dim('Follow the instructions to authenticate. Press Ctrl+C when done.')}\n`);
            try {
              login(['login', '--device-auth']);
            } catch { /* user may Ctrl+C */ }
            codexAuthenticated = codexStatus();
            if (codexAuthenticated) {
              log(`\n  ${success('Codex authenticated')}`);
            } else {
              log(`\n  ${warn('Authentication not completed.')}`);
              log(`    ${dim('Run "codex login --device-auth" to try again.')}`);
            }
          } else {
            // Option 3: browser login
            log(`\n  ${cyan('Starting Codex browser login...')}`);
            log(`  ${dim('After login completes, press Ctrl+C to return.')}\n`);
            try {
              login(['login']);
            } catch { /* user may Ctrl+C */ }
            codexAuthenticated = codexStatus();
            if (codexAuthenticated) {
              log(`\n  ${success('Codex authenticated')}`);
            } else {
              log(`\n  ${warn('Authentication not completed.')}`);
              log(`    ${dim('Run "codex login" to try again.')}`);
            }
          }
        } else {
          if (!quiet) log(`    ${dim('Run "codex login --device-auth" or re-run with "--codex-api-key <key>" to authenticate.')}`);
        }
      }
    }

    // Write ~/.codex/config.toml to suppress interactive prompts on first launch
    if ((!opts.codexApiKey || codexAuthenticated) && writeCodex(ZYLOS_DIR, { openaiBaseUrl: pendingBase || undefined })) {
      if (!quiet) log(`  ${success('Codex startup config written')}`);
    }
  }

  return {
    authenticated: codexAuthenticated, exitCode, apiAttempted, pending: { baseUrl: pendingBase },
    unauthenticatedBox: [
      '⚠  Codex is not authenticated                         ',
      '                                                      ',
      'Zylos is installed, but Codex will not work until     ',
      'you authenticate by running "codex login".            ',
      '                                                      ',
      'To fix:                                               ',
      '  codex login                                         ',
    ],
  };
}

export const auth = Object.freeze({
  checkAuth,
  cliHelp: Object.freeze([
    '--save-apikey <sk-...>          OpenAI API key',
    '--save-base-url <url>           Codex base URL',
    'codex login --device-auth       Device auth (headless)',
    'codex login                     Browser login (then retry)',
  ]),
  initOptionsFromEnv,
  initAuthenticate,
  initApplyBaseUrl,
  initPersist,
  remedy: 'replace credentials or log in again with zylos auth codex',
  credentialFiles,
  credentialKinds: Object.freeze({ apiKey: 'sk-proj-xxx' }),
  saveCredential,
  saveBaseUrl,
  baseUrlExample: 'https://proxy.example.com/v1',
  nativeLogin: Object.freeze({
    args: Object.freeze(['login']),
    deviceArgs: Object.freeze(['login', '--device-auth']),
  }),
  afterLogin: UNSUPPORTED,
  overrideWarnings: UNSUPPORTED,
});
