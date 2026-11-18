import path from 'node:path';
import { loadCoreModule as defaultLoadCoreModule } from './core-modules.js';

/** One identity-validated batch shared by Origin, fleet and account projections.
 * This provider owns no timers: only an explicit observer can initiate tmux IO. */
export function createSessionObservations({ loadCoreModule = defaultLoadCoreModule,
  zylosDir = process.env.ZYLOS_DIR || process.cwd(), now = Date.now, ttlMs = 2000 } = {}) {
  let cache = null, pending = null;
  const env = { ...process.env, ZYLOS_DIR: zylosDir };
  async function accountSnapshot(runtime) {
    if (!['claude', 'codex'].includes(runtime)) throw new TypeError('Unknown runtime');
    const { readRecordedAccountUsage } = await loadCoreModule('recorded-account-usage.js');
    const samples = [...(cache?.observations.values() ?? [])]
      .filter(item => item.identity.present && item.identity.ready && item.identity.runtime === runtime &&
        !item.observationError && item.status.reason !== 'identity_changed' && item.sampled)
      .map(item => item.sampled).sort((a, b) => b.mtime - a.mtime);
    return { live: samples[0]?.value ?? null, recorded: readRecordedAccountUsage(runtime, env, now(), samples) };
  }
  // Stable function identities let the shared account cache retain its cadence.
  const reader = {
    readAccountUsageSnapshot: accountSnapshot,
    async readAccountUsage(runtime, options) {
      const value = await accountSnapshot(runtime);
      return options?.allowRecorded ? value.recorded : value.live;
    },
    async readRuntimeHealth(runtime) {
      return (await loadCoreModule('session-state-reader.js')).readRuntimeHealth(runtime);
    },
  };
  async function build() {
    const [config, sessions, usage, paths] = await Promise.all([
      loadCoreModule('config.js'), loadCoreModule('session-state-reader.js'),
      loadCoreModule('session-usage-reader.js'), loadCoreModule('session-group-paths.js'),
    ]);
    // mode stays the effective mode (no key = single) for existing readers; sessionMode is the raw value.
    const sessionMode = config.readSessionMode().mode;
    const mode = sessionMode ?? 'single';
    const group = mode === 'multi' ? 'origin' : null;
    // Native single runs only Origin, so its live session is read; an instance without the key
    // still runs its one null-group session. Single-mode readers keep it under the null key.
    const read = mode === 'single' && sessionMode !== null ? 'origin' : group;
    const observed = await sessions.readSessionStates([read], {
      freshnessMs: 5000, usageFreshnessMs: Infinity, includeAllLive: mode === 'multi',
      sampleTarget(sessionGroup, identity) {
        if (!identity.present || !identity.ready) return null;
        if (identity.runtime === 'codex') {
          const found = usage.readCodexSampleForIdentity({ sessionGroup, identity, env, account: true });
          return found?.sample.rateLimits ? { value: found.sample.rateLimits, mtime: found.mtime,
            recordedAt: found.sample.capturedAt } : null;
        }
        if (identity.runtime !== 'claude') return null;
        const sample = usage.readJsonSample(path.join(paths.groupRunDir(sessionGroup ?? 'origin', env), 'statusline.json'), 'usage');
        if (sample.error || sample.identity.runId !== identity.runId || sample.identity.sessionId !== identity.sessionId || !sample.value.rate_limits) return null;
        return { value: sample.value.rate_limits, mtime: sample.mtime, recordedAt: sample.sampledAt ?? sample.mtime };
      },
    });
    const observations = read === group ? observed : new Map([[group, observed.get(read)]]);
    const value = { mode, sessionMode, group, observations, reader, sampledAt: now() };
    cache = value;
    return value;
  }
  async function get({ fresh = false } = {}) {
    if (pending) {
      if (!fresh) return pending;
      await pending;
      return get({ fresh: true });
    }
    if (!fresh && cache && now() - cache.sampledAt < ttlMs) return cache;
    pending = build();
    try { return await pending; }
    catch (error) { cache = null; throw error; }
    finally { pending = null; }
  }
  async function resolveOfflineRuntime(sessionGroup) {
    const { openReadStore } = await loadCoreModule('c4-read-store.js');
    const { store, close } = await openReadStore(zylosDir);
    try { return store.resolveSessionLaunchConfig({ sessionGroup, sessionMode: sessionGroup === null ? 'single' : 'multi' }).runtime; }
    finally { close(); }
  }
  return { get, peek: () => cache, reader, resolveOfflineRuntime, invalidate: () => { cache = null; } };
}
