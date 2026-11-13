import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfigStrict, configUnreadable } from './config-store.js';
import { updateConfigWithLock } from './config-lock.js';

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

// Codex rewrites its model cache when it updates; a changed file is parsed again,
// an unchanged one is not. Callers treat the returned list as read-only.
const codexModelCache = new Map();
const fileSignature = file => {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return null; }
};

export function readCodexModelWindows({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex') } = {}) {
  const file = path.join(codexHome, 'models_cache.json');
  const before = fileSignature(file);
  const cached = codexModelCache.get(file);
  if (before && cached?.signature === before) return cached.models;
  let models;
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    models = Array.isArray(cache.models) ? cache.models : [];
  } catch {
    // A transient read failure must not become a cached empty model list.
    codexModelCache.delete(file);
    return [];
  }
  // Keep only a result whose file did not change while it was read.
  if (before && fileSignature(file) === before) codexModelCache.set(file, { signature: before, models });
  else codexModelCache.delete(file);
  return models;
}

function isLargeWindow({ runtime, model, contextWindow, codexModels = [] }) {
  if (cleanModel(model).toLowerCase().includes('[1m]')) return true;
  if (Number(contextWindow) >= 1_000_000) return true;
  if (runtime !== 'codex') return false;
  const descriptor = codexModels.find(entry => entry?.slug === model);
  return Number(descriptor?.context_window) >= 1_000_000;
}

/** Keep the context class in Claude keys: the same API ID can run in either window. */
export function modelThresholdKey(options = {}) {
  const model = cleanModel(options.model);
  if (!model) return '';
  return options.runtime === 'claude' && isLargeWindow(options) && !model.toLowerCase().includes('[1m]')
    ? `${model}[1m]` : model;
}

function claudeAlias(model) {
  const id = cleanModel(model).replace(/\[1m\]/ig, '');
  const match = id.match(/^(?:claude-)?(fable|opus|sonnet|haiku)(?:-|$)/);
  return match?.[1] || null;
}
function isAlias(model) { return /^(fable|opus|sonnet|haiku)(\[1m\])?$/.test(cleanModel(model)); }
function candidates(options) {
  const key = modelThresholdKey(options);
  if (!key) return [];
  const family = options.runtime === 'claude' ? claudeAlias(key) : null;
  const alias = family && `${family}${isLargeWindow(options) ? '[1m]' : ''}`;
  const launch = options.launchConfig;
  const startedModel = launch?.runtime === options.runtime ? cleanModel(launch.mode === 'override'
    ? launch.model : launch.mode === 'default' ? options.defaultModel : null) : '';
  return alias && alias !== key && isAlias(startedModel) && startedModel === alias ? [key, alias] : [key];
}
function defaultMatches(options) {
  const { defaultModel } = options;
  if (!cleanModel(options.model) || !cleanModel(defaultModel)) return false;
  const defaultKey = modelThresholdKey({ ...options, model: defaultModel, contextWindow: undefined });
  return defaultKey === modelThresholdKey(options)
    || (options.runtime === 'claude' && isAlias(defaultModel) && candidates(options).includes(defaultKey));
}

export function thresholdLimit(options = {}) { return isLargeWindow(options) ? 40 : 95; }

/** Pure policy shared by settings, session displays and the Supervisor. */
export function modelThreshold(config = {}, options = {}) {
  const runtimeMap = config.model_rotation_thresholds?.[options.runtime];
  if (object(runtimeMap)) {
    for (const key of candidates(options)) {
      const value = Object.hasOwn(runtimeMap, key) ? percent(runtimeMap[key]) : null;
      if (value !== null) return thresholdLimit(options) === 40 ? Math.min(value, 40) : value;
    }
  } else if (defaultMatches(options)) {
    const value = legacyPercent(config[LEGACY_KEYS[options.runtime]]);
    if (value !== null) return thresholdLimit(options) === 40 ? Math.min(value, 40) : value;
  }
  return thresholdLimit(options) === 40 ? 40 : 70;
}

export function readDefaultModels({ zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos') } = {}) {
  let claude = null;
  let codex = null;
  try { claude = cleanModel(JSON.parse(fs.readFileSync(path.join(zylosDir, '.claude/settings.json'), 'utf8')).model) || null; } catch {}
  try {
    // Only root TOML keys belong to the instance defaults; ignore table values.
    const root = fs.readFileSync(path.join(zylosDir, '.codex/config.toml'), 'utf8').split(/^\s*\[/m)[0];
    const match = root.match(/^\s*model\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/m);
    if (match) codex = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1);
  } catch {}
  return { claude, codex };
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
export function migrateModelThresholds({
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
  defaultModels = readDefaultModels({ zylosDir }),
  codexModels = readCodexModelWindows({ home, codexHome }),
  config = loadConfig(configPath(zylosDir)),
  updateConfig,
} = {}) {
  const thresholds = {};
  for (const runtime of ['claude', 'codex']) {
    const model = cleanModel(defaultModels[runtime]);
    if (!model || object(config.model_rotation_thresholds?.[runtime])) continue;
    const value = legacyPercent(config[LEGACY_KEYS[runtime]]);
    if (value === null) continue;
    const options = { runtime, model, codexModels };
    thresholds[runtime] = { [modelThresholdKey(options)]: value };
  }
  if (!Object.keys(thresholds).length) return { changed: false, written: [], skipped: [], config };
  return writer(zylosDir, updateConfig)({ mergeIfAbsent: { model_rotation_thresholds: thresholds } });
}

export function setModelThreshold({
  runtime, model, value, contextWindow,
  zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos'),
  home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
  codexModels = readCodexModelWindows({ home, codexHome }), updateConfig,
} = {}) {
  if (!Object.hasOwn(LEGACY_KEYS, runtime) || !cleanModel(model)) {
    throw Object.assign(new TypeError('runtime and model are required'), { code: 'INVALID_MODEL_THRESHOLD' });
  }
  const options = { runtime, model, contextWindow, codexModels };
  const parsed = percent(value);
  if (parsed === null || parsed < 10 || parsed > thresholdLimit(options)) {
    throw Object.assign(new RangeError(`threshold must be an integer from 10 to ${thresholdLimit(options)}`), { code: 'INVALID_MODEL_THRESHOLD' });
  }
  // Pin both legacy engine defaults before the first per-model write.
  migrateModelThresholds({ zylosDir, codexModels, updateConfig });
  return writer(zylosDir, updateConfig)({ merge: { model_rotation_thresholds: { [runtime]: { [modelThresholdKey(options)]: parsed } } } });
}
