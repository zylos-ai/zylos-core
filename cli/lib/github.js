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

/**
 * Fetch raw file content from a GitHub repo.
 * Tries public endpoint first, falls back to authenticated GitHub API
 * for private repos.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} filePath - Path to file in the repo (e.g. "SKILL.md")
 * @param {string} [branch='main'] - Branch name
 * @returns {string} File content
 * @throws {Error} If fetch fails
 */
export function fetchRawFile(repo, filePath, branch = 'main') {
  // 1. Try public endpoint first
  const publicUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
  try {
    return execFileSync('curl', ['-fsSL', publicUrl], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Public fetch failed — repo may be private
  }

  // 2. Fall back to authenticated GitHub API
  const token = getGitHubToken();
  if (!token) {
    // No token — re-attempt public to get the original error
    return execFileSync('curl', ['-fsSL', publicUrl], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`;
  return execFileSync('curl', [
    '-fsSL', '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github.raw+json', apiUrl,
  ], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
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

function parseTagsResponse(jsonStr) {
  const tags = JSON.parse(jsonStr);
  if (!Array.isArray(tags) || tags.length === 0) return null;

  const versions = tags
    .map(t => t.name)
    .filter(name => /^v?\d+\.\d+\.\d+/.test(name))
    .map(name => name.replace(/^v/, ''))
    .sort(compareSemverDesc);

  return versions[0] || null;
}

function fetchTagsJsonSync(repo) {
  const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
  try {
    return execFileSync('curl', ['-fsSL', url], {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    const token = getGitHubToken();
    if (!token) {
      return execFileSync('curl', ['-fsSL', url], {
        encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    return execFileSync('curl', ['-fsSL', '-H', `Authorization: Bearer ${token}`, url], {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

async function fetchTagsJsonAsync(repo) {
  const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
  try {
    const { stdout } = await execFileAsync('curl', ['-fsSL', url], {
      encoding: 'utf8', timeout: 10000,
    });
    return stdout;
  } catch {
    const token = getGitHubToken();
    if (!token) {
      const { stdout } = await execFileAsync('curl', ['-fsSL', url], {
        encoding: 'utf8', timeout: 10000,
      });
      return stdout;
    }
    const { stdout } = await execFileAsync('curl', ['-fsSL', '-H', `Authorization: Bearer ${token}`, url], {
      encoding: 'utf8', timeout: 10000,
    });
    return stdout;
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Fetch the latest version tag from a GitHub repo (synchronous).
 * Looks for tags matching v*.*.* pattern and returns the highest semver.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @returns {string|null} Latest version (without 'v' prefix) or null if no matching tags
 * @throws {Error} On network/API failures (callers should catch and handle)
 */
export function fetchLatestTag(repo) {
  try {
    return parseTagsResponse(fetchTagsJsonSync(repo));
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
 * @returns {Promise<string|null>} Latest version (without 'v' prefix) or null
 * @throws {Error} On network/API failures
 */
export async function fetchLatestTagAsync(repo) {
  try {
    return parseTagsResponse(await fetchTagsJsonAsync(repo));
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
