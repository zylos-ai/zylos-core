/**
 * Registry utilities
 */

import fs from 'node:fs';
import https from 'node:https';
import { REGISTRY_FILE, REGISTRY_URL } from './config.js';

/**
 * Load local registry from registry.json
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
 * Load registry (try remote first, fallback to local file)
 * Returns the components object (unwrapped)
 */
export async function loadRegistry() {
  const localRegistry = loadLocalRegistry();

  try {
    return new Promise((resolve) => {
      const req = https.get(REGISTRY_URL, { timeout: 5000 }, (res) => {
        // Check for successful response
        if (res.statusCode !== 200) {
          resolve(localRegistry);
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
            resolve(localRegistry);
          }
        });
      });
      req.on('error', () => resolve(localRegistry));
      req.on('timeout', () => {
        req.destroy();
        resolve(localRegistry);
      });
    });
  } catch {
    return localRegistry;
  }
}
