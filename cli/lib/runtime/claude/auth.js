import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ZYLOS_DIR } from '../../config.js';
import { claudeProbeEnvironment } from '../session-command.js';
import { childRuntimeEnv } from '../../child-runtime-env.js';

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
