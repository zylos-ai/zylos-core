import os from 'node:os';
import path from 'node:path';
import { readConfigStrict, configUnreadable } from './config-store.js';
import { updateConfigWithLock } from './config-lock.js';
import { getRuntime, SUPPORTED_RUNTIMES } from './runtime/index.js';
import { UNSUPPORTED } from './runtime/contract.js';

const LEGACY_KEYS = { claude: 'new_session_threshold', codex: 'codex_new_session_threshold' };
const object = value => value !== null && !Array.isArray(value) && typeof value === 'object';
const percent = value => {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
  return Number.isInteger(value) && value > 0 && value <= 100 ? value : null;
};
const legacyPercent = value => {
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 && parsed <= 100 ? parsed : null;
};
const cleanModel = model => typeof model === 'string' ? model.trim() : '';

export async function loadRuntimeContexts() {
  return Object.fromEntries(await Promise.all(SUPPORTED_RUNTIMES.map(async id => [id, (await getRuntime(id)).context])));
}

export function readModelWindows({ home = os.homedir(), env = process.env, contexts }) {
  return Object.fromEntries(SUPPORTED_RUNTIMES
    .filter(id => contexts[id].readModelWindows !== UNSUPPORTED)
    .map(id => [id, contexts[id].readModelWindows({ home, env })]));
}

function isLargeWindow({ runtime, context, model, contextWindow, modelWindows }) {
  return cleanModel(model).toLowerCase().includes('[1m]')
    || Number(contextWindow) >= 1_000_000
    || Number(context.contextWindowFor(model, modelWindows?.[runtime])) >= 1_000_000;
}

function requireContext({ context, runtime }) {
  if (!context) throw Object.assign(new TypeError(`Unsupported runtime: ${runtime}`), { code: 'RUNTIME_UNSUPPORTED' });
}

/** Keep the context class in keys when the runtime distinguishes window variants. */
export function modelThresholdKey(options = {}) {
  requireContext(options);
  const model = cleanModel(options.model);
  return model ? options.context.thresholdKeys.key(model, isLargeWindow(options)) : '';
}

function candidates(options) {
  const key = modelThresholdKey(options);
  if (!key) return [];
  const alias = options.context.thresholdKeys.alias(key, isLargeWindow(options));
  const launch = options.launchConfig;
  const startedModel = launch?.runtime === options.runtime ? cleanModel(launch.mode === 'override'
    ? launch.model : launch.mode === 'default' ? options.defaultModel : null) : '';
  const keys = alias && alias !== key && options.context.thresholdKeys.isAlias(startedModel) && startedModel === alias ? [key, alias] : [key];
  // Settings store the launch model's own key without the observed window (e.g. `opus` for a session that runs at 1M).
  const launchKey = startedModel ? modelThresholdKey({ ...options, model: startedModel, contextWindow: undefined }) : '';
  return launchKey && !keys.includes(launchKey) ? [...keys, launchKey] : keys;
}
function defaultMatches(options) {
  const { defaultModel } = options;
  if (!cleanModel(options.model) || !cleanModel(defaultModel)) return false;
  const defaultKey = modelThresholdKey({ ...options, model: defaultModel, contextWindow: undefined });
  return defaultKey === modelThresholdKey(options)
    || (options.context.thresholdKeys.isAlias(defaultModel) && candidates(options).includes(defaultKey));
}

export function thresholdLimit(options = {}) {
  requireContext(options);
  return 95;
}

/** Pure policy shared by settings, session displays and the Supervisor. */
export function modelThreshold(config = {}, options = {}) {
  if (!options.context) return null;
  const runtimeMap = config.model_rotation_thresholds?.[options.runtime];
  if (object(runtimeMap)) {
    for (const key of candidates(options)) {
      const value = Object.hasOwn(runtimeMap, key) ? percent(runtimeMap[key]) : null;
      if (value !== null) return value;
    }
  } else if (defaultMatches(options)) {
    const value = legacyPercent(config[LEGACY_KEYS[options.runtime]]);
    if (value !== null) return value;
  }
  return isLargeWindow(options) ? 20 : 75;
}

export function readDefaultModels({ zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'), contexts }) {
  return Object.fromEntries(SUPPORTED_RUNTIMES
    .filter(id => contexts[id].readDefaultModel !== UNSUPPORTED)
    .map(id => [id, contexts[id].readDefaultModel({ zylosDir })]));
}

function configPath(zylosDir) { return path.join(zylosDir, '.zylos/config.json'); }
function loadConfig(file) {
  const result = readConfigStrict(file);
  if (result.state === 'error') throw configUnreadable(result.error);
  return result.state === 'ok' ? result.config : {};
}
function writer(zylosDir, updateConfig) {
  const configFile = configPath(zylosDir);
  const options = { configFile, lockFile: `${configFile}.lock`, waitMs: 2000 };
  return update => updateConfig ? updateConfig(update, options) : updateConfigWithLock({ ...options, update });
}

/** Pin legacy values to the native defaults once; retain old scalar keys for old readers. */
export async function migrateModelThresholds({
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  defaultModels,
  config,
  updateConfig,
} = {}) {
  defaultModels ??= readDefaultModels({ zylosDir, contexts: await loadRuntimeContexts() });
  if (config === undefined) config = loadConfig(configPath(zylosDir));
  const thresholds = {};
  for (const runtime of ['claude', 'codex']) {
    const model = cleanModel(defaultModels[runtime]);
    if (!model || object(config.model_rotation_thresholds?.[runtime])) continue;
    const value = legacyPercent(config[LEGACY_KEYS[runtime]]);
    if (value === null) continue;
    thresholds[runtime] = { [model]: value };
  }
  if (!Object.keys(thresholds).length) return { changed: false, written: [], skipped: [], config };
  return writer(zylosDir, updateConfig)({ mergeIfAbsent: { model_rotation_thresholds: thresholds } });
}

export async function setModelThreshold({
  runtime, model, value, contextWindow,
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  home = os.homedir(), env = process.env, modelWindows, updateConfig,
} = {}) {
  if (!SUPPORTED_RUNTIMES.includes(runtime) || !cleanModel(model)) {
    throw Object.assign(new TypeError('runtime and model are required'), { code: 'INVALID_MODEL_THRESHOLD' });
  }
  const contexts = await loadRuntimeContexts();
  modelWindows ??= readModelWindows({ home, env, contexts });
  const options = { runtime, context: contexts[runtime], model, contextWindow, modelWindows };
  const parsed = percent(value);
  if (parsed === null || parsed < 10 || parsed > thresholdLimit(options)) {
    throw Object.assign(new RangeError(`threshold must be an integer from 10 to ${thresholdLimit(options)}`), { code: 'INVALID_MODEL_THRESHOLD' });
  }
  // Pin both legacy engine defaults before the first per-model write.
  await migrateModelThresholds({ zylosDir, updateConfig });
  return writer(zylosDir, updateConfig)({ merge: { model_rotation_thresholds: { [runtime]: { [modelThresholdKey(options)]: parsed } } } });
}
