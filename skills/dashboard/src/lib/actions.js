import { handleCoreAction } from './core-actions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { getDashboardRuntime } from './runtime/index.js';
import { UNSUPPORTED } from './runtime/contract.js';
import { loadCoreModule } from './core-modules.js';

const { DEFAULT_RUNTIME, SUPPORTED_RUNTIMES, findRuntime, getRuntime, runtimeDisplayName, runtimesWith } = await loadCoreModule('runtime/index.js');
const { modelThreshold, thresholdLimit, loadRuntimeContexts, readModelWindows, migrateModelThresholds, setModelThreshold } = await loadCoreModule('model-rotation-thresholds.js');
// This module awaits both runtime factories at top level. Runtime implementations must not statically import it.
const thresholdContexts = await loadRuntimeContexts();
const { resolveSessionHotTtl, HOT_TTL_MIN_MINUTES, HOT_TTL_MAX_MINUTES } = await loadCoreModule('session-hot-ttl.js');
const { readConfigStrict, configUnreadable } = await loadCoreModule('config-store.js');
const { updateConfigWithLock } = await loadCoreModule('config-lock.js');
const { dreamSettings, dreamSettingUpdate } = await loadCoreModule('dream-settings.js');
const CORE_RUNTIMES = new Map(await Promise.all(SUPPORTED_RUNTIMES.map(async id => [id, await getRuntime(id)])));
const modelRuntimeIds = runtimesWith('modelOverride');
const dashboardModelRuntimes = await Promise.all(modelRuntimeIds.map(id => getDashboardRuntime(id)));
const coreModelRuntimes = await Promise.all(modelRuntimeIds.map(id => getRuntime(id)));
const MODEL_RUNTIMES = new Map(coreModelRuntimes.map((runtime, index) => [
  runtime.id, { config: runtime.launch.modelConfig, catalog: dashboardModelRuntimes[index].modelCatalog },
]));

const execFileAsync = promisify(execFile);
const DEDUP_WINDOW_MS = 2000;
const recentInvocations = new Map();

function log(reqId, msg) {
  process.stderr.write(`[actions ${reqId}] ${msg}\n`);
}

function dedupKey(action, body) {
  const payload = body || {};
  if (['restart-session', 'interrupt', 'chop-chop'].includes(action)) {
    const { runId, sessionId, ...fields } = payload;
    return `${action}:${JSON.stringify(fields)}`;
  }
  return `${action}:${JSON.stringify(payload)}`;
}

function isDuplicate(action, body) {
  const key = dedupKey(action, body);
  const now = Date.now();
  for (const [k, ts] of recentInvocations) {
    if (now - ts > DEDUP_WINDOW_MS) recentInvocations.delete(k);
  }
  const prev = recentInvocations.get(key);
  if (prev && now - prev <= DEDUP_WINDOW_MS) return true;
  recentInvocations.set(key, now);
  return false;
}

export async function handleAction(action, body, config, { timezone } = {}) {
  const reqId = crypto.randomBytes(3).toString('hex');
  const zylosDir = config.zylosDir || path.join(os.homedir(), 'zylos');
  log(reqId, `=> ${action} ${JSON.stringify(body || {})}`);

  if (action === 'upgrade-cc' && !SUPPORTED_RUNTIMES.includes(body?.runtime)) {
    return { ok: false, error: 'runtime_unsupported',
      message: `Choose ${SUPPORTED_RUNTIMES.slice(0, -1).join(', ')} or ${SUPPORTED_RUNTIMES.at(-1)} for the CLI upgrade.`,
      messageKey: 'result.runtime_upgrade_unsupported' };
  }

  // Timezone restarts act only on the explicitly confirmed remaining services;
  // immediate partial-failure retries must reach fresh discovery.
  if (action !== 'restart-timezone-services' && isDuplicate(action, body)) {
    log(reqId, `<= deduped (same payload within ${DEDUP_WINDOW_MS}ms)`);
    return { ok: false, error: 'duplicate_request', message: 'Identical request received within dedup window; ignored.', messageKey: 'result.duplicate_request' };
  }

  let result;
  try {
    switch (action) {
      case 'restart-timezone-services': result = timezone ? await timezone.restart(body) : { ok: false, error: 'service_discovery_unavailable', status: 503 }; break;
      case 'interrupt':
      case 'chop-chop':
      case 'restart-session':
      case 'switch-mode':
      case 'switch-runtime': result = await handleCoreAction(action, body, { ...config, zylosDir }); break;
      case 'switch-model': result = await switchModel(reqId, body, config, zylosDir); break;
      case 'switch-effort': result = await switchEffort(reqId, body, config, zylosDir); break;
      case 'set-threshold': result = await setThreshold(reqId, body, config, zylosDir); break;
      case 'set-session-hot-ttl': result = await setSessionHotTtl(reqId, body, zylosDir); break;
      case 'set-dream-model': result = setDreamSetting(reqId, 'model', body, zylosDir); break;
      case 'set-dream-effort': result = setDreamSetting(reqId, 'effort', body, zylosDir); break;
      case 'upgrade-cc': result = await upgradeRuntimeCli(reqId, body.runtime, zylosDir); break;
      default: result = { ok: false, error: 'unknown_action', messageKey: 'result.unknown_action' };
    }
  } catch (err) {
    log(reqId, `<= unhandled error: ${err.message}`);
    result = { ok: false, error: 'internal_error', message: err.message, messageKey: 'result.internal_error', messageParams: { error: err.message } };
  }

  if (action === 'switch-runtime' && !result.ok && ['AUTH_FAILED', 'AUTH_NOT_CONFIRMED', 'INSTRUCTIONS_UNAVAILABLE', 'RUNTIME_SETUP_INCOMPLETE'].includes(result.error?.code)) {
    result = { ...result, messageKey: null,
      message: [result.error.code, result.error.message].filter(Boolean).join(': ') };
  }

  // Command envelopes carry error as { code, message }; the log names the code instead of [object Object].
  const errorLabel = result.error && typeof result.error === 'object' ? result.error.code : result.error;
  log(reqId, `<= ${result.ok ? 'ok' : 'fail'}${errorLabel ? ' ' + errorLabel : ''}${result.message ? ' | ' + result.message : ''}`);
  return result;
}

function resolveModelRuntime(body, config) {
  const runtime = body?.runtime === undefined
    ? config.runtime || process.env.ZYLOS_RUNTIME || DEFAULT_RUNTIME
    : body.runtime;
  const implementation = MODEL_RUNTIMES.get(runtime);
  return implementation ? { runtime, ...implementation } : null;
}

async function switchModel(reqId, body, config, zylosDir) {
  if (body?.runtime !== undefined && !MODEL_RUNTIMES.has(body.runtime)) {
    return { ok: false, error: 'INVALID_RUNTIME' };
  }
  const model = body?.model;
  if (!model || typeof model !== 'string') {
    return { ok: false, error: 'invalid_model', message: 'model is required', messageKey: 'result.invalid_model' };
  }

  const resolved = resolveModelRuntime(body, config);
  if (!resolved) return { ok: false, error: 'INVALID_RUNTIME' };
  const { runtime, config: modelConfig } = resolved;
  const alreadySet = () => ({
    ok: false, error: 'already_set', message: `Model already set to ${model}`,
    messageKey: 'result.already_set_model', messageParams: { value: model },
  });
  if (modelConfig.read(zylosDir).model === model) {
    log(reqId, `no-op: ${runtime} model already "${model}"`);
    return alreadySet();
  }

  let observed, readSessionMode, mode, restartObservedGroups;
  if (body.runtime !== undefined) {
    ({ readSessionMode } = await loadCoreModule('config.js'));
    mode = readSessionMode().mode;
    if (mode === 'single' || mode === 'multi') {
      let observeRuntimeGroups;
      ({ observeRuntimeGroups, restartObservedGroups } = await loadCoreModule('config-restart.js'));
      observed = await observeRuntimeGroups(runtime, mode, { modelRuntime: runtime });
      if (body.confirmed !== true && (!observed.groupsComplete || observed.groups.some(group => ['restart_needed', 'unknown'].includes(group.status)))) {
        return { ok: false, status: 409, error: { code: 'CONFIRMATION_REQUIRED',
          message: 'Refresh the session list and confirm the affected sessions before saving.' },
        messageKey: 'wb.settings.modelConfirmationRequired' };
      }
    }
  }
  await migrateModelThresholds({ zylosDir });
  // Discovery yields to other writes. Core reads the current file at save time.
  const { changed, previous, file, key } = await modelConfig.write(zylosDir, 'model', model);
  if (!changed) {
    log(reqId, `no-op: ${file}: ${key} already "${model}"`);
    return alreadySet();
  }
  log(reqId, `write ${file}: ${key} "${previous ?? '(unset)'}" → "${model}"`);
  if (observed) {
    let modeChanged = true;
    try { modeChanged = readSessionMode().mode !== mode; } catch { /* The save succeeded; the run cannot be safely targeted. */ }
    await restartObservedGroups(observed, { modeChanged });
  }
  return { ok: true, message: `Model changed to ${model}.`, previous, requires_restart: body.runtime === undefined, runtime,
    ...(observed && { data: observed }), messageKey: 'result.model_changed', messageParams: { value: model, runtime } };
}

async function switchEffort(reqId, body, config, zylosDir) {
  const resolved = resolveModelRuntime(body, config);
  if (!resolved) return { ok: false, error: 'INVALID_RUNTIME' };
  const { runtime, config: modelConfig, catalog } = resolved;
  const effort = body?.effort;
  const valid = catalog.effortsFor(modelConfig.read(zylosDir).model ?? '');

  if (valid === null) {
    return { ok: false, error: 'unknown_model_capabilities', message: 'Effort capabilities are unknown for the configured model.', messageKey: 'result.unknown_model_capabilities' };
  }
  if (!effort || !valid.includes(effort)) {
    const values = valid.join(', ');
    return { ok: false, error: 'invalid_effort', message: `effort must be one of: ${values}`, messageKey: 'result.invalid_effort', messageParams: { values } };
  }

  const { changed, previous, file, key } = await modelConfig.write(zylosDir, 'effort', effort);
  if (!changed) {
    log(reqId, `no-op: ${file}: ${key} already "${effort}"`);
    return { ok: false, error: 'already_set', message: `Effort already set to ${effort}`, messageKey: 'result.already_set_effort', messageParams: { value: effort } };
  }
  log(reqId, `write ${file}: ${key} "${previous ?? '(unset)'}" → "${effort}"`);
  return { ok: true, message: `Effort changed to ${effort}.`, previous, requires_restart: body.runtime === undefined, runtime, messageKey: 'result.effort_changed', messageParams: { value: effort, runtime } };
}

async function upgradeRuntimeCli(reqId, runtime, zylosDir) {
  const rt = await findRuntime(runtime);
  if (!rt || rt.install.upgradeCli === UNSUPPORTED) {
    return { ok: false, error: 'runtime_unsupported', message: `CLI upgrade is not supported for runtime: ${runtime}`,
      messageKey: 'result.runtime_upgrade_unsupported', messageParams: { runtime } };
  }
  const name = runtimeDisplayName(runtime);
  log(reqId, `exec: ${runtime} update`);
  let executionError;
  const result = await rt.install.upgradeCli({
    root: zylosDir,
    execFile: async (...args) => {
      try { return await execFileAsync(...args); }
      catch (err) {
        executionError = err.stderr || err.stdout || err.message;
        throw err;
      }
    },
  });
  if (result.outcome === 'updated') {
    log(reqId, `${runtime} update done (${result.output.slice(0, 200)})`);
    return { ok: true, message: `${name} updated. Restart session to apply.`, output: result.output,
      requires_restart: true, messageKey: 'result.runtime_updated', messageParams: { runtime: name } };
  }
  log(reqId, `${runtime} update failed: ${String(executionError || result.error || '').slice(0, 200)}`);
  if (result.outcome === 'timeout') {
    const minutes = result.timeoutMs / 60000;
    return { ok: false, error: 'deadline_exceeded',
      message: `${name} upgrade did not complete within ${minutes} minutes. Check the installed version before retrying.`,
      messageKey: 'result.runtime_upgrade_incomplete', messageParams: { runtime: name, minutes } };
  }
  return { ok: false, error: 'upgrade_failed', message: result.error,
    messageKey: 'result.upgrade_failed', messageParams: { error: result.error } };
}

async function setThreshold(reqId, body, config, zylosDir) {
  if (!SUPPORTED_RUNTIMES.includes(body?.runtime)) return { ok: false, error: 'INVALID_RUNTIME' };
  if (typeof body?.model !== 'string' || !body.model.trim()) return { ok: false, error: 'invalid_model', messageKey: 'result.invalid_model' };
  const value = typeof body.value === 'number' || (typeof body.value === 'string' && /^\d+$/.test(body.value.trim())) ? Number(body.value) : NaN;
  const limit = thresholdLimit({ runtime: body.runtime, context: thresholdContexts[body.runtime] });
  if (body.value === '' || !Number.isInteger(value) || value < 10 || value > limit) {
    return { ok: false, error: 'invalid_value', message: `Threshold must be between 10 and ${limit}`, messageKey: 'result.invalid_threshold', messageParams: { max: limit } };
  }
  try {
    await setModelThreshold({ runtime: body.runtime, model: body.model, value, zylosDir });
    log(reqId, `threshold set: ${body.runtime}/${body.model} ${value}%`);
    return { ok: true, runtime: body.runtime, model: body.model, value, message: `Rotation threshold set to ${value}%`, messageKey: 'result.threshold_set', messageParams: { value } };
  } catch (err) {
    return { ok: false, error: 'set_failed', message: err.message, messageKey: 'result.set_failed', messageParams: { error: err.message } };
  }
}

async function setSessionHotTtl(reqId, body, zylosDir) {
  const configFile = path.join(zylosDir, '.zylos/config.json');
  const current = readConfigStrict(configFile);
  if (current.state === 'error') throw configUnreadable(current.error);
  const effective = resolveSessionHotTtl(current.state === 'ok' ? current.config : {});
  if (effective.environment_set) {
    return { ok: false, error: 'environment_override', messageKey: 'result.hot_ttl_environment' };
  }
  if (effective.read_only) {
    return { ok: false, error: 'multi_session_required', messageKey: 'result.hot_ttl_multi_only' };
  }
  const minutes = typeof body?.minutes === 'number'
    || (typeof body?.minutes === 'string' && /^\d+$/.test(body.minutes.trim())) ? Number(body.minutes) : NaN;
  if (!Number.isSafeInteger(minutes) || minutes < HOT_TTL_MIN_MINUTES || minutes > HOT_TTL_MAX_MINUTES) {
    return { ok: false, error: 'invalid_value', messageKey: 'result.invalid_hot_ttl',
      messageParams: { min: HOT_TTL_MIN_MINUTES, max: HOT_TTL_MAX_MINUTES } };
  }
  try {
    const seconds = minutes * 60;
    updateConfigWithLock({ configFile, lockFile: `${configFile}.lock`, update: { set: { session_hot_ttl_seconds: seconds } } });
    log(reqId, `session hot TTL set: ${seconds}s`);
    return { ok: true, seconds, minutes, messageKey: 'result.hot_ttl_set', messageParams: { minutes } };
  } catch (err) {
    return { ok: false, error: 'set_failed', message: err.message, messageKey: 'result.set_failed', messageParams: { error: err.message } };
  }
}

/** Save one runtime's dream model or effort (`null` restores its default); Core validates and builds the update. */
function setDreamSetting(reqId, kind, body, zylosDir) {
  const runtime = CORE_RUNTIMES.get(body?.runtime);
  if (!runtime) return { ok: false, error: 'INVALID_RUNTIME' };
  if (!Object.hasOwn(body, kind)) return { ok: false, error: 'invalid_' + kind, messageKey: 'result.invalid_' + kind };
  let update;
  try { update = dreamSettingUpdate(runtime, kind, body[kind]); }
  catch (err) {
    if (!err.code?.startsWith('invalid_')) throw err;
    const values = err.efforts?.join(', ') ?? '';
    return { ok: false, error: err.code, message: err.message, messageKey: 'result.' + err.code, messageParams: { values } };
  }
  const configFile = path.join(zylosDir, '.zylos/config.json');
  try {
    updateConfigWithLock({ configFile, lockFile: `${configFile}.lock`, update });
  } catch (err) {
    return { ok: false, error: 'set_failed', message: err.message, messageKey: 'result.set_failed', messageParams: { error: err.message } };
  }
  const current = readConfigStrict(configFile);
  const dream = dreamApiSettings(current.state === 'ok' ? current.config : {}, runtime);
  log(reqId, `dream ${kind} for ${runtime.id}: ${dream[kind] ?? '(default)'}`);
  return { ok: true, runtime: runtime.id, dream, messageKey: 'result.dream_saved' };
}

function dreamApiSettings(config, runtime) {
  const settings = dreamSettings(config, runtime);
  return { model: settings.configured.model, effort: settings.configured.effort,
    default_model: settings.defaults.model, default_effort: settings.defaults.effort, efforts: settings.efforts };
}

export function getActionsMeta(config) {
  const runtime = config.runtime || process.env.ZYLOS_RUNTIME || DEFAULT_RUNTIME;
  const zylosDir = config.zylosDir || path.join(os.homedir(), 'zylos');
  const catalog = MODEL_RUNTIMES.get(runtime)?.catalog;
  const { model, effort: currentEffort } = instanceDefaults(runtime, zylosDir);
  const currentModel = model || null;
  const models = catalog?.models() ?? [];
  if (catalog?.strict && currentModel && !models.some(model => model.id === currentModel)) {
    models.push({ id: currentModel, display_name: currentModel });
  }
  const efforts_by_model = Object.fromEntries(models.map(({ id }) => [id, catalog.effortsFor(id) ?? []]));
  if (catalog && catalog.defaultEfforts !== UNSUPPORTED) {
    efforts_by_model['*'] = [...catalog.defaultEfforts];
  }

  const windows = readModelWindows({ contexts: thresholdContexts });
  const thresholdModels = [...new Set([...models.map(item => item.id), currentModel, config.thresholdModel].filter(Boolean))];
  const options = model => ({ runtime, context: thresholdContexts[runtime], model, defaultModel: currentModel, modelWindows: windows });
  const model_thresholds = Object.fromEntries(thresholdModels.map(model => [model, modelThreshold(config, options(model))]));
  const model_threshold_max = Object.fromEntries(thresholdModels.map(model => [model, thresholdLimit(options(model))]));
  const newSessionThreshold = modelThreshold(config, options(currentModel));

  return {
    runtime,
    current_model: currentModel,
    current_effort: currentEffort,
    models,
    efforts_by_model,
    model_thresholds,
    model_threshold_max,
    new_session_threshold: newSessionThreshold,
    session_hot_ttl: resolveSessionHotTtl(config),
    catalog_strict: catalog?.strict ?? null,
    dream: CORE_RUNTIMES.has(runtime) ? dreamApiSettings(config, CORE_RUNTIMES.get(runtime)) : null,
  };
}

export function instanceDefaults(runtime, zylosDir) {
  return MODEL_RUNTIMES.get(runtime)?.config.read(zylosDir) ?? { model: null, effort: null };
}
