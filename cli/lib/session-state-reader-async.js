import path from 'node:path';
import { openReadStore } from './c4-read-store.js';
import { zylosRoot } from './session-group-paths.js';
import { groupRunDir, tmuxNameForGroup } from './session-group-paths.js';
import { openTmuxConnection } from './runtime/tmux-connection.js';
import { isIdentityError, tmuxError } from './runtime/tmux-protocol.js';
import { observeSessionTarget } from './runtime/session-target.js';
import { observeSessionTargets } from './runtime/session-batch-observation.js';
import { readJsonSample, readCodexSampleForIdentity, sampleResult, sameIdentity } from './session-usage-reader.js';
import { readRecordedAccountUsage } from './recorded-account-usage.js';

const publicIdentity = value => Object.fromEntries(['present','tmuxName','runId','createdAt','runtime','launchConfig','ready','sessionId'].map(key => [key, value[key]]));
const absent = group => ({ present: false, tmuxName: tmuxNameForGroup(group ?? 'origin'), runId: null, createdAt: null,
  runtime: 'unknown', launchConfig: null, ready: false, sessionId: null });

/** Each read owns a bounded executor; repeated samples keep its pinned identity.
 * Internal dependency injection is for isolated tests; production uses real providers. */
export function createSessionReader({ open = openTmuxConnection, observe = observeSessionTarget, env = process.env,
  now = Date.now, connectionOptions = {}, resolveConfig,
  observeAll = observeSessionTargets, readReady, readProcessTree } = {}) {
  const batchReady = readReady ?? (async group => {
    const sample = readJsonSample(path.join(groupRunDir(group ?? 'origin', env), 'current-session.json'), 'status');
    return sample.error ? null : sample.value;
  });
  async function readSessionTargets(groups, options = {}) {
    const connection = await open(connectionOptions);
    try {
      const all = await observeAll({ connection, readReady:batchReady, readProcessTree, ...options });
      if (groups === undefined) return all;
      return new Map(groups.map(group => [group, all.get(group ?? 'origin') ?? absent(group)]));
    } finally { await connection.close(); }
  }
  async function readLiveIdentities(groups) {
    return new Map([...await readSessionTargets(groups)].map(([group, target]) => [group, publicIdentity(target)]));
  }
  // Optional caller sampling is awaited between the two shared observations;
  // observationError invalidates its result when the captured target changes.
  async function readSessionStates(groups = [], { freshnessMs, usageFreshnessMs = freshnessMs, includeAllLive = false, sampleTarget } = {}) {
    if (!Number.isFinite(freshnessMs) || freshnessMs < 0) throw new TypeError('freshnessMs must be a nonnegative number');
    if (typeof usageFreshnessMs !== 'number' || Number.isNaN(usageFreshnessMs) || usageFreshnessMs < 0) {
      throw new TypeError('usageFreshnessMs must be a nonnegative number');
    }
    const connection = await open(connectionOptions);
    try {
      const read = () => observeAll({ connection, readReady:batchReady, readProcessTree });
      const first = await read();
      const wanted = new Set([...groups, ...(includeAllLive ? first.keys() : [])]);
      const samples = new Map(await Promise.all([...wanted].map(async group => {
        const target = first.get(group ?? 'origin') ?? absent(group);
        const dir = groupRunDir(group ?? 'origin', env);
        const status = readJsonSample(path.join(dir, 'agent-status.json'), 'status');
        let usage = { error:'missing', sampledAt:null };
        if (target.runtime === 'claude') usage = readJsonSample(path.join(dir, 'statusline.json'), 'usage');
        if (target.runtime === 'codex') {
          const found = readCodexSampleForIdentity({ sessionGroup:group, identity:target, env });
          if (found) usage = { value:found.sample, sampledAt:found.sample.capturedAt, identity:found.sample.identity };
        }
        return [group, { target, status, usage, sampled:await sampleTarget?.(group, target) }];
      })));
      let last;
      try { last = await read(); }
      catch (error) { if (!isIdentityError(error) && error.code !== 'TMUX_NO_SERVER') throw error; last = new Map(); }
      return new Map([...samples].map(([group, sample]) => {
        const { target, status, usage } = sample;
        const final = last.get(group ?? 'origin') ?? absent(group);
        const stable = target.present && final.present && ['runId','serverGeneration','tmuxSessionId','paneId','runtime','createdAt','sessionId'].every(key => target[key] === final[key]);
        return [group, { identity:publicIdentity(target),
          target:stable ? target : { ...target, ready:false, runtime:'unknown', runtimeObservation:'unavailable', runtimePid:undefined },
          ...(sampleTarget ? { sampled:sample.sampled } : {}),
          ...(target.present && !stable ? { observationError:tmuxError('TARGET_GONE', 'Batch target changed during observation') } : {}),
          status:sampleResult(status, target, final, freshnessMs, now()),
          usage:sampleResult(usage, target, final, usageFreshnessMs, now()) }];
      }));
    } finally { await connection.close(); }
  }
  async function withConnection(group, operation) {
    const connection = await open(connectionOptions);
    const read = () => observe({ sessionGroup: group, connection });
    try { return await operation(read); }
    finally { await connection.close(); }
  }
  async function readLiveIdentity(group) { return withConnection(group, async read => publicIdentity(await read())); }
  /** usageFreshnessMs bounds the usage sample's age separately (default: freshnessMs). The runtime writes that sample
   * only after the session's own requests, so an idle session's last one is still its current usage. */
  async function readSessionState(group, { freshnessMs, usageFreshnessMs = freshnessMs } = {}) {
    if (!Number.isFinite(freshnessMs) || freshnessMs < 0) throw new TypeError('freshnessMs must be a nonnegative number');
    if (typeof usageFreshnessMs !== 'number' || Number.isNaN(usageFreshnessMs) || usageFreshnessMs < 0) {
      throw new TypeError('usageFreshnessMs must be a nonnegative number');
    }
    return withConnection(group, async read => {
      const first = await read();
      const dir = groupRunDir(group ?? 'origin', env);
      const status = readJsonSample(path.join(dir, 'agent-status.json'), 'status');
      let usage = { error: 'missing', sampledAt: null };
      if (first.runtime === 'claude') usage = readJsonSample(path.join(dir, 'statusline.json'), 'usage');
      if (first.runtime === 'codex') {
        const found = readCodexSampleForIdentity({ sessionGroup: group, identity: first, env });
        if (found) usage = { value: found.sample, sampledAt: found.sample.capturedAt, identity: found.sample.identity };
      }
      let last;
      try { last = await read(); }
      catch (error) {
        if (!isIdentityError(error) && error.code !== 'TMUX_NO_SERVER') throw error;
        last = absent(group);
      }
      return { identity: publicIdentity(first), status: sampleResult(status, first, last, freshnessMs, now()),
        usage: sampleResult(usage, first, last, usageFreshnessMs, now()) };
    });
  }
  async function readCodexUsageSample({ sessionGroup }) {
    return withConnection(sessionGroup, async read => {
      const first = await read();
      const found = readCodexSampleForIdentity({ sessionGroup, identity: first, env });
      const last = await read();
      return sameIdentity(first, last) ? found?.sample ?? null : null;
    });
  }
  async function resolveTargetRuntime(sessionGroup) {
    const live = await readLiveIdentity(sessionGroup);
    if (live.present) return live.runtime;
    if (!resolveConfig && sessionGroup !== null) {
      const { store, close } = await openReadStore(zylosRoot(env));
      try { return store.resolveSessionLaunchConfig({ sessionGroup, sessionMode: 'multi' }).runtime; }
      finally { close(); }
    }
    const resolve = resolveConfig || (await import('../../skills/comm-bridge/scripts/c4-db.js')).resolveSessionLaunchConfig;
    if (typeof resolve !== 'function') throw Object.assign(new Error('Session launch configuration resolver is unavailable'), { code: 'DEPENDENCY_UNAVAILABLE' });
    return (await resolve({ sessionGroup, sessionMode: sessionGroup === null ? 'single' : 'multi' })).runtime;
  }
  async function readAccountSamples(runtime) {
    if (!['claude','codex'].includes(runtime)) throw new TypeError('Unknown runtime');
    const samples = [];
    const connection = await open(connectionOptions);
    try {
      const read = () => observeAll({ connection, readReady:batchReady, readProcessTree });
      const first = await read();
      const candidates = [];
      for (const [sessionGroup, identity] of first) {
        if (!identity.ready || identity.runtime !== runtime) continue;
        const sample = runtime === 'claude' ? readJsonSample(path.join(groupRunDir(sessionGroup, env), 'statusline.json'), 'usage') :
          readCodexSampleForIdentity({ sessionGroup, identity, env, account:true });
        candidates.push({ sessionGroup, identity, sample });
      }
      if (!candidates.length) return samples;
      const last = await read();
      for (const { sessionGroup, identity, sample } of candidates) {
        if (!sameIdentity(identity, last.get(sessionGroup))) continue;
        if (runtime === 'codex') {
          if (sample?.sample.rateLimits) samples.push({ value:sample.sample.rateLimits, mtime:sample.mtime, recordedAt:sample.sample.capturedAt });
        } else if (!sample.error && sample.identity.runId === identity.runId && sample.identity.sessionId === identity.sessionId && sample.value.rate_limits) {
          samples.push({ value:sample.value.rate_limits, mtime:sample.mtime, recordedAt:sample.sampledAt ?? sample.mtime });
        }
      }
    } finally { await connection.close(); }
    samples.sort((a, b) => b.mtime - a.mtime);
    return samples;
  }
  async function readAccountUsage(runtime, options) {
    const samples = await readAccountSamples(runtime);
    if (!options?.allowRecorded) return samples[0]?.value ?? null;
    return readRecordedAccountUsage(runtime, env, now(), samples);
  }
  /** Dashboard shares one identity-validated scan for both selection policies. */
  async function readAccountUsageSnapshot(runtime) {
    const samples = await readAccountSamples(runtime);
    return { live: samples[0]?.value ?? null,
      recorded: readRecordedAccountUsage(runtime, env, now(), samples) };
  }
  return { readLiveIdentity, readSessionState, readLiveIdentities, readSessionTargets, readSessionStates,
    resolveTargetRuntime, readCodexUsageSample, readAccountUsage, readAccountUsageSnapshot };
}
