/**
 * Registry utilities
 */

const fs = require('fs');
const { REGISTRY_FILE, REGISTRY_URL } = require('./config');

/**
 * Load local registry from registry.json
 */
function loadLocalRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Load registry (try remote first, fallback to local file)
 */
async function loadRegistry() {
  const localRegistry = loadLocalRegistry();

  try {
    const https = require('https');
    return new Promise((resolve) => {
      const req = https.get(REGISTRY_URL, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
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

module.exports = {
  loadLocalRegistry,
  loadRegistry,
};
