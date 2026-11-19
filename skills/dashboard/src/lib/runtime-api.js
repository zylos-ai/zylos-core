import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getActionsMeta } from './actions.js';
import { sendJson } from './http.js';
import { isNewerVersion } from './version-utils.js';
import { loadCoreModule } from './core-modules.js';

const { SUPPORTED_RUNTIMES } = await loadCoreModule('runtime/descriptors.js');

export const DASHBOARD_RUNTIMES = SUPPORTED_RUNTIMES;

function runtimeOverrideSearchTerm(q) {
  const term = String(q ?? '').trim();
  return !term || term.length > 64 ? { none: true }
    : { term, keyable: /^[A-Za-z0-9_.:-]+$/.test(term) && !term.startsWith('--') };
}
export function createRuntimeOverridesReader({ zylosDir, displayNames, run = promisify(execFile), env = process.env }) {
  return async function runtimeOverridesPage(params) {
    const childEnv = { ...env, ZYLOS_DIR: zylosDir };
    delete childEnv.ZYLOS_SESSION_GROUP;
    async function read(args) {
      const { stdout } = await run('zylos', ['group', 'overrides', ...args, '--json'], {
        env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024,
      });
      const envelope = JSON.parse(stdout);
      const data = envelope?.data;
      if (envelope?.ok !== true || !Array.isArray(data?.runtime) ||
          data.runtime.some(row => !row || typeof row.sessionGroup !== 'string' || !DASHBOARD_RUNTIMES.includes(row.runtime)) ||
          (data.nextAfter != null && typeof data.nextAfter !== 'string')) throw Error('override_list_failed');
      return data;
    }
    const hasQuery = params.has('q');
    const term = hasQuery ? runtimeOverrideSearchTerm(params.get('q')) : null;
    if (term?.none) return { runtime: [], nextAfter: null };
    const after = params.get('after');
    const cursor = after === null ? [] : ['--after', after];
    const names = await displayNames.listAll();
    const named = row => ({ ...row, name: names.get(row.sessionGroup) ?? null });
    if (!hasQuery) {
      const page = await read(cursor);
      if (!Number.isInteger(page.runtimeTotal) || page.runtimeTotal < 0) throw Error('override_list_failed');
      return { runtimeTotal: page.runtimeTotal, runtime: page.runtime.map(named), nextAfter: page.nextAfter ?? null };
    }
    const hits = (await displayNames.search(term.term, 500)).map(row => row.sessionGroup);
    const hitKeys = new Set(hits);
    const nameRows = after === null && hits.length
      ? (await read(hits.flatMap(key => ['--group', key]))).runtime.sort((a, b) => a.sessionGroup < b.sessionGroup ? -1 : a.sessionGroup > b.sessionGroup ? 1 : 0) : [];
    const page = term.keyable ? await read(['--match', term.term, ...cursor]) : { runtime: [], nextAfter: null };
    return { runtime: [...nameRows, ...page.runtime.filter(row => !hitKeys.has(row.sessionGroup))].map(named),
      nextAfter: page.nextAfter ?? null };
  };
}

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
