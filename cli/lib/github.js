/**
 * GitHub authentication utilities.
 * Detects available credentials and provides authenticated HTTP helpers.
 */

import { execSync, execFileSync } from 'node:child_process';

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

/**
 * Fetch the latest version tag from a GitHub repo.
 * Looks for tags matching v*.*.* pattern and returns the highest semver.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @returns {string|null} Latest version (without 'v' prefix) or null if no matching tags
 * @throws {Error} On network/API failures (callers should catch and handle)
 */
export function fetchLatestTag(repo) {
  try {
    // 1. Try unauthenticated first (avoids token permission issues on public repos)
    const url = `https://api.github.com/repos/${repo}/tags?per_page=100`;
    let response;
    try {
      response = execFileSync('curl', ['-fsSL', url], {
        encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Public request failed — try with auth for private repos
      const token = getGitHubToken();
      if (!token) {
        // No token — re-attempt to get the original error
        response = execFileSync('curl', ['-fsSL', url], {
          encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        response = execFileSync('curl', ['-fsSL', '-H', `Authorization: Bearer ${token}`, url], {
          encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    }
    const tags = JSON.parse(response);
    if (!Array.isArray(tags) || tags.length === 0) return null;

    // Filter v*.*.* tags and sort by semver descending
    const versions = tags
      .map(t => t.name)
      .filter(name => /^v?\d+\.\d+\.\d+/.test(name))
      .map(name => name.replace(/^v/, ''))
      .sort((a, b) => {
        // Split into base version and pre-release: "0.1.0-beta.10" → ["0.1.0", "beta.10"]
        const [aBase, aPre] = a.split(/-(.+)/);
        const [bBase, bPre] = b.split(/-(.+)/);

        // Compare base version (major.minor.patch)
        const aParts = aBase.split('.').map(Number);
        const bParts = bBase.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          const diff = (bParts[i] || 0) - (aParts[i] || 0);
          if (diff !== 0) return diff;
        }

        // Same base: stable (no pre-release) > pre-release
        if (!aPre && bPre) return -1;
        if (aPre && !bPre) return 1;
        if (!aPre && !bPre) return 0;

        // Both pre-release: compare numerically where possible
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
      });

    return versions[0] || null;
  } catch (err) {
    // Distinguish network/API errors from "no tags" — let callers handle appropriately
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
