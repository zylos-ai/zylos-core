/**
 * Component management utilities
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMPONENTS_FILE } from './config.js';
import { loadRegistry } from './registry.js';
import { fetchLatestTag } from './github.js';
import { inspectLocalSource, resolveLocalPath } from './download.js';

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
 * Resolve component target from a registry name, GitHub reference, or local path.
 *
 * The returned `source` descriptor is intentionally independent from `add` so
 * the same descriptor can be persisted and consumed by a future upgrade flow.
 *
 * @param {string} nameOrUrl
 * @param {{ branch?: string | null }} [options]
 * @returns {Promise<object>}
 */
export async function resolveTarget(nameOrUrl, { branch = null } = {}) {
  if (isLocalPathSpecifier(nameOrUrl)) {
    try {
      const inspected = inspectLocalSource(nameOrUrl);
      return {
        name: inspected.name,
        repo: null,
        version: inspected.version,
        fetchError: null,
        isThirdParty: true,
        source: inspected.source,
        sourceLabel: inspected.source.path,
        sourceHeading: 'Source:',
        sourceReplyLabel: 'Source',
        installTarget: inspected.source.path,
      };
    } catch (err) {
      return {
        name: localFallbackName(nameOrUrl),
        repo: null,
        version: null,
        fetchError: null,
        isThirdParty: true,
        source: null,
        sourceLabel: resolveLocalPath(nameOrUrl),
        installTarget: nameOrUrl,
        resolutionError: err.message,
      };
    }
  }

  // Extract version if present (name@version or org/repo@version)
  let version = null;
  let target = nameOrUrl;
  if (nameOrUrl.includes('@') && !nameOrUrl.startsWith('http')) {
    const atIndex = nameOrUrl.lastIndexOf('@');
    target = nameOrUrl.substring(0, atIndex);
    version = nameOrUrl.substring(atIndex + 1);
  }

  // Helper: try fetchLatestTag, capture network errors separately
  function tryFetchLatestTag(repo) {
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
    return resolveGitHubTarget({ name, repo, version, branch, tryFetchLatestTag, installTarget: nameOrUrl });
  }

  // Check if it's in format org/repo
  if (target.includes('/')) {
    const name = target.split('/')[1].replace(/^zylos-/, '');
    return resolveGitHubTarget({ name, repo: target, version, branch, tryFetchLatestTag, installTarget: nameOrUrl });
  }

  // Look up in registry
  const registry = await loadRegistry();
  if (registry[target]) {
    return resolveGitHubTarget({
      name: target,
      repo: registry[target].repo,
      version,
      branch,
      tryFetchLatestTag,
      installTarget: nameOrUrl,
      isThirdParty: false,
    });
  }

  // Unknown - treat as third party
  return {
    name: target,
    repo: null,
    version,
    fetchError: null,
    isThirdParty: true,
    source: null,
    sourceLabel: null,
    installTarget: nameOrUrl,
  };
}

/**
 * Registry metadata is presentation-only. Local sources must remain fully
 * offline, so they never trigger the remote registry fallback chain.
 */
export async function loadTargetRegistryInfo(resolved) {
  if (!resolved.repo) return {};
  const registry = await loadRegistry();
  return registry[resolved.name] || {};
}

function resolveGitHubTarget({
  name,
  repo,
  version,
  branch,
  tryFetchLatestTag,
  installTarget,
  isThirdParty = !repo.startsWith('zylos-ai/'),
}) {
  const tag = branch
    ? { version: null, fetchError: null }
    : (version ? { version, fetchError: null } : tryFetchLatestTag(repo));
  const resolvedVersion = tag.version;
  const ref = branch || resolvedVersion;
  return {
    name,
    repo,
    version: resolvedVersion,
    fetchError: tag.fetchError,
    isThirdParty,
    source: ref ? {
      type: 'github-release',
      repo,
      ref,
      refType: branch ? 'branch' : 'tag',
    } : null,
    sourceLabel: `https://github.com/${repo}`,
    sourceHeading: 'Repository:',
    sourceReplyLabel: 'Repo',
    installTarget,
  };
}

export function isLocalPathSpecifier(value) {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)) return false;
  return path.isAbsolute(value)
    || value === '.'
    || value === '..'
    || value.startsWith(`.${path.sep}`)
    || value.startsWith(`..${path.sep}`)
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('~/')
    || /\.(?:tar\.gz|tgz)$/i.test(value);
}

function localFallbackName(value) {
  return path.basename(value).replace(/\.(?:tar\.gz|tgz)$/i, '').replace(/^zylos-/, '') || 'local-component';
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
