import { loadCoreModule as defaultLoadCoreModule } from './core-modules.js';

const { runtimesWith } = await defaultLoadCoreModule('runtime/descriptors.js');

/** One identity-validated batch shared by Origin, fleet and account projections.
 * This provider owns no timers: only an explicit observer can initiate tmux IO. */
export function createSessionObservations({ loadCoreModule = defaultLoadCoreModule,
  zylosDir = process.env.ZYLOS_DIR || process.cwd(), now = Date.now, ttlMs = 2000 } = {}) {
  let cache = null, pending = null;
  const env = { ...process.env, ZYLOS_DIR: zylosDir };
  async function accountSnapshot(runtime) {
    if (!runtimesWith('accountQuota').includes(runtime)) throw new TypeError('Unknown runtime');
    const { readRecordedAccountUsage } = await loadCoreModule('recorded-account-usage.js');
    const samples = [...(cache?.observations.values() ?? [])]
      .filter(item => item.identity.present && item.identity.ready && item.identity.runtime === runtime &&
        !item.observationError && item.status.reason !== 'identity_changed' && item.sampled)
      .map(item => item.sampled).sort((a, b) => b.mtime - a.mtime);
    return { live: samples[0]?.value ?? null, recorded: await readRecordedAccountUsage(runtime, env, now(), samples) };
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
    const [config, sessions, { getRuntime }] = await Promise.all([
      loadCoreModule('config.js'), loadCoreModule('session-state-reader.js'),
      defaultLoadCoreModule('runtime/index.js'),
    ]);
    const quotas = new Map(await Promise.all(runtimesWith('accountQuota').map(async id =>
      [id, (await getRuntime(id)).usage.accountQuota])));
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
        return quotas.get(identity.runtime)?.readLiveSample({ sessionGroup, identity, env }) ?? null;
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
  /** Whether Origin is running, from the shared batch's Origin entry (the null
   * group in single, `origin` in multi); null when that cannot be established. */
  async function originPresence() {
    const { group, observations } = await get();
    const present = observations.get(group)?.identity?.present;
    return typeof present === 'boolean' ? present : null;
  }
  return { get, peek: () => cache, reader, resolveOfflineRuntime, originPresence, invalidate: () => { cache = null; } };
}
