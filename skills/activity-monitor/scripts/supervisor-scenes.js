import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCoreModule } from './core-modules.js';
const { groupRunDir, listGroupTmuxSessions, tmuxNameForGroup } = await loadCoreModule('session-group-paths.js');
const { openTmuxConnection } = await loadCoreModule('runtime/tmux-connection.js');
const { observeSessionTarget, readTargetRuntime, revalidateSessionTarget, readProcessTree: systemProcessTree } = await loadCoreModule('runtime/session-target.js');
const { getSessionAdapter } = await loadCoreModule('runtime/index.js');
const { createSessionReader } = await loadCoreModule('session-state-reader-async.js');

const fail = (code, message) => Object.assign(new Error(message), { code });
const absent = (group, env) => ({ sessionGroup: group, present: false, ready: false, processRunning: false,
  tmuxName: tmuxNameForGroup(group ?? 'origin'), runDir: groupRunDir(group ?? 'origin', env),
  runId: null, runtime: 'unknown', sessionId: null, createdAt: null, currentSessionTs: null,
  state: 'unknown', idleSince: null, usagePercent: null, launchConfig: null, tmuxTarget: null });
const descriptor = target => ({ serverGeneration: target.serverGeneration, sessionId: target.tmuxSessionId, paneId: target.paneId });
function validTarget(value) {
  return value && /^\d+:\d+$/.test(value.serverGeneration) && /^\$\d+$/.test(value.sessionId) && /^%\d+$/.test(value.paneId);
}
const scopeMatches = (group, target) => group === null ? !target.rawF2?.ZYLOS_SESSION_GROUP : target.rawF2?.ZYLOS_SESSION_GROUP === group;
const sameRun = (scene, target) => target.present && target.runId === scene.runId && target.runtime === scene.runtime &&
  target.serverGeneration === scene.tmuxTarget?.serverGeneration && target.tmuxSessionId === scene.tmuxTarget?.sessionId;
const exec = promisify(execFile);

export async function readProcessContextSwitches(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const text = await fs.readFile(`/proc/${pid}/status`, 'utf8');
      const voluntary = text.match(/^voluntary_ctxt_switches:\s+(\d+)$/m);
      const involuntary = text.match(/^nonvoluntary_ctxt_switches:\s+(\d+)$/m);
      return voluntary && involuntary ? Number(voluntary[1]) + Number(involuntary[1]) : null;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await exec('top', ['-l', '1', '-pid', String(pid), '-stats', 'pid,csw', '-s', '0'], { timeout: 5000 });
      const row = stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s*$/)).find(match => match && Number(match[1]) === pid);
      return row ? Number(row[2]) : null;
    }
  } catch { /* Missing process/sample is unknown, never a zero activity sample. */ }
  return null;
}

function nearestRuntimePid(rows, panePid, runtime) {
  let layer = rows.filter(row => row.pid === panePid); const seen = new Set();
  while (layer.length) {
    const matches = layer.filter(row => ['claude', 'codex'].includes(row.name.replace(/\.exe$/, '')));
    if (matches.length) return matches.length === 1 && matches[0].name.replace(/\.exe$/, '') === runtime ? matches[0].pid : undefined;
    const parents = new Set(layer.map(row => row.pid));
    for (const id of parents) seen.add(id);
    layer = rows.filter(row => parents.has(row.ppid) && !seen.has(row.pid));
  }
  return undefined;
}

/** Current observations, not a session registry. Every action reacquires a bounded
 * executor and pins it to the original object before any mutating command.
 * Activity and usage providers must return facts for the supplied run/session.
 */
export class SupervisorScenes {
  constructor({ env = process.env, connectionOptions = {}, readMode, readActivity,
    readUsage, now = Date.now, open = openTmuxConnection, observeTarget = observeSessionTarget,
    listSessions = listGroupTmuxSessions, readProcessTree = systemProcessTree, adapterFor = getSessionAdapter,
    readContextSwitches = readProcessContextSwitches, reportError = () => {} } = {}) {
    Object.assign(this, { env, connectionOptions, readMode, readActivity, readUsage, now,
      open, observeTarget, listSessions, readProcessTree, adapterFor, readContextSwitches, reportError });
    this.processSamples = new Map();
    this.readReady = async group => {
      try { return JSON.parse(await fs.readFile(path.join(groupRunDir(group ?? 'origin', env), 'current-session.json'), 'utf8')); }
      catch { return null; }
    };
    this.reader = createSessionReader({ env, connectionOptions, now, open,
      observe: args => observeTarget({ ...args, readReady: this.readReady, readProcessTree }) });
  }

  async observe(context = {}) {
    const modeValue = context.configuration?.mode ?? context.configuration?.session_mode ?? await this.readMode?.();
    const mode = typeof modeValue === 'string' ? modeValue : modeValue?.mode ?? modeValue?.sessionMode;
    if (!['single', 'multi'].includes(mode)) throw fail('CONFIG_UNREADABLE', 'Session mode is unavailable');
    const rows = await this.listSessions(this.connectionOptions);
    // Preserve source groups during a transition, even after its F1 cutover.
    return Promise.all(rows.map(async row => {
      try { return await this.observeGroup(row.sessionGroup); }
      catch (error) {
        this.reportError(error, { phase: 'observe', sessionGroup: row.sessionGroup });
        // The successful listing proves occupancy but not a usable identity.
        // Keeping that unknown entry prevents false capacity or restart completion.
        return { ...absent(row.sessionGroup, this.env), present: true, processRunning: undefined, observationError: error };
      }
    }));
  }

  async observeGroup(group) {
    let connection;
    try {
      const modeValue = group === 'origin' ? await this.readMode?.() : null;
      const mode = typeof modeValue === 'string' ? modeValue : modeValue?.mode ?? modeValue?.sessionMode;
      const scope = group === 'origin' && mode === 'single' ? null : group;
      let treePromise;
      const getTree = () => treePromise ??= this.readProcessTree();
      try { connection = await this.open(this.connectionOptions); }
      catch (error) { if (error.code === 'TMUX_NO_SERVER') return absent(group, this.env); throw error; }
      const target = await this.observeTarget({ sessionGroup: scope, connection, readReady: this.readReady, readProcessTree: getTree });
      if (!target.present) return absent(group, this.env);
      const process = await readTargetRuntime({ connection, paneId: target.paneId, rawF2: {}, readProcessTree: getTree });
      const scene = { sessionGroup: group, present: true, tmuxName: target.tmuxName,
        runDir: groupRunDir(group ?? 'origin', this.env), runId: target.runId, runtime: target.runtime,
        ready: target.ready && scopeMatches(scope, target), sessionId: target.sessionId,
        createdAt: target.createdAt * 1000, currentSessionTs: target.f3?.ts ?? null,
        processRunning: process.runtimeObservation === 'absent' ? false : process.runtimeObservation === 'present' && process.runtime === target.runtime ? true : undefined,
        launchConfig: target.launchConfig, tmuxTarget: descriptor(target), state: 'unknown', idleSince: null, usagePercent: null,
        runtimeObservation: process.runtimeObservation };
      if (process.runtimeObservation === 'present') {
        const panePid = Number((await connection.command(['display-message', '-p', '-t', target.paneId, '#{pane_pid}'])).trim());
        scene.runtimePid = nearestRuntimePid(await getTree(), panePid, target.runtime);
        if (Number.isSafeInteger(scene.runtimePid) && scene.runtimePid > 0) {
          const count = await this.readContextSwitches(scene.runtimePid), now = this.now();
          const key = scene.sessionGroup ?? 'origin';
          const previous = this.processSamples.get(key);
          const changedAt = Number.isFinite(count) && previous?.runId === scene.runId && previous?.pid === scene.runtimePid && previous?.count === count ? previous.changedAt : now;
          scene.contextSwitches = Number.isFinite(count) ? count : undefined;
          scene.proc = { pid: scene.runtimePid, alive: true, frozen: Number.isFinite(count) ? now - changedAt >= 60000 : null, last_sample_at: now };
          if (Number.isFinite(count)) this.processSamples.set(key, { runId: scene.runId, pid: scene.runtimePid, count, changedAt });
          else this.processSamples.delete(key);
          if (scene.ready && scene.runtime === 'claude') scene.healthIdentity = { runtime: scene.runtime, session_id: scene.sessionId, claude_pid: scene.runtimePid };
        }
      }
      if (scene.ready) {
        if (this.readActivity) {
          const activity = await this.readActivity(scene);
          if (activity) {
            // Identity never comes from status data; only explicitly normalized state facts do.
            for (const key of ['state', 'idleSince', 'lastActivityAt', 'transcriptMtimeMs', 'tools']) {
              if (Object.hasOwn(activity, key)) scene[key] = activity[key];
            }
          }
        }
        if (this.readUsage) {
          const usage = await this.readUsage(scene);
          scene.usagePercent = Number.isFinite(usage) ? usage : null;
        } else {
          const sampled = await this.reader.readSessionState(scope, { freshnessMs: 5000 });
          if (sampled.identity.runId === scene.runId && sampled.identity.sessionId === scene.sessionId && sampled.usage.valid) {
            const value = sampled.usage.value;
            const percent = target.runtime === 'claude' ? value.context_window?.used_percentage :
              value.contextUsage?.ceiling > 0 ? 100 * value.contextUsage.used / value.contextUsage.ceiling : null;
            scene.usagePercent = Number.isFinite(percent) ? percent : null;
          }
        }
      }
      await revalidateSessionTarget({ connection, target });
      return scene;
    } finally { connection?.close(); }
  }

  async readRun(group) {
    const scene = await this.observeGroup(group);
    return scene.present ? scene : null;
  }

  async listRuns() {
    const rows = await this.listSessions(this.connectionOptions);
    const scenes = await Promise.all(rows.map(row => this.observeGroup(row.sessionGroup)));
    return scenes.filter(scene => scene.present);
  }

  async bindTarget(scene) {
    const fresh = await this.observeGroup(scene.sessionGroup);
    if (!fresh.present) throw fail('TARGET_NOT_RUNNING', 'Target session is absent');
    if (fresh.runId !== scene.runId || fresh.runtime !== scene.runtime) throw fail('TARGET_MISMATCH', 'Target run changed');
    if (!fresh.ready) throw fail('TARGET_NOT_READY', 'Target has not published a matching identity');
    return { expectedRunId: fresh.runId, tmuxTarget: fresh.tmuxTarget };
  }

  async withTarget(scene, operation) {
    if (!validTarget(scene.tmuxTarget) || !scene.runId) throw fail('TARGET_SNAPSHOT_UNKNOWN', 'Pinned target is unavailable');
    let connection;
    try {
      connection = await this.open(this.connectionOptions);
      connection.bindTarget({ serverGeneration: scene.tmuxTarget.serverGeneration,
        tmuxSessionId: scene.tmuxTarget.sessionId, paneId: scene.tmuxTarget.paneId });
      const target = await this.observeTarget({ sessionGroup: scene.sessionGroup, tmuxName: scene.tmuxName, connection,
        readReady: this.readReady, readProcessTree: this.readProcessTree });
      if (!sameRun(scene, target)) throw fail('RUNID_MISMATCH', 'Pinned target changed');
      return await operation({ connection, target, adapter: this.adapterFor(target.runtime) });
    } finally { connection?.close(); }
  }

  async readScreen(scene) {
    return this.withTarget(scene, ({ connection, target, adapter }) => adapter.captureScreen({ connection, target }));
  }

  async fixedConnection(request) {
    if (!validTarget(request.tmuxTarget) || typeof request.expectedRunId !== 'string' || !request.expectedRunId) {
      throw fail('TARGET_SNAPSHOT_UNKNOWN', 'Saved target is invalid');
    }
    const connection = await this.open(this.connectionOptions);
    try {
      connection.bindTarget({ serverGeneration: request.tmuxTarget.serverGeneration,
        tmuxSessionId: request.tmuxTarget.sessionId, paneId: request.tmuxTarget.paneId });
      return connection;
    } catch (error) { connection.close(); throw error; }
  }

  async verifyFixed(connection, request) {
    const session = (await connection.command(['display-message', '-p', '-t', request.tmuxTarget.sessionId, '#{session_id}'], { kind: 'session' })).trim();
    if (session !== request.tmuxTarget.sessionId) throw fail('TARGET_GONE', 'Original session is absent');
    const environment = await connection.command(['show-environment', '-t', request.tmuxTarget.sessionId], { kind: 'session' });
    const runId = environment.split('\n').find(line => line.startsWith('ZYLOS_RUN_ID='))?.slice('ZYLOS_RUN_ID='.length);
    if (runId !== request.expectedRunId) throw fail('RUNID_MISMATCH', 'Original session run identity changed');
    if (request.expectedSessionId !== undefined) {
      const ready = await this.readReady('origin');
      // F3 may already belong to a replacement Origin while the pinned old
      // object still exists. Only an observed context change in the same run
      // rejects this operation; an unreported /clear is not atomically fenced.
      const validReady = ready && typeof ready.runId === 'string' && ready.runId &&
        typeof ready.sessionId === 'string' && ready.sessionId && Number.isInteger(ready.ts) &&
        Array.isArray(ready.startupControlIds) && ready.startupControlIds.every(Number.isInteger);
      if (validReady && ready.runId === request.expectedRunId && ready.sessionId !== request.expectedSessionId) {
        throw fail('TARGET_MISMATCH', 'Original run context changed');
      }
    }
  }

  async observeFixedTarget(request) {
    let connection;
    try {
      connection = await this.fixedConnection(request);
      await this.verifyFixed(connection, request);
      return { present: true, runId: request.expectedRunId, tmuxTarget: request.tmuxTarget };
    } catch (error) {
      if (['TMUX_NO_SERVER', 'TARGET_GONE', 'GENERATION_CHANGED'].includes(error.code)) return { present: false };
      throw error;
    } finally { connection?.close(); }
  }

  async stopFixedTarget(request) {
    let connection;
    try {
      connection = await this.fixedConnection(request);
      await this.verifyFixed(connection, request);
      await connection.command(['kill-session', '-t', request.tmuxTarget.sessionId], { kind: 'session' });
      try {
        await connection.command(['display-message', '-p', '-t', request.tmuxTarget.sessionId, '#{session_id}'], { kind: 'session' });
      } catch (error) {
        if (['TARGET_GONE', 'GENERATION_CHANGED', 'TMUX_NO_SERVER'].includes(error.code)) return;
        throw error;
      }
      throw fail('STOP_UNCONFIRMED', 'Original session removal is unconfirmed');
    } catch (error) {
      if (['TARGET_GONE', 'GENERATION_CHANGED', 'TMUX_NO_SERVER'].includes(error.code)) return;
      throw error;
    } finally { connection?.close(); }
  }

  async stop(scene) {
    return this.stopFixedTarget({ expectedRunId: scene.runId, tmuxTarget: scene.tmuxTarget });
  }
}
