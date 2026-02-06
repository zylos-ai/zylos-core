/**
 * GitHub authentication utilities.
 * Detects available credentials and provides authenticated HTTP helpers.
 */

import { execSync } from 'node:child_process';

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
 * Uses GitHub API with auth for private repos, falls back to raw.githubusercontent.com.
 *
 * @param {string} repo - GitHub repo in "org/name" format
 * @param {string} filePath - Path to file in the repo (e.g. "SKILL.md")
 * @param {string} [branch='main'] - Branch name
 * @returns {string} File content
 * @throws {Error} If fetch fails
 */
export function fetchRawFile(repo, filePath, branch = 'main') {
  const token = getGitHubToken();

  if (token) {
    // GitHub API — works for public and private repos
    const url = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`;
    const content = execSync(
      `curl -fsSL -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github.raw+json" "${url}"`,
      { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return content;
  }

  // Public endpoint — only works for public repos
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
  return execSync(`curl -fsSL "${url}"`, {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
