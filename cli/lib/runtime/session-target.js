import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { groupRunDir, tmuxNameForGroup } from '../session-group-paths.js';
import { tmuxError } from './tmux-connection.js';

const exec = promisify(execFile);
const bindings = new WeakMap();
const known = new Set(['claude', 'codex']);
const missing = error => error.code === 'TMUX_COMMAND_FAILED' && /can't find|no such|no current|session not found/i.test(error.message);

function validReady(value) {
  return value && typeof value.runId === 'string' && value.runId && typeof value.sessionId === 'string' && value.sessionId &&
    Number.isInteger(value.ts) && Array.isArray(value.startupControlIds) && value.startupControlIds.every(Number.isInteger);
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export async function readReadyIdentity(sessionGroup) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(groupRunDir(sessionGroup ?? 'origin'), 'current-session.json'), 'utf8'));
    return validReady(value) ? value : null;
  } catch { return null; }
}

/** Snapshot only names and parent relationships; never reads process credentials. */
export async function readProcessTree() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match && { pid: Number(match[1]), ppid: Number(match[2]), name: path.basename(match[3]) };
  }).filter(Boolean);
  if (process.platform === 'linux') {
    await Promise.all(rows.map(async row => {
      try { row.name = (await fs.readFile(`/proc/${row.pid}/comm`, 'utf8')).trim(); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') row.gone = true; else throw error; }
    }));
  }
  return rows.filter(row => !row.gone);
}

export async function readTargetRuntime({ connection, paneId, rawF2, readProcessTree: getTree = readProcessTree }) {
  let launchConfig = null;
  try {
    const parsed = JSON.parse(rawF2?.ZYLOS_MODEL_CONFIG);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) launchConfig = parsed;
  } catch { /* Missing or malformed F2 is deliberately not a default config. */ }
  if (known.has(launchConfig?.runtime)) return { runtime: launchConfig.runtime, launchConfig, runtimeObservation: 'configured' };
  let runtime = 'unknown', runtimeObservation = 'unavailable';
  try {
    const pid = Number((await connection.command(['display-message', '-p', '-t', paneId, '#{pane_pid}'])).trim());
    const rows = await getTree();
    let layer = rows.filter(row => row.pid === pid);
    const seen = new Set();
    if (Number.isInteger(pid) && pid > 0 && layer.length) runtimeObservation = 'absent';
    while (layer.length) {
      const matches = new Set(layer.map(row => row.name.replace(/\.exe$/, '')).filter(name => known.has(name)));
      if (matches.size) {
        runtimeObservation = matches.size === 1 ? 'present' : 'ambiguous';
        if (matches.size === 1) runtime = [...matches][0];
        break;
      }
      const parents = new Set(layer.map(row => row.pid));
      for (const id of parents) seen.add(id);
      layer = rows.filter(row => parents.has(row.ppid) && !seen.has(row.pid));
    }
  } catch (error) {
    if (error.code?.startsWith('TMUX_') || ['TARGET_GONE','GENERATION_CHANGED','RUNID_MISMATCH'].includes(error.code)) throw error;
    // An unreadable process tree is unknown, not permission to infer from config.
    runtime = 'unknown';
    runtimeObservation = 'unavailable';
  }
  return { runtime, launchConfig, runtimeObservation };
}

async function environment(connection, sessionId, kind = 'pane') {
  const text = await connection.command(['show-environment', '-t', sessionId], { kind });
  return Object.fromEntries(text.split('\n').filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
}

export async function observeSessionTarget({ sessionGroup, tmuxName = tmuxNameForGroup(sessionGroup ?? 'origin'), connection, readReady = readReadyIdentity, readProcessTree: getTree }) {
  const absent = { present: false, tmuxName, runId: null, createdAt: null, runtime: 'unknown', launchConfig: null, ready: false, sessionId: null };
  let output;
  const pinned = connection.binding;
  if (pinned && pinned.tmuxName !== undefined && pinned.tmuxName !== tmuxName) {
    throw tmuxError('TARGET_GONE', 'Cannot resolve a different name on a bound executor');
  }
  try { output = await connection.command(['display-message', '-p', '-t', pinned?.paneId ?? `=${tmuxName}:`, '#{pid}:#{start_time}\t#{session_id}\t#{pane_id}\t#{session_created}']); }
  catch (error) {
    if (missing(error)) return absent;
    if (error.code === 'TMUX_COMMAND_FAILED') throw tmuxError('TMUX_UNAVAILABLE', error.message, error.cause || 'error');
    throw error;
  }
  // display-message returns an empty format (not an error) for an absent target.
  if (!output.trim()) return absent;
  const [generation, tmuxSessionId, paneId, created] = output.split('\t');
  // Server formats still expand when display-message cannot find its target.
  if (!pinned && /^\d+:\d+$/.test(generation) && tmuxSessionId === '' && paneId === '' && created === '') return absent;
  if (!/^\d+:\d+$/.test(generation) || !/^\$\d+$/.test(tmuxSessionId) || !/^%\d+$/.test(paneId) || !/^\d+$/.test(created)) throw tmuxError('TMUX_UNAVAILABLE', 'Invalid tmux object identity', 'error');
  try {
    connection.bindTarget({ serverGeneration: generation, tmuxSessionId, paneId, tmuxName });
    const rawF2 = await environment(connection, tmuxSessionId);
    const runId = rawF2.ZYLOS_RUN_ID || null;
    const runtime = await readTargetRuntime({ connection, paneId, rawF2, readProcessTree: getTree });
    const f3 = await readReady(sessionGroup);
    const ready = Boolean(runId && validReady(f3) && f3.runId === runId);
    const target = { present: true, tmuxName, runId, createdAt: Number(created), ...runtime, ready, sessionId: ready ? f3.sessionId : null, runtimeSessionId: ready ? f3.sessionId : null, rawF2, f3: ready ? f3 : null, tmuxSessionId, paneId, serverGeneration: generation };
    bindings.set(target, { connection, tmuxSessionId, paneId, serverGeneration: generation, runId });
    await revalidateSessionTarget({ connection, target });
    return freezeDeep(target);
  } catch (error) {
    if (missing(error)) throw tmuxError('TARGET_GONE', 'Target object disappeared during observation');
    if (error.code === 'TMUX_COMMAND_FAILED') throw tmuxError('TMUX_UNAVAILABLE', error.message, error.cause || 'error');
    throw error;
  }
}

export async function resolveSessionTarget(options) {
  const observed = await observeSessionTarget(options);
  if (!observed.present) throw tmuxError('TARGET_GONE', 'Target session is absent');
  if (!observed.runId) throw tmuxError('RUNID_MISMATCH', 'Target run ID is missing');
  const target = Object.freeze({ ...observed, sessionId: observed.tmuxSessionId });
  bindings.set(target, bindings.get(observed));
  return target;
}

export async function revalidateSessionTarget({ connection, target, kind = 'pane' }) {
  const binding = bindings.get(target);
  if (!binding || binding.connection !== connection) throw new TypeError('Target must be resolved on this connection');
  if (!['pane','session'].includes(kind)) throw new TypeError('Invalid target kind');
  const generation = (await connection.command(['display-message', '-p', '#{pid}:#{start_time}'], { kind })).trim();
  if (!/^\d+:\d+$/.test(generation)) throw tmuxError('TMUX_UNAVAILABLE', 'tmux server generation unavailable', 'error');
  if (generation !== binding.serverGeneration) throw tmuxError('GENERATION_CHANGED', 'tmux server generation changed');
  let output, env;
  try {
    output = await connection.command(['display-message', '-p', '-t', kind === 'session' ? binding.tmuxSessionId : binding.paneId, kind === 'session' ? '#{session_id}' : '#{session_id}\t#{pane_id}'], { kind });
    env = await environment(connection, binding.tmuxSessionId, kind);
  } catch (error) { if (missing(error)) throw tmuxError('TARGET_GONE', 'Bound tmux object disappeared'); throw error; }
  if (output.trim() !== (kind === 'session' ? binding.tmuxSessionId : `${binding.tmuxSessionId}\t${binding.paneId}`)) throw tmuxError('TARGET_GONE', 'Bound tmux object changed');
  if ((env.ZYLOS_RUN_ID || null) !== binding.runId) throw tmuxError('RUNID_MISMATCH', 'Target run ID changed');
  return true;
}
