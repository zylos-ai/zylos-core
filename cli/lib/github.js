/**
 * GitHub authentication utilities.
 * Detects available credentials and provides authenticated HTTP helpers.
 */

import { execSync, execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);
let _cachedToken = undefined;

/**
 * Detect a GitHub token from the environment or gh CLI.
 * Result is cached for the process lifetime.
 *
 * @returns {string|null} GitHub token or null if none available
 */
export function getGitHubToken() {
  if (_cachedToken !== undefined) return _cachedToken;

  // 1. Explicit env vars (GITHUB_TOKEN is standard, GH_TOKEN is used by gh CLI)
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    _cachedToken = envToken;
    return _cachedToken;
  }

  // 2. gh CLI auth token
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token) {
      _cachedToken = token;
      return _cachedToken;
    }
  } catch {
    // gh not installed or not authenticated
  }

  _cachedToken = null;
  return null;
}

// ── Rate-limit aware retry ───────────────────────────────────────

// curl -f reports HTTP errors as "The requested URL returned error: NNN".
// GitHub signals its primary rate limit with 403 and the secondary
// (abuse) limit with 429.
const RATE_LIMIT_STATUS_RE = /returned error:?\s+(403|429)\b/;
const DEFAULT_RETRY_DELAYS_MS = [15000, 45000];

/**
 * Check whether a curl child-process error looks like GitHub rate limiting.
 * Heuristic: with -f the response body is discarded, so the HTTP status in
 * curl's stderr is the only signal. A 403 can also be a permission denial,
 * in which case the retries add a bounded delay before the same failure.
 *
 * @param {Error} err - Error thrown by execFileSync/execFile for a curl call
 * @returns {boolean}
 */
export function isRateLimitError(err) {
  const text = [err?.stderr?.toString?.(), err?.message]
    .filter(Boolean)
    .join('\n');
  return RATE_LIMIT_STATUS_RE.test(text);
}

/**
 * Retry delays between attempts, in ms. Overridable via
 * ZYLOS_GH_RETRY_DELAY_MS (comma-separated, e.g. "1000,5000";
 * empty string disables retries) — used by tests and tunable in ops.
 */
function retryDelaysMs() {
  const env = process.env.ZYLOS_GH_RETRY_DELAY_MS;
  if (env === undefined) return DEFAULT_RETRY_DELAYS_MS;
  return env
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
    .map(Number)
    .filter(n => Number.isFinite(n) && n >= 0);
}

function notifyRetry(label, attempt, total, delayMs) {
  // stderr on purpose: `zylos upgrade --json` reserves stdout for JSON
  console.error(
    `GitHub rate limited (${label}) — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${total})...`
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run an operation, retrying when it fails with a GitHub rate-limit
 * signature. The operation should contain its full endpoint fallback chain,
 * so retries only start after all usable endpoints have failed.
 * Non-rate-limit failures are rethrown immediately.
 *
 * @param {Function} fn - Operation to run
 * @param {string} label - Human-readable label for the retry notice
 * @returns {*} The operation's return value
 */
export function withRateLimitRetrySync(fn, label) {
  const delays = retryDelaysMs();
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= delays.length || !isRateLimitError(err)) throw err;
      notifyRetry(label, attempt + 1, delays.length, delays[attempt]);
      sleepSync(delays[attempt]);
    }
  }
}

/**
 * Async flavor of withRateLimitRetrySync.
 *
 * @param {Function} fn - Async operation to run
 * @param {string} label - Human-readable label for the retry notice
 * @returns {Promise<*>} The operation's resolved value
 */
export async function withRateLimitRetryAsync(fn, label) {
  const delays = retryDelaysMs();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length || !isRateLimitError(err)) throw err;
      notifyRetry(label, attempt + 1, delays.length, delays[attempt]);
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

/**
 * Fetch raw file content from a GitHub repo.
 * Uses the authenticated GitHub API first when a token is available, then
 * falls back to the public raw endpoint. Without a token, uses only the
 * public endpoint. Retries with backoff on GitHub rate limiting.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} filePath - Path to file in the repo (e.g. "SKILL.md")
 * @param {string} [branch='main'] - Branch name
 * @returns {string} File content
 * @throws {Error} If fetch fails
 */
export function fetchRawFile(repo, filePath, branch = 'main') {
  return withRateLimitRetrySync(
    () => fetchRawFileOnce(repo, filePath, branch),
    `${repo}/${filePath}`
  );
}

function fetchRawFileOnce(repo, filePath, branch) {
  const publicUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
  const token = getGitHubToken();
  let authenticatedError;
  if (token) {
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`;
    try {
      return execFileSync('curl', [
        '-fsSL', '-H', `Authorization: Bearer ${token}`,
        '-H', 'Accept: application/vnd.github.raw+json', apiUrl,
      ], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      // A token without access must not block public repositories.
      authenticatedError = err;
    }
  }

  try {
    return execFileSync('curl', ['-fsSL', publicUrl], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (publicError) {
    // Preserve the authenticated failure for private repos and rate-limit retry.
    throw authenticatedError || publicError;
  }
}

// ── Shared tag parsing ───────────────────────────────────────────

export function compareSemverDesc(a, b) {
  const [aBase, aPre] = a.split(/-(.+)/);
  const [bBase, bPre] = b.split(/-(.+)/);

  const aParts = aBase.split('.').map(Number);
  const bParts = bBase.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (bParts[i] || 0) - (aParts[i] || 0);
    if (diff !== 0) return diff;
  }

  if (!aPre && bPre) return -1;
  if (aPre && !bPre) return 1;
  if (!aPre && !bPre) return 0;

  const aPreParts = aPre.split('.').map(p => parseInt(p) || p);
  const bPreParts = bPre.split('.').map(p => parseInt(p) || p);
  for (let i = 0; i < Math.max(aPreParts.length, bPreParts.length); i++) {
    const av = aPreParts[i] ?? 0;
    const bv = bPreParts[i] ?? 0;
    if (typeof av === 'number' && typeof bv === 'number') {
      if (bv !== av) return bv - av;
    } else {
      const cmp = String(bv).localeCompare(String(av));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function parseTagsResponse(jsonStr, { includePrerelease = false } = {}) {
  const tags = JSON.parse(jsonStr);
  if (!Array.isArray(tags) || tags.length === 0) return null;

  let versions = tags
    .map(t => t.name)
    .filter(name => /^v?\d+\.\d+\.\d+/.test(name))
    .map(name => name.replace(/^v/, ''));

  if (!includePrerelease) {
    versions = versions.filter(v => !v.includes('-'));
  }

  versions.sort(compareSemverDesc);
  return versions[0] || null;
}

function fetchTagsJsonSync(repo) {
  const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
  const token = getGitHubToken();
  let authenticatedError;
  if (token) {
    try {
      return execFileSync('curl', ['-fsSL', '-H', `Authorization: Bearer ${token}`, url], {
        encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Preserve public-repository access when the token has insufficient scope.
      authenticatedError = err;
    }
  }
  try {
    return execFileSync('curl', ['-fsSL', url], {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (publicError) {
    // Preserve the authenticated failure for private repos and rate-limit retry.
    throw authenticatedError || publicError;
  }
}

async function fetchTagsJsonAsync(repo) {
  const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
  const token = getGitHubToken();
  let authenticatedError;
  if (token) {
    try {
      const { stdout } = await execFileAsync('curl', [
        '-fsSL', '-H', `Authorization: Bearer ${token}`, url,
      ], {
        encoding: 'utf8', timeout: 10000,
      });
      return stdout;
    } catch (err) {
      // Preserve public-repository access when the token has insufficient scope.
      authenticatedError = err;
    }
  }
  try {
    const { stdout } = await execFileAsync('curl', ['-fsSL', url], {
      encoding: 'utf8', timeout: 10000,
    });
    return stdout;
  } catch (publicError) {
    // Preserve the authenticated failure for private repos and rate-limit retry.
    throw authenticatedError || publicError;
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Fetch the latest version tag from a GitHub repo (synchronous).
 * Looks for tags matching v*.*.* pattern and returns the highest semver.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {object} [opts]
 * @param {boolean} [opts.includePrerelease=false] - Include prerelease (beta) tags
 * @returns {string|null} Latest version (without 'v' prefix) or null if no matching tags
 * @throws {Error} On network/API failures (callers should catch and handle)
 */
export function fetchLatestTag(repo, { includePrerelease = false } = {}) {
  try {
    const json = withRateLimitRetrySync(() => fetchTagsJsonSync(repo), `${repo} tags`);
    return parseTagsResponse(json, { includePrerelease });
  } catch (err) {
    const msg = err.stderr?.toString().trim() || err.message || 'unknown error';
    throw new Error(`Failed to fetch tags for ${repo}: ${sanitizeError(msg)}`);
  }
}

/**
 * Fetch the latest version tag from a GitHub repo (async, non-blocking).
 * Same behavior as fetchLatestTag but uses async child processes,
 * suitable for concurrent version checks.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {object} [opts]
 * @param {boolean} [opts.includePrerelease=false] - Include prerelease (beta) tags
 * @returns {Promise<string|null>} Latest version (without 'v' prefix) or null
 * @throws {Error} On network/API failures
 */
export async function fetchLatestTagAsync(repo, { includePrerelease = false } = {}) {
  try {
    const json = await withRateLimitRetryAsync(() => fetchTagsJsonAsync(repo), `${repo} tags`);
    return parseTagsResponse(json, { includePrerelease });
  } catch (err) {
    const msg = err.stderr?.toString().trim() || err.message || 'unknown error';
    throw new Error(`Failed to fetch tags for ${repo}: ${sanitizeError(msg)}`);
  }
}

/**
 * Sanitize error messages to remove any leaked tokens.
 */
export function sanitizeError(message) {
  const token = getGitHubToken();
  if (token && message.includes(token)) {
    return message.replaceAll(token, '***');
  }
  return message;
}
