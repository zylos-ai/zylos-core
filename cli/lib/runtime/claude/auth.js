import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ZYLOS_DIR } from '../../config.js';
import { claudeProbeEnvironment } from '../session-command.js';
import { childRuntimeEnv } from '../../child-runtime-env.js';
import {
  credentialFiles as runtimeCredentialFiles, warnUnrestrictedCredentialFiles,
  saveApiKey, saveApiKeyToEnv, saveSetupToken, saveSetupTokenToEnv, saveClaudeBaseUrlToEnv,
  syncClaudeRelayTraffic, relayLoginNotice, claudeSettingsOverrideNotice,
} from '../../runtime-setup.js';

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

const credentialFiles = () => runtimeCredentialFiles('claude');
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

export const auth = Object.freeze({
  checkAuth,
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
