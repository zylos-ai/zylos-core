import { accountUsageCache as sharedAccountUsageCache } from '../account-usage-cache.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../../../comm-bridge/scripts/core-config-loader.js';

let coreModules;
function loadCoreModules() {
  if (!coreModules) {
    coreModules = Promise.resolve().then(() => {
      const configUrl = resolveCoreConfigModule();
      return Promise.all([
        import(pathToFileURL(configUrl).href),
        import(pathToFileURL(path.join(path.dirname(configUrl), 'session-state-reader.js')).href),
      ]);
    }).catch(error => {
      setTimeout(() => { coreModules = null; }, 60000).unref();
      throw error;
    });
  }
  return coreModules;
}
async function readCoreUsage(accountUsageCache) {
  const [{ readSessionMode }, reader] = await loadCoreModules();
  const { readSessionState, resolveTargetRuntime } = reader;
  const mode = readSessionMode().mode;
  const observation = await readSessionState(mode === 'multi' ? 'origin' : null, { freshnessMs: 5000 });
  let runtime = observation.identity.runtime;
  if (mode === 'multi') { try { runtime = await resolveTargetRuntime('origin'); } catch { runtime = null; } }
  let accountUsage = null;
  if (['claude', 'codex'].includes(runtime)) {
    try { accountUsage = { runtime, value: await accountUsageCache.read(runtime, undefined, reader) }; }
    catch { /* Missing account evidence never falls back to Origin's sample. */ }
  }
  return { ...observation, accountUsage };
}

export class StatuslineCollector {
  constructor(store, config, { read, accountUsageCache = sharedAccountUsageCache } = {}) {
    this.store = store;
    this.config = config;
    this._watcher = null;
    this._lastHash = null;
    this._read = read ?? (() => readCoreUsage(accountUsageCache));
    this._health = new Map();
    this._pending = null;
    this._runtimeInfo = null;
    this._accountUsage = null;
  }

  collect() {
    if (!this._pending) this._pending = this._collect().finally(() => { this._pending = null; });
    return this._pending;
  }

  async _collect() {
    const now = new Date().toISOString();
    let observation;
    try { observation = await this._read(); }
    catch { observation = { usage: { valid: false, reason: 'read_failed' } }; }
    const { identity, usage } = observation;
    this._accountUsage = observation.accountUsage ?? null;
    if (!usage?.valid) {
      this._runtimeInfo = null;
      this._upsertHealth('collector_liveness', 'stale', {
        reason: usage?.reason || 'identity_missing', last_check: now
      });
      return { written: 0 };
    }
    const data = usage.value;
    this._runtimeInfo = identity.runtime === 'claude' ? {
      model: data.model?.display_name || data.model?.id || null,
      model_id: data.model?.id || null,
      effort: data.effort?.level || null,
      cc_version: data.version || null
    } : null;
    const hash = JSON.stringify([identity.runtime, identity.runId, identity.sessionId, usage.sampledAt, data]);
    if (hash === this._lastHash) {
      this._upsertHealth('collector_liveness', 'healthy', {
        last_success: now, metrics_written: 0
      }, hash);
      return { written: 0 };
    }
    this._lastHash = hash;
    const sessionId = identity.sessionId;
    let written = 0;
    const dims = { run_id: identity.runId };
    if (identity.runtime === 'codex') {
      if (data.contextUsage?.ceiling > 0 && Number.isFinite(data.contextUsage.used)) {
        dims.context_pct = data.contextUsage.used / data.contextUsage.ceiling * 100;
      }
    }

    if (data.context_window?.used_percentage != null) {
      dims.context_pct = data.context_window.used_percentage;
    }

    if (data.cost?.total_cost_usd != null) {
      dims.session_cost = data.cost.total_cost_usd;
    }

    const cw = data.context_window?.current_usage;
    if (cw && cw.cache_read_input_tokens != null) {
      const totalIn = (cw.input_tokens || 0) + (cw.cache_creation_input_tokens || 0) + (cw.cache_read_input_tokens || 0);
      if (totalIn > 0) {
        dims.cache_hit_rate = cw.cache_read_input_tokens / totalIn;
        dims.input = cw.input_tokens || 0;
        dims.cache_read = cw.cache_read_input_tokens || 0;
        dims.cache_creation = cw.cache_creation_input_tokens || 0;
      }
    }

    if (Object.keys(dims).length > 1) {
      this.store.insertMetric({
        timestamp: new Date(usage.sampledAt).toISOString(),
        runtime: identity.runtime,
        session_id: sessionId,
        metric_name: 'statusline_summary',
        metric_value: 0,
        dimensions: dims,
        source: 'statusline',
        confidence: 'actual'
      });
      written++;
    }

    if (written > 0) {
      this._upsertHealth('collector_liveness', 'healthy', {
        last_success: now, metrics_written: written
      }, hash);
      this._upsertHealth('runtime_progress', 'healthy', {
        last_success: now,
        runtime: identity.runtime
      }, hash);
    }

    return { written, data };
  }

  _upsertHealth(signal, status, extra, evidence = null) {
    // Clock ticks and metric counters do not change the source's health.
    const { last_check, last_success, metrics_written, ...details } = extra;
    const signature = JSON.stringify([status, details, evidence]);
    // Skipping last_success writes relies on usage freshness <= the platform's
    // 30s health expiry: the current 5s sample window turns stale and writes first.
    if (this._health.get(signal) === signature) return;
    this.store.upsertSourceHealth('statusline', signal, status, extra);
    this._health.set(signal, signature);
  }

  start() {
    clearInterval(this._watcher);
    // The Core reader revalidates identity on every observation. Polling also
    // follows mode/runtime changes without watching a previous run's directory.
    this._watcher = setInterval(() => this.collect().catch(() => {}), 2000);
    this._watcher.unref?.();
  }

  getAccountUsage() {
    return this._accountUsage;
  }

  getRuntimeInfo() {
    return this._runtimeInfo;
  }

  async stop() {
    clearInterval(this._watcher);
    this._watcher = null;
    await this._pending;
  }
}
