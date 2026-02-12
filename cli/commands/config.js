/**
 * zylos config - View and update Zylos configuration
 *
 * Usage:
 *   zylos config                  Show all config
 *   zylos config get <key>        Get a config value
 *   zylos config set <key> <val>  Set a config value
 */

import { getZylosConfig, updateZylosConfig } from '../lib/config.js';
import { switchProtocol, isCaddyAvailable } from '../lib/caddy.js';

/** Keys that trigger side effects when changed */
const SIDE_EFFECTS = {
  protocol: applyProtocolChange,
};

/** Allowed values per key (for validation) */
const ALLOWED_VALUES = {
  protocol: ['http', 'https'],
};

/**
 * Main config command handler.
 */
export async function configCommand(args) {
  const sub = args[0];

  if (!sub) {
    return showConfig();
  }

  if (sub === 'get') {
    const key = args[1];
    if (!key) {
      console.error('Usage: zylos config get <key>');
      process.exit(1);
    }
    return getConfig(key);
  }

  if (sub === 'set') {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      console.error('Usage: zylos config set <key> <value>');
      process.exit(1);
    }
    return setConfig(key, value);
  }

  console.error(`Unknown config subcommand: ${sub}`);
  console.error('Usage: zylos config [get <key> | set <key> <value>]');
  process.exit(1);
}

function showConfig() {
  const config = getZylosConfig();
  if (Object.keys(config).length === 0) {
    console.log('No configuration found. Run "zylos init" first.');
    return;
  }
  for (const [key, value] of Object.entries(config)) {
    console.log(`${key} = ${value}`);
  }
}

function getConfig(key) {
  const config = getZylosConfig();
  if (key in config) {
    console.log(config[key]);
  } else {
    console.error(`Key not found: ${key}`);
    process.exit(1);
  }
}

async function setConfig(key, value) {
  // Validate allowed values
  if (ALLOWED_VALUES[key] && !ALLOWED_VALUES[key].includes(value)) {
    console.error(`Invalid value for "${key}": ${value}`);
    console.error(`Allowed values: ${ALLOWED_VALUES[key].join(', ')}`);
    process.exit(1);
  }

  const config = getZylosConfig();
  const oldValue = config[key];

  updateZylosConfig({ [key]: value });
  console.log(`${key} = ${value}${oldValue !== undefined ? ` (was: ${oldValue})` : ''}`);

  // Apply side effects
  if (SIDE_EFFECTS[key]) {
    await SIDE_EFFECTS[key](value, oldValue);
  }
}

/**
 * Side effect: regenerate Caddyfile when protocol changes.
 */
async function applyProtocolChange(newProtocol, oldProtocol) {
  if (newProtocol === oldProtocol) return;

  const config = getZylosConfig();
  if (!config.domain) {
    console.log('  ⚠ No domain configured. Run "zylos init" to set up Caddy.');
    return;
  }

  if (!isCaddyAvailable()) {
    console.log('  ⚠ Caddy not available. Protocol saved but Caddyfile not updated.');
    return;
  }

  console.log(`  Updating Caddyfile (${oldProtocol || 'https'} → ${newProtocol})...`);
  const result = switchProtocol(config.domain, newProtocol);

  if (result.success) {
    console.log('  ✓ Caddyfile updated and Caddy reloaded');
  } else {
    console.error(`  ✗ Failed to update Caddyfile: ${result.error}`);
    // Revert config
    updateZylosConfig({ protocol: oldProtocol || 'https' });
    console.error('  Config reverted.');
    process.exit(1);
  }
}
