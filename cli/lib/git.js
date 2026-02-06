/**
 * Git operation helpers for component upgrades
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Execute a git command and return result
 * @param {string} cmd - Git command (without 'git' prefix)
 * @param {string} cwd - Working directory
 * @returns {{ success: boolean, output?: string, error?: string }}
 */
export function execGit(cmd, cwd) {
  try {
    const output = execSync(`git ${cmd}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    return {
      success: false,
      error: err.stderr?.trim() || err.message,
      output: err.stdout?.trim(),
    };
  }
}

/**
 * Get current commit hash
 */
export function getCurrentCommit(dir) {
  return execGit('rev-parse HEAD', dir);
}

/**
 * Check if there are local changes (staged or unstaged)
 */
export function hasLocalChanges(dir) {
  const result = execGit('status --porcelain', dir);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    hasChanges: result.output.length > 0,
    changes: result.output ? result.output.split('\n') : [],
  };
}

/**
 * Get list of changed files
 */
export function getChangedFiles(dir) {
  const result = execGit('status --porcelain', dir);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  const files = result.output
    ? result.output.split('\n').map(line => ({
        status: line.substring(0, 2).trim(),
        file: line.substring(3),
      }))
    : [];
  return { success: true, files };
}

/**
 * Stash local changes
 */
export function stashChanges(dir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const message = `zylos-upgrade-${timestamp}`;
  const result = execGit(`stash push -m "${message}"`, dir);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return { success: true, stashName: message };
}

/**
 * Pop the most recent stash
 */
export function popStash(dir) {
  return execGit('stash pop', dir);
}

/**
 * Fetch from remote
 */
export function fetch(dir) {
  return execGit('fetch origin', dir);
}

/**
 * Pull from remote (current branch)
 */
export function pull(dir) {
  return execGit('pull', dir);
}

/**
 * Reset to a specific commit
 */
export function resetHard(dir, commit) {
  return execGit(`reset --hard ${commit}`, dir);
}

/**
 * Get the current branch name
 */
export function getCurrentBranch(dir) {
  return execGit('rev-parse --abbrev-ref HEAD', dir);
}

/**
 * Get remote HEAD commit for a branch
 */
export function getRemoteHead(dir, branch = 'main') {
  const result = execGit(`rev-parse origin/${branch}`, dir);
  return result;
}

/**
 * Check if there are remote changes available
 */
export function hasRemoteChanges(dir, branch = 'main') {
  const fetchResult = fetch(dir);
  if (!fetchResult.success) {
    return { success: false, error: fetchResult.error };
  }

  const localResult = getCurrentCommit(dir);
  if (!localResult.success) {
    return { success: false, error: localResult.error };
  }

  const remoteResult = getRemoteHead(dir, branch);
  if (!remoteResult.success) {
    return { success: false, error: remoteResult.error };
  }

  return {
    success: true,
    hasChanges: localResult.output !== remoteResult.output,
    localCommit: localResult.output,
    remoteCommit: remoteResult.output,
  };
}

/**
 * Get file content from remote without checking out
 */
export function getRemoteFile(dir, branch, filePath) {
  const result = execGit(`show origin/${branch}:${filePath}`, dir);
  return result;
}

/**
 * Get commit log between two commits
 */
export function getCommitLog(dir, fromCommit, toCommit) {
  const result = execGit(`log --oneline ${fromCommit}..${toCommit}`, dir);
  return result;
}

/**
 * Parse SKILL.md frontmatter to extract version
 */
export function parseSkillVersion(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const versionMatch = frontmatter.match(/^version:\s*(.+)$/m);
  return versionMatch ? versionMatch[1].trim() : null;
}

/**
 * Get version from local SKILL.md
 */
export function getLocalVersion(dir) {
  const skillPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return { success: false, error: 'SKILL.md not found' };
  }

  try {
    const content = fs.readFileSync(skillPath, 'utf8');
    const version = parseSkillVersion(content);
    if (!version) {
      return { success: false, error: 'Version not found in SKILL.md' };
    }
    return { success: true, version };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get version from remote SKILL.md
 */
export function getRemoteVersion(dir, branch = 'main') {
  const result = getRemoteFile(dir, branch, 'SKILL.md');
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const version = parseSkillVersion(result.output);
  if (!version) {
    return { success: false, error: 'Version not found in remote SKILL.md' };
  }
  return { success: true, version };
}

/**
 * Get CHANGELOG content from remote
 */
export function getRemoteChangelog(dir, branch = 'main') {
  const result = getRemoteFile(dir, branch, 'CHANGELOG.md');
  if (!result.success) {
    // CHANGELOG might not exist, that's OK
    return { success: true, changelog: null };
  }
  return { success: true, changelog: result.output };
}

/**
 * Get upgrade branch from SKILL.md frontmatter
 */
export function getUpgradeBranch(dir) {
  const skillPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    return 'main'; // Default branch
  }

  try {
    const content = fs.readFileSync(skillPath, 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return 'main';

    const frontmatter = match[1];
    const branchMatch = frontmatter.match(/upgrade:\s*\n\s*(?:.*\n)*?\s*branch:\s*(.+)/m);
    return branchMatch ? branchMatch[1].trim() : 'main';
  } catch {
    return 'main';
  }
}
