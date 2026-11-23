import { getActionsMeta } from './actions.js';
import { sendJson } from './http.js';
import { isNewerVersion } from './version-utils.js';
import { loadCoreModule } from './core-modules.js';

const { SUPPORTED_RUNTIMES } = await loadCoreModule('runtime/descriptors.js');

export const DASHBOARD_RUNTIMES = SUPPORTED_RUNTIMES;

export function runtimeVersionRecord(runtime, { installed = {}, latest = {}, unsupported = [] } = {}) {
  const current = installed[runtime] ?? null;
  if (unsupported.includes(runtime)) {
    return { installed: current, latest: null, update: null, update_check: 'unsupported' };
  }
  const available = latest[runtime] ?? null;
  return { installed: current, latest: available,
    update: current && available && isNewerVersion(available, current) ? available : null };
}

export function runtimeDefaults(zylosConfig) {
  return Object.fromEntries(DASHBOARD_RUNTIMES.map(runtime => {
    const meta = getActionsMeta({ ...zylosConfig, runtime });
    return [runtime, { model: meta.current_model, effort: meta.current_effort,
      threshold: meta.new_session_threshold, model_thresholds: meta.model_thresholds,
      session_hot_ttl: meta.session_hot_ttl }];
  }));
}

export function handleRuntimeOptions(url, res, { activeRuntime, zylosConfig, zylosVersion, installedVersions }) {
  const runtime = url.searchParams.get('runtime') ?? activeRuntime;
  if (!DASHBOARD_RUNTIMES.includes(runtime)) {
    sendJson(res, 400, { error: 'INVALID_RUNTIME' }); return;
  }
  const meta = getActionsMeta({ ...zylosConfig, runtime, thresholdModel: url.searchParams.get('model') });
  sendJson(res, 200, { ...meta, zylos_version: zylosVersion, runtime_cli: runtime,
    cc_version: installedVersions[runtime] ?? null });
}
