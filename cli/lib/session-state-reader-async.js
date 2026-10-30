import path from 'node:path';
import { groupRunDir, tmuxNameForGroup, listGroupTmuxSessions } from './session-group-paths.js';
import { openTmuxConnection } from './runtime/tmux-connection.js';
import { isIdentityError } from './runtime/tmux-protocol.js';
import { observeSessionTarget } from './runtime/session-target.js';
import { readJsonSample, readCodexSampleForIdentity, sampleResult, sameIdentity } from './session-usage-reader.js';

const publicIdentity = value => Object.fromEntries(['present','tmuxName','runId','createdAt','runtime','launchConfig','ready','sessionId'].map(key => [key, value[key]]));
const absent = group => ({ present: false, tmuxName: tmuxNameForGroup(group ?? 'origin'), runId: null, createdAt: null,
  runtime: 'unknown', launchConfig: null, ready: false, sessionId: null });

/** Each read owns a bounded executor; repeated samples keep its pinned identity.
 * Internal dependency injection is for isolated tests; production uses real providers. */
export function createSessionReader({ open = openTmuxConnection, observe = observeSessionTarget, env = process.env,
  now = Date.now, connectionOptions = {}, resolveConfig, listSessions = listGroupTmuxSessions } = {}) {
  async function withConnection(group, operation) {
    let connection;
    try { connection = await open(connectionOptions); }
    catch (error) { if (error.code !== 'TMUX_NO_SERVER') throw error; }
    const read = () => connection ? observe({ sessionGroup: group, connection }) : Promise.resolve(absent(group));
    try { return await operation(read); }
    finally { if (connection) await connection.close(); }
  }
  async function readLiveIdentity(group) { return withConnection(group, async read => publicIdentity(await read())); }
  async function readSessionState(group, { freshnessMs } = {}) {
    if (!Number.isFinite(freshnessMs) || freshnessMs < 0) throw new TypeError('freshnessMs must be a nonnegative number');
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
        usage: sampleResult(usage, first, last, freshnessMs, now()) };
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
    const resolve = resolveConfig || (await import('../../skills/comm-bridge/scripts/c4-db.js')).resolveSessionLaunchConfig;
    if (typeof resolve !== 'function') throw Object.assign(new Error('Session launch configuration resolver is unavailable'), { code: 'DEPENDENCY_UNAVAILABLE' });
    return (await resolve({ sessionGroup, sessionMode: sessionGroup === null ? 'single' : 'multi' })).runtime;
  }
  async function readAccountUsage(runtime) {
    if (!['claude','codex'].includes(runtime)) throw new TypeError('Unknown runtime');
    const samples = [];
    for (const { sessionGroup } of await listSessions(connectionOptions)) {
      const candidate = await withConnection(sessionGroup, async read => {
        const first = await read();
        if (!first.ready || first.runtime !== runtime) return null;
        const sample = runtime === 'claude' ? readJsonSample(path.join(groupRunDir(sessionGroup, env), 'statusline.json'), 'usage') :
          readCodexSampleForIdentity({ sessionGroup, identity: first, env, account: true });
        const last = await read();
        if (!sameIdentity(first, last)) return null;
        if (runtime === 'codex') return sample?.sample.rateLimits ? { value: sample.sample.rateLimits, mtime: sample.mtime } : null;
        if (sample.error || sample.identity.runId !== first.runId || sample.identity.sessionId !== first.sessionId) return null;
        return sample.value.rate_limits ? { value: sample.value.rate_limits, mtime: sample.mtime } : null;
      });
      if (candidate) samples.push(candidate);
    }
    samples.sort((a, b) => b.mtime - a.mtime);
    return samples[0]?.value ?? null;
  }
  return { readLiveIdentity, readSessionState, resolveTargetRuntime, readCodexUsageSample, readAccountUsage };
}
