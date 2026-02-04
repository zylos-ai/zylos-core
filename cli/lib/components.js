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
 */
function outputTask(action, data) {
  console.log('\n[ZYLOS_TASK]');
  console.log(JSON.stringify({ action, ...data }, null, 2));
  console.log('[/ZYLOS_TASK]\n');
}

module.exports = {
  loadComponents,
  saveComponents,
  resolveTarget,
  outputTask,
};
