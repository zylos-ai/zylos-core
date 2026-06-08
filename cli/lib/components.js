/**
 * Component management utilities
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPONENTS_FILE } from './config.js';
import { loadRegistry } from './registry.js';
import { fetchLatestTag } from './github.js';

/**
 * Load installed components from components.json
 */
export function loadComponents() {
  if (fs.existsSync(COMPONENTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(COMPONENTS_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Save installed components to components.json
 */
export function saveComponents(components) {
  fs.writeFileSync(COMPONENTS_FILE, JSON.stringify(components, null, 2));
}

/**
 * Resolve component target from name or URL
 * Supports: name, name@version, org/repo, org/repo@version, github-url
 * @returns {object} { name, repo, version, fetchError, isThirdParty }
 */
export async function resolveTarget(nameOrUrl) {
  // Extract version if present (name@version or org/repo@version)
  let version = null;
  let target = nameOrUrl;
  if (nameOrUrl.includes('@') && !nameOrUrl.startsWith('http')) {
    const atIndex = nameOrUrl.lastIndexOf('@');
    target = nameOrUrl.substring(0, atIndex);
    version = nameOrUrl.substring(atIndex + 1);
  }

  // Local source: an existing directory or .tar.gz/.tgz archive on disk.
  // Checked before the org/repo branch so a path like "./foo" or
  // "/tmp/x.tar.gz" isn't misread as "org/repo". Bare registry names (no
  // slash and not an archive) are never treated as local.
  if ((target.includes('/') || /\.(tar\.gz|tgz)$/i.test(target)) && fs.existsSync(path.resolve(target))) {
    const base = path.basename(target).replace(/\.(tar\.gz|tgz)$/i, '');
    const name = base.replace(/^zylos-/, '');
    return { name, repo: null, version: null, fetchError: null, isThirdParty: true, isLocal: true, localPath: path.resolve(target) };
  }

  // Helper: try fetchLatestTag, capture network errors separately.
  // GitLab repos (repo "gitlab:<group>/<project>") skip the lookup — fetchLatestTag
  // hits the GitHub API and would 404; caller must use --branch.
  function tryFetchLatestTag(repo) {
    if (typeof repo === 'string' && repo.startsWith('gitlab:')) {
      return { version: null, fetchError: 'GitLab repo: use --branch <name> to install' };
    }
    try {
      return { version: fetchLatestTag(repo) || null, fetchError: null };
    } catch (err) {
      return { version: null, fetchError: err.message };
    }
  }

  // Check if it's a GitHub URL
  const githubMatch = target.match(/github\.com\/([^/]+\/[^/]+)/);
  if (githubMatch) {
    const repo = githubMatch[1].replace(/\.git$/, '');
    const name = repo.split('/')[1].replace(/^zylos-/, '');
    const tag = version ? { version, fetchError: null } : tryFetchLatestTag(repo);
    return { name, repo, version: tag.version, fetchError: tag.fetchError, isThirdParty: !repo.startsWith('zylos-ai/') };
  }

  // Any other http(s) URL → treat as a GitLab repo:
  //   https://<host>/<group>/<project>[.git]  →  repo "gitlab:<group>/<project>"
  // GitLab has no GitHub-style tag API wired here, so default to branch main
  // (no --branch needed). The URL's host overrides ZYLOS_GITLAB_HOST so any
  // GitLab instance works, not just the default.
  const urlMatch = target.match(/^https?:\/\/([^/]+)\/(.+?)\/?$/);
  if (urlMatch) {
    const host = urlMatch[1];
    const repoPath = urlMatch[2].replace(/\.git$/, '');
    const name = repoPath.split('/').pop().replace(/^zylos-/, '');
    if (host && host !== 'git.coco.xyz') process.env.ZYLOS_GITLAB_HOST = host;
    return { name, repo: `gitlab:${repoPath}`, version, fetchError: null, isThirdParty: true, defaultBranch: 'main' };
  }

  // Check if it's in format org/repo
  if (target.includes('/')) {
    const name = target.split('/')[1].replace(/^zylos-/, '');
    const tag = version ? { version, fetchError: null } : tryFetchLatestTag(target);
    return { name, repo: target, version: tag.version, fetchError: tag.fetchError, isThirdParty: !target.startsWith('zylos-ai/') };
  }

  // Look up in registry
  const registry = await loadRegistry();
  if (registry[target]) {
    const tag = version ? { version, fetchError: null } : tryFetchLatestTag(registry[target].repo);
    return {
      name: target,
      repo: registry[target].repo,
      version: tag.version,
      fetchError: tag.fetchError,
      isThirdParty: false,
    };
  }

  // Unknown - treat as third party
  return { name: target, repo: null, version, fetchError: null, isThirdParty: true };
}

/**
 * Output task for Claude to execute via C4
 * In Scene B (terminal), also queues to C4 for delivery
 */
export function outputTask(action, data) {
  const task = {
    type: `component_${action}`,
    ...data,
    timestamp: new Date().toISOString(),
    reply_channel: 'telegram',  // Default reply channel
  };

  // Display task info for user
  console.log('\n[ZYLOS_TASK]');
  console.log(JSON.stringify(task, null, 2));
  console.log('[/ZYLOS_TASK]\n');

  // Queue task via C4 for Scene B (terminal execution)
  // C4 dispatcher will deliver to Claude via tmux
  const c4ReceivePath = path.join(import.meta.dirname, '..', '..', 'skills', 'comm-bridge', 'scripts', 'c4-receive.js');

  try {
    const taskMessage = `[COMPONENT_TASK] ${JSON.stringify(task)}`;
    // Use spawnSync with args array to avoid shell escaping issues
    // Use --no-reply since CLI tasks don't need a reply channel (zylos-cli has no send.js)
    const result = spawnSync('node', [c4ReceivePath, '--no-reply', '--content', taskMessage], {
      stdio: 'pipe',
      encoding: 'utf8'
    });
    if (result.status === 0) {
      console.log('Task queued via C4. Claude will execute when idle.');
      console.log('You will be notified via Telegram/Lark when complete.');
    } else {
      throw new Error(result.stderr || 'C4 queue failed');
    }
  } catch (err) {
    // C4 not available - that's OK, user might be in Claude session
    console.log('Note: C4 not available. If in Claude session, Claude will execute directly.');
  }
}
