import { readDefaultModels, setModelThreshold } from '../lib/model-rotation-thresholds.js';
/**
 * zylos config - View and update Zylos configuration
 *
 * Usage:
 *   zylos config                  Show all config
 *   zylos config get <key>        Get a config value
 *   zylos config set <key> <val>  Set a config value
 *   zylos config unset alert_target  Remove the alert target (alerts go to the Origin conversation)
 */

import { readZylosConfigOrThrow, updateZylosConfigLocked } from '../lib/config.js';
import { switchProtocol, isCaddyAvailable } from '../lib/caddy.js';
import { parseServerAlertTarget } from '../../skills/activity-monitor/scripts/supervisor-server-observation.js';
import { bold, dim, green, red, yellow, cyan, success, error, warn, heading } from '../lib/colors.js';

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

  if (sub === 'unset') {
    const key = args[1];
    if (!key || args.length > 2) {
      console.error('Usage: zylos config unset alert_target');
      process.exit(1);
    }
    return unsetConfig(key);
  }

  console.error(`Unknown config subcommand: ${sub}`);
  console.error('Usage: zylos config [get <key> | set <key> <value> | unset alert_target]');
  process.exit(1);
}

function showConfig() {
  const config = readZylosConfigOrThrow();
  if (Object.keys(config).length === 0) {
    console.log(dim('No configuration found. Run "zylos init" first.'));
    return;
  }
  for (const [key, value] of Object.entries(config)) {
    console.log(`${bold(key)} = ${cyan(value)}`);
  }
}

function getConfig(key) {
  const config = readZylosConfigOrThrow();
  if (key in config) {
    console.log(config[key]);
  } else {
    console.error(red(`Key not found: ${bold(key)}`));
    process.exit(1);
  }
}

async function setConfig(key, value) {
  if (key === 'new_session_threshold' || key === 'codex_new_session_threshold') {
    const runtime = key === 'new_session_threshold' ? 'claude' : 'codex';
    const model = readDefaultModels()[runtime];
    if (!model) throw Object.assign(new Error('Configure the engine default model before setting its threshold'), { code: 'CONFIG_VALUE_INVALID' });
    setModelThreshold({ runtime, model, value });
    console.log(`${runtime}/${model} threshold = ${value}`);
    return;
  }
  if (key === 'model_rotation_thresholds') {
    throw Object.assign(new Error('Use Dashboard model settings to update individual model thresholds'), { code: 'CONFIG_KEY_RESERVED' });
  }
  if (key === 'session_mode') {
    const reserved = new Error('session_mode is managed by the session cutover workflow');
    reserved.code = 'CONFIG_KEY_RESERVED';
    throw reserved;
  }
  if (key === 'alert_target' && !parseServerAlertTarget(value)) {
    const invalid = new Error('alert_target must be channel:endpoint (non-empty parts, no newline or NUL) or the word default');
    invalid.code = 'CONFIG_VALUE_INVALID';
    throw invalid;
  }
  // Validate allowed values
  if (ALLOWED_VALUES[key] && !ALLOWED_VALUES[key].includes(value)) {
    console.error(red(`Invalid value for "${bold(key)}": ${value}`));
    console.error(dim(`Allowed values: ${ALLOWED_VALUES[key].join(', ')}`));
    process.exit(1);
  }

  const result = updateZylosConfigLocked({ set: { [key]: value } });
  const oldValue = result.previous[key];
  console.log(`${bold(key)} = ${cyan(value)}${oldValue !== undefined ? ` ${dim(`(was: ${oldValue})`)}` : ''}`);

  // Apply side effects
  if (SIDE_EFFECTS[key]) {
    await SIDE_EFFECTS[key](value, oldValue);
  }
}

/** Keys `zylos config unset` may remove; removing others would change how the instance runs. */
const UNSETTABLE = new Set(['alert_target']);

function unsetConfig(key) {
  if (!UNSETTABLE.has(key)) {
    const refused = new Error(`zylos config unset only accepts alert_target, not ${key}`);
    refused.code = 'CONFIG_KEY_RESERVED';
    throw refused;
  }
  const result = updateZylosConfigLocked({ unset: [key] });
  if (Object.hasOwn(result.previous, key)) console.log(`${bold(key)} removed ${dim(`(was: ${result.previous[key]})`)}`);
  else console.log(`${bold(key)} is not set`);
}

/**
 * Side effect: regenerate Caddyfile when protocol changes.
 */
async function applyProtocolChange(newProtocol, oldProtocol) {
  if (newProtocol === oldProtocol) return;

  const config = readZylosConfigOrThrow();
  if (!config.domain) {
    console.log(`  ${warn('No domain configured. Run "zylos init" to set up Caddy.')}`);
    return;
  }

  if (!isCaddyAvailable()) {
    console.log(`  ${warn('Caddy not available. Protocol saved but Caddyfile not updated.')}`);
    return;
  }

  console.log(`  ${dim(`Updating Caddyfile (${oldProtocol || 'https'} → ${newProtocol})...`)}`);
  const result = switchProtocol(config.domain, newProtocol);

  if (result.success) {
    console.log(`  ${success('Caddyfile updated and Caddy reloaded')}`);
  } else {
    console.error(`  ${error(`Failed to update Caddyfile: ${result.error}`)}`);
    // Revert config
    updateZylosConfigLocked({ set: { protocol: oldProtocol || 'https' } });
    console.error(`  ${dim('Config reverted.')}`);
    process.exit(1);
  }
}
