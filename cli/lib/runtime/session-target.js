import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { groupRunDir, tmuxNameForGroup } from '../session-group-paths.js';
import { tmuxError, TMUX_COMMAND as C, TMUX_FORMAT as F, isTmuxError,
  isMissingTarget as missing, unavailableCommand, parseTargetObservation, parseTmuxEnvironment } from './tmux-protocol.js';

const exec = promisify(execFile);
const bindings = new WeakMap();
const known = new Set(['claude', 'codex']);

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
  let runtime = 'unknown', runtimeObservation = 'unavailable', runtimePid;
  try {
    const pid = Number((await connection.command([C.displayMessage, '-p', '-t', paneId, F.panePid])).trim());
    const rows = await getTree();
    let layer = rows.filter(row => row.pid === pid);
    const seen = new Set();
    if (Number.isInteger(pid) && pid > 0 && layer.length) runtimeObservation = 'absent';
    while (layer.length) {
      const matches = new Set(layer.map(row => row.name.replace(/\.exe$/, '')).filter(name => known.has(name)));
      if (matches.size) {
        runtimeObservation = matches.size === 1 ? 'present' : 'ambiguous';
        if (matches.size === 1) {
          runtime = [...matches][0];
          const processes = layer.filter(row => row.name.replace(/\.exe$/, '') === runtime);
          if (processes.length === 1) runtimePid = processes[0].pid;
        }
        break;
      }
      const parents = new Set(layer.map(row => row.pid));
      for (const id of parents) seen.add(id);
      layer = rows.filter(row => parents.has(row.ppid) && !seen.has(row.pid));
    }
  } catch (error) {
    if (isTmuxError(error)) throw error;
    // An unreadable process tree is unknown, not permission to infer from config.
    runtime = 'unknown';
    runtimeObservation = 'unavailable';
  }
  return { runtime, launchConfig, runtimeObservation, runtimePid };
}

async function environment(connection, sessionId, kind = 'pane') {
  const text = await connection.command([C.showEnvironment, '-s', '-t', sessionId], { kind });
  return parseTmuxEnvironment(text);
}

export async function observeSessionTarget({ sessionGroup, tmuxName = tmuxNameForGroup(sessionGroup ?? 'origin'), connection, readReady = readReadyIdentity, readProcessTree: getTree }) {
  const absent = { present: false, tmuxName, runId: null, createdAt: null, runtime: 'unknown', launchConfig: null, ready: false, sessionId: null };
  let output;
  const pinned = connection.binding;
  if (pinned && pinned.tmuxName !== undefined && pinned.tmuxName !== tmuxName) {
    throw tmuxError('TARGET_GONE', 'Cannot resolve a different name on a bound executor');
  }
  // tmux 3.2a dereferences a missing session for session_created; conditional
  // expansion keeps initial name lookups safe while retaining an empty field.
  try { output = await connection.command([C.displayMessage, '-p', '-t', pinned?.paneId ?? `=${tmuxName}:`, F.observation]); }
  catch (error) {
    if (missing(error) || error.code === 'TMUX_NO_SERVER') return absent;
    throw unavailableCommand(error);
  }
  // display-message returns an empty format (not an error) for an absent target.
  const observed = parseTargetObservation(output, pinned);
  if (!observed) return absent;
  const {generation, tmuxSessionId, paneId, created} = observed;
  try {
    connection.bindTarget({ serverGeneration: generation, tmuxSessionId, paneId, tmuxName });
    const rawF2 = await environment(connection, tmuxSessionId);
    const runId = rawF2.ZYLOS_RUN_ID || null;
    const runtime = await readTargetRuntime({ connection, paneId, rawF2, readProcessTree: getTree });
    const f3 = await readReady(sessionGroup);
    const ready = Boolean(runId && validReady(f3) && f3.runId === runId);
    const target = { present: true, tmuxName, runId, createdAt: Number(created), ...runtime, ready, sessionId: ready ? f3.sessionId : null, runtimeSessionId: ready ? f3.sessionId : null, rawF2, f3: ready ? f3 : null, tmuxSessionId, paneId, serverGeneration: generation };
    bindings.set(target, { connection, tmuxSessionId, paneId, serverGeneration: generation, runId });
    return freezeDeep(target);
  } catch (error) {
    if (missing(error)) throw tmuxError('TARGET_GONE', 'Target object disappeared during observation');
    throw unavailableCommand(error);
  }
}

export async function resolveSessionTarget(options) {
  let observed;
  try { observed = await observeSessionTarget(options); }
  catch (error) {
    if (error.code === 'TMUX_NO_SERVER') throw tmuxError('TARGET_GONE', 'Target server is absent');
    throw error;
  }
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
  let env;
  try {
    // The bound command guards server generation and object identity atomically.
    env = await environment(connection, binding.tmuxSessionId, kind);
  } catch (error) { if (missing(error)) throw tmuxError('TARGET_GONE', 'Bound tmux object disappeared'); throw error; }
  if ((env.ZYLOS_RUN_ID || null) !== binding.runId) throw tmuxError('RUNID_MISMATCH', 'Target run ID changed');
  return true;
}
