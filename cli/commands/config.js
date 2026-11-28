import { LEGACY_KEYS, loadRuntimeContexts, modelThreshold, readDefaultModels, readModelWindows, setModelThreshold } from '../lib/model-rotation-thresholds.js';
/**
 * zylos config - View and update Zylos configuration
 *
 * Usage:
 *   zylos config                  Show all config
 *   zylos config get <key>        Get a config value
 *   zylos config set <key> <val>  Set a config value
 *   zylos config unset alert_target  Remove the alert target (alerts go to the Origin conversation)
 *   zylos config unset memory_dream_model|memory_dream_effort  Restore the current runtime's dream default
 */

import { readZylosConfigOrThrow, updateZylosConfigLocked } from '../lib/config.js';
import { DREAM_SETTING_KEYS, dreamSettingUpdate, dreamSettings } from '../lib/dream-settings.js';
import { DEFAULT_RUNTIME, getRuntime, runtimeDisplayName } from '../lib/runtime/index.js';
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
      console.error(`Usage: zylos config unset ${[...UNSETTABLE].join('|')}`);
      process.exit(1);
    }
    return unsetConfig(key);
  }

  console.error(`Unknown config subcommand: ${sub}`);
  console.error(`Usage: zylos config [get <key> | set <key> <value> | unset ${[...UNSETTABLE].join('|')}]`);
  process.exit(1);
}

/** Legacy threshold keys: `set` writes the engine default model's entry, so show that effective value. */
const THRESHOLD_RUNTIME = Object.fromEntries(Object.entries(LEGACY_KEYS).map(([runtime, key]) => [key, runtime]));

/** Dream settings are stored per runtime; the configured runtime's effective value is the one shown and changed. */
const DREAM_KIND = Object.fromEntries(Object.entries(DREAM_SETTING_KEYS).map(([kind, key]) => [key, kind]));
const configuredRuntime = config => getRuntime(config.runtime ?? DEFAULT_RUNTIME);

async function displayValues(config, keys = Object.keys(config)) {
  const effective = {};
  if (keys.some(key => Object.hasOwn(DREAM_KIND, key))) {
    const settings = dreamSettings(config, await configuredRuntime(config));
    for (const key of keys.filter(key => Object.hasOwn(DREAM_KIND, key))) {
      const value = settings[DREAM_KIND[key]];
      if (value !== null) effective[key] = value;
    }
  }
  const thresholdKeys = keys.filter(key => Object.hasOwn(THRESHOLD_RUNTIME, key));
  if (thresholdKeys.length) {
    const contexts = await loadRuntimeContexts();
    const defaultModels = readDefaultModels({ contexts });
    const modelWindows = readModelWindows({ contexts });
    for (const key of thresholdKeys) {
      const runtime = THRESHOLD_RUNTIME[key];
      const model = defaultModels[runtime];
      if (model) effective[key] = modelThreshold(config, { runtime, context: contexts[runtime], model, defaultModel: model, modelWindows });
    }
  }
  const values = {};
  for (const key of keys) {
    if (Object.hasOwn(effective, key)) values[key] = effective[key];
    else if (Object.hasOwn(DREAM_KIND, key)) continue;
    else if (key in config) values[key] = config[key] !== null && typeof config[key] === 'object' ? JSON.stringify(config[key]) : config[key];
  }
  return values;
}

async function showConfig() {
  const config = readZylosConfigOrThrow();
  if (Object.keys(config).length === 0) {
    console.log(dim('No configuration found. Run "zylos init" first.'));
    return;
  }
  const keys = [...new Set([...Object.keys(config), ...Object.values(DREAM_SETTING_KEYS)])];
  for (const [key, value] of Object.entries(await displayValues(config, keys))) {
    console.log(`${bold(key)} = ${cyan(value)}`);
  }
}

async function getConfig(key) {
  const config = readZylosConfigOrThrow();
  const values = await displayValues(config, [key]);
  if (Object.hasOwn(values, key)) {
    console.log(values[key]);
  } else if (Object.hasOwn(DREAM_KIND, key)) {
    console.error(red(`${runtimeDisplayName(config.runtime ?? DEFAULT_RUNTIME)} has no separate dream ${DREAM_KIND[key]}`));
    process.exit(1);
  } else {
    console.error(red(`Key not found: ${bold(key)}`));
    process.exit(1);
  }
}

async function setConfig(key, value) {
  if (Object.hasOwn(DREAM_KIND, key)) return writeDreamSetting(key, value);
  if (Object.hasOwn(THRESHOLD_RUNTIME, key)) {
    const runtime = THRESHOLD_RUNTIME[key];
    const model = readDefaultModels({ contexts: await loadRuntimeContexts() })[runtime];
    if (!model) throw Object.assign(new Error('Configure the engine default model before setting its threshold'), { code: 'CONFIG_VALUE_INVALID' });
    await setModelThreshold({ runtime, model, value });
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
  const calendarLimit = { memory_dream_hour: 23, memory_tidy_weekday: 6 };
  if (Object.hasOwn(calendarLimit, key) && (!/^\d+$/.test(value) || Number(value) > calendarLimit[key])) {
    throw Object.assign(new Error(`${key} must be an integer from 0 to ${calendarLimit[key]}`), { code: 'CONFIG_VALUE_INVALID' });
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

async function writeDreamSetting(key, value) {
  const config = readZylosConfigOrThrow();
  const runtime = await configuredRuntime(config);
  let update;
  try { update = dreamSettingUpdate(runtime, DREAM_KIND[key], value); }
  catch (failure) { throw Object.assign(new Error(failure.message), { code: 'CONFIG_VALUE_INVALID' }); }
  updateZylosConfigLocked(update);
  const settings = dreamSettings(readZylosConfigOrThrow(), runtime);
  const kind = DREAM_KIND[key], previous = dreamSettings(config, runtime);
  const label = value === null ? `${settings[kind]} ${dim('(default)')}` : cyan(settings[kind]);
  console.log(`${bold(key)} = ${label} ${dim(`(${runtimeDisplayName(runtime.id)}; was: ${previous[kind]})`)}`);
}

/** Keys `zylos config unset` may remove; removing others would change how the instance runs. */
const UNSETTABLE = new Set(['alert_target', ...Object.values(DREAM_SETTING_KEYS)]);

async function unsetConfig(key) {
  if (Object.hasOwn(DREAM_KIND, key)) return writeDreamSetting(key, null);
  if (!UNSETTABLE.has(key)) {
    const refused = new Error(`zylos config unset only accepts ${[...UNSETTABLE].join(', ')}, not ${key}`);
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
