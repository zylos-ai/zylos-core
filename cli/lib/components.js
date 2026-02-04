/**
 * Component management utilities
 */

const fs = require('fs');
const path = require('path');
const { ZYLOS_DIR } = require('./config');
const { loadRegistry } = require('./registry');

const COMPONENTS_FILE = path.join(ZYLOS_DIR, 'components.json');

/**
 * Load installed components from components.json
 */
function loadComponents() {
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
function saveComponents(components) {
  fs.writeFileSync(COMPONENTS_FILE, JSON.stringify(components, null, 2));
}

/**
 * Resolve component target from name or URL
 * Supports: name, name@version, org/repo, org/repo@version, github-url
 * @returns {object} { name, repo, version, isThirdParty }
 */
async function resolveTarget(nameOrUrl) {
  // Extract version if present (name@version or org/repo@version)
  let version = null;
  let target = nameOrUrl;
  if (nameOrUrl.includes('@') && !nameOrUrl.startsWith('http')) {
    const atIndex = nameOrUrl.lastIndexOf('@');
    target = nameOrUrl.substring(0, atIndex);
    version = nameOrUrl.substring(atIndex + 1);
  }

  // Check if it's a GitHub URL
  const githubMatch = target.match(/github\.com\/([^\/]+\/[^\/]+)/);
  if (githubMatch) {
    const repo = githubMatch[1].replace(/\.git$/, '');
    const name = repo.split('/')[1].replace(/^zylos-/, '');
    return { name, repo, version, isThirdParty: !repo.startsWith('zylos-ai/') };
  }

  // Check if it's in format org/repo
  if (target.includes('/')) {
    const name = target.split('/')[1].replace(/^zylos-/, '');
    return { name, repo: target, version, isThirdParty: !target.startsWith('zylos-ai/') };
  }

  // Look up in registry
  const registry = await loadRegistry();
  if (registry[target]) {
    return {
      name: target,
      repo: registry[target].repo,
      version: version || registry[target].latest,
      isThirdParty: false,
    };
  }

  // Unknown - treat as third party
  return { name: target, repo: null, version, isThirdParty: true };
}

/**
 * Output task for Claude to execute via C4
 * In Scene B (terminal), also queues to C4 for delivery
 */
function outputTask(action, data) {
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
  const { spawnSync } = require('child_process');
  const c4ReceivePath = path.join(__dirname, '..', '..', 'skills', 'comm-bridge', 'c4-receive.js');

  try {
    const taskMessage = `[COMPONENT_TASK] ${JSON.stringify(task)}`;
    // Use spawnSync with args array to avoid shell escaping issues
    const result = spawnSync('node', [c4ReceivePath, '--source', 'zylos-cli', '--content', taskMessage], {
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

module.exports = {
  loadComponents,
  saveComponents,
  resolveTarget,
  outputTask,
};
