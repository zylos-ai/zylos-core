/**
 * Registry utilities
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { REGISTRY_FILE, REGISTRY_URL } from './config.js';
import { getGitHubToken } from './github.js';

// Built-in registry shipped with the zylos package
const BUILTIN_REGISTRY_PATH = path.join(import.meta.dirname, '..', '..', 'registry.json');

/**
 * Load built-in registry bundled with zylos-core.
 * Returns the components object (unwrapped).
 */
function loadBuiltinRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(BUILTIN_REGISTRY_PATH, 'utf8'));
    return data.components || data;
  } catch {
    return {};
  }
}

/**
 * Load local registry from ~/.zylos/registry.json
 * Returns the components object (unwrapped from version/components structure)
 */
export function loadLocalRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    // Handle both formats: { components: {...} } or flat { name: {...} }
    return data.components || data;
  } catch {
    return {};
  }
}

/**
 * Load registry with fallback chain:
 * 1. Remote registry (zylos-registry GitHub repo)
 * 2. Local registry (~/.zylos/registry.json)
 * 3. Built-in registry (shipped with zylos package)
 *
 * Returns the components object (unwrapped)
 */
export async function loadRegistry() {
  const localRegistry = loadLocalRegistry();
  const builtinRegistry = loadBuiltinRegistry();

  // Merge built-in as base, local overrides
  const fallback = { ...builtinRegistry, ...localRegistry };

  try {
    return new Promise((resolve) => {
      const headers = {};
      const token = getGitHubToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const req = https.get(REGISTRY_URL, { timeout: 5000, headers }, (res) => {
        // Check for successful response
        if (res.statusCode !== 200) {
          resolve(fallback);
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Handle both formats
            resolve(parsed.components || parsed);
          } catch {
            resolve(fallback);
          }
        });
      });
      req.on('error', () => resolve(fallback));
      req.on('timeout', () => {
        req.destroy();
        resolve(fallback);
      });
    });
  } catch {
    return fallback;
  }
}
