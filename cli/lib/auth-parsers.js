/**
 * auth-parsers.js — pure parsers for runtime CLI auth-status output.
 *
 * Zero imports / no side effects by design: this leaf module is shared by both
 * `runtime-setup.js` (the `zylos init` flow) and the runtime adapters
 * (`runtime/codex.js`, runtime-switch + health probe) without dragging
 * `node:child_process` into adapter test graphs that mock it.
 *
 * Both parsers key off explicit signals rather than process exit codes, which
 * conflate "not authenticated" with crashes, timeouts, and version drift.
 */

/**
 * Parse `claude auth status --json` output into an authenticated boolean.
 * Keys off the explicit `loggedIn` field; any unparseable / unexpected payload
 * is treated as not authenticated.
 * @param {string} stdout
 * @returns {boolean}
 */
export function parseClaudeAuthStatus(stdout) {
  try {
    return JSON.parse(stdout)?.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Classify `codex login status` output into a tristate auth status.
 * The exit code is unusable: `codex login status` exits 0 for BOTH
 * "Logged in using ..." and "Not logged in". So we key off explicit text:
 * "Not logged in" is a confirmed failure, a line beginning with "Logged in"
 * is success, and anything else is inconclusive.
 * NOTE: codex writes the status line to STDERR (stdout is empty) and may emit
 * an unrelated leading warning line, so callers should pass combined
 * stdout+stderr; the per-line match (`m` flag) ignores the warning.
 * @param {string} stdout combined stdout+stderr from `codex login status`
 * @returns {'success'|'failure'|'uncertain'}
 */
export function classifyCodexLoginStatus(stdout) {
  const out = String(stdout ?? '');
  if (/not logged in/i.test(out)) return 'failure';
  if (/^\s*Logged in\b/im.test(out)) return 'success';
  return 'uncertain';
}

/**
 * Parse `codex login status` output into an authenticated boolean.
 * Kept for init flows that only need a boolean answer.
 * @param {string} stdout combined stdout+stderr from `codex login status`
 * @returns {boolean}
 */
export function parseCodexLoginStatus(stdout) {
  return classifyCodexLoginStatus(stdout) === 'success';
}
