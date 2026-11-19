import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyCodexLoginStatus } from '../../auth-parsers.js';
import { ZYLOS_DIR } from '../../config.js';
import {
  credentialFiles as runtimeCredentialFiles, warnUnrestrictedCredentialFiles,
  saveCodexApiKey, saveCodexBaseUrlToEnv, writeCodexConfig,
} from '../../runtime-setup.js';
import { UNSUPPORTED } from '../contract.js';

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

const credentialFiles = () => runtimeCredentialFiles('codex');

function saveCredential(kind, value, warnings) {
  if (kind !== 'apiKey' || !saveCodexApiKey(value)) return false;
  warnUnrestrictedCredentialFiles(credentialFiles(), warnings);
  return true;
}

function saveBaseUrl(url) {
  return saveCodexBaseUrlToEnv(url) && writeCodexConfig(ZYLOS_DIR, { openaiBaseUrl: url });
}

export const auth = Object.freeze({
  checkAuth,
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
