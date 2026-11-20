import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
import { tmuxError as fail } from '../../comm-bridge/scripts/tmux-protocol.js';

const { runtimesWith } = await loadCoreModule('runtime/descriptors.js');
const { groupRunDir, listGroupTmuxSessions, tmuxNameForGroup } = await loadCoreModule('session-group-paths.js');
const { openTmuxConnection } = await loadCoreModule('runtime/tmux-connection.js');
const { observeSessionTarget, revalidateSessionTarget, readProcessTree: systemProcessTree } = await loadCoreModule('runtime/session-target.js');
const { createSessionOps } = await loadCoreModule('runtime/session-ops.js');
const { usageModelFacts } = await loadCoreModule('session-usage-reader.js');
const { createSessionReader } = await loadCoreModule('session-state-reader-async.js');

const absent = (group, env) => ({ sessionGroup: group, present: false, ready: false, processRunning: false,
  tmuxName: tmuxNameForGroup(group ?? 'origin'), runDir: groupRunDir(group ?? 'origin', env),
  runId: null, runtime: 'unknown', sessionId: null, createdAt: null, currentSessionTs: null,
  state: 'unknown', idleSince: null, busySince: null, turnOpen: null, usagePercent: null, launchConfig: null, tmuxTarget: null });
const descriptor = target => ({ serverGeneration: target.serverGeneration, sessionId: target.tmuxSessionId, paneId: target.paneId });
function validTarget(value) {
  return value && /^\d+:\d+$/.test(value.serverGeneration) && /^\$\d+$/.test(value.sessionId) && /^%\d+$/.test(value.paneId);
}
const sourceScope = (group, target) => group === 'origin' && !target.rawF2?.ZYLOS_SESSION_GROUP ? null : group;
const scopeMatches = (group, target) => group === null ? !target.rawF2?.ZYLOS_SESSION_GROUP : target.rawF2?.ZYLOS_SESSION_GROUP === group;
const sameRun = (scene, target) => target.present && target.runId === scene.runId && target.runtime === scene.runtime &&
  target.serverGeneration === scene.tmuxTarget?.serverGeneration && target.tmuxSessionId === scene.tmuxTarget?.sessionId;
/** Current observations, not a session registry. Every action reacquires a bounded
 * executor and pins it to the original object before any mutating command.
 * Activity and usage providers must return facts for the supplied run/session.
 */
export class SupervisorScenes {
  constructor({ env = process.env, connectionOptions = {}, readMode, readActivity,
    readUsage, now = Date.now, open = openTmuxConnection, observeTarget = observeSessionTarget,
    listSessions = listGroupTmuxSessions, readProcessTree = systemProcessTree, sessionOps = createSessionOps,
    reportError = () => {} } = {}) {
    Object.assign(this, { env, connectionOptions, readMode, readActivity, readUsage, now,
      open, observeTarget, listSessions, readProcessTree, sessionOps, reportError });
    this.readReady = async group => {
      try { return JSON.parse(await fs.readFile(path.join(groupRunDir(group ?? 'origin', env), 'current-session.json'), 'utf8')); }
      catch { return null; }
    };
    this.reader = createSessionReader({ env, connectionOptions, now, open, readReady: this.readReady, readProcessTree,
      observe: args => observeTarget({ ...args, readReady: this.readReady, readProcessTree }) });
  }

  async observe(context = {}) {
    const mode = (context.configuration ?? await this.readMode?.())?.mode;
    if (!['single', 'multi'].includes(mode)) throw fail('CONFIG_UNREADABLE', 'Session mode is unavailable');
    const samples = await this.reader.readSessionStates([], { freshnessMs: 5000, includeAllLive: true,
      sampleTarget: async (scope, target) => {
        const group = scope === null ? 'origin' : scope;
        // The source identity determines semantic scope across an F1 cutover.
        const scopeFromTarget = sourceScope(group, target);
        try { return await this.observeGroup(group, { sample: { target }, scope: scopeFromTarget, deferUsage: true }); }
        catch (error) { return this.failedObservation(group, error); }
      } });
    return [...samples].map(([scope, sample]) => {
      const group = scope === null ? 'origin' : scope;
      if (sample.observationError) return this.failedObservation(group, sample.observationError);
      const scene = sample.sampled;
      if (scene?.ready && !this.readUsage) this.applyUsage(scene, sample);
      return scene ?? absent(group, this.env);
    });
  }

  failedObservation(group, error) {
    this.reportError(error, { phase: 'observe', sessionGroup: group });
    return { ...absent(group, this.env), present: true, processRunning: undefined, observationError: error };
  }

  applyUsage(scene, sampled) {
    if (sampled.identity.runId !== scene.runId || sampled.identity.sessionId !== scene.sessionId || !sampled.usage.valid) return;
    const value = sampled.usage.value;
    Object.assign(scene, usageModelFacts(value, scene.runtime, scene.launchConfig));
    const percent = ['claude', 'agy'].includes(scene.runtime) ? value.context_window?.used_percentage :
      value.contextUsage?.ceiling > 0 ? 100 * value.contextUsage.used / value.contextUsage.ceiling : null;
    scene.usagePercent = Number.isFinite(percent) ? percent : null;
  }

  async observeGroup(group, batch = null) {
    let connection;
    try {
      let scope = batch ? batch.scope : group;
      let treePromise;
      const getTree = () => treePromise ??= this.readProcessTree();
      if (!batch) connection = await this.open(this.connectionOptions);
      const target = batch ? batch.sample.target : await this.observeTarget({ sessionGroup: scope, connection, readReady: this.readReady, readProcessTree: getTree });
      if (!target.present) return absent(group, this.env);
      if (!batch) scope = sourceScope(group, target);
      const scene = { sessionGroup: group, sourceScope: scope, present: true, tmuxName: target.tmuxName,
        runDir: groupRunDir(group ?? 'origin', this.env), runId: target.runId, runtime: target.runtime,
        ready: target.ready && scopeMatches(scope, target), sessionId: target.sessionId,
        createdAt: target.createdAt * 1000, currentSessionTs: target.f3?.ts ?? null,
        processRunning: true,
        launchConfig: target.launchConfig, tmuxTarget: descriptor(target), state: 'unknown', idleSince: null, busySince: null, turnOpen: null, usagePercent: null,
        runtimeObservation: target.runtimeObservation };
      scene.runtimePid = target.runtimePid;
      if (Number.isSafeInteger(scene.runtimePid) && scene.runtimePid > 0) {
        scene.proc = { pid: scene.runtimePid, alive: true, last_sample_at: this.now() };
        if (scene.ready && runtimesWith('hookHealth').includes(scene.runtime)) scene.healthIdentity = { runtime: scene.runtime, session_id: scene.sessionId, claude_pid: scene.runtimePid };
      }
      if (scene.ready) {
        if (this.readActivity) {
          const activity = await this.readActivity(scene);
          if (activity) {
            // Identity never comes from status data; only explicitly normalized state facts do.
            for (const key of ['state', 'idleSince', 'busySince', 'turnOpen', 'lastActivityAt', 'transcriptMtimeMs', 'tools', 'activeSubagents', 'lastSubagentActivityAt']) {
              if (Object.hasOwn(activity, key)) scene[key] = activity[key];
            }
          }
        }
        Object.assign(scene, usageModelFacts(null, scene.runtime, scene.launchConfig));
        if (this.readUsage) {
          const usage = await this.readUsage(scene);
          scene.usagePercent = Number.isFinite(usage) ? usage : null;
        } else if (!batch?.deferUsage) {
          const sampled = batch?.sample ?? await this.reader.readSessionState(scope, { freshnessMs: 5000 });
          this.applyUsage(scene, sampled);
        }
      }
      if (!batch) await revalidateSessionTarget({ connection, target });
      return scene;
    } finally { connection?.close(); }
  }

  // Publication checks observe all identities together, never authorizing actions.
  async readIdentities(groups) {
    if (!groups.length) return new Map();
    const targets = await this.reader.readSessionTargets(groups);
    return new Map(groups.map(group => {
      const target = targets.get(group);
      return [group, { ...target, sourceScope: sourceScope(group, target),
        ready: target.ready && scopeMatches(sourceScope(group, target), target) }];
    }));
  }

  // Run/F2/F3 identity only: no process, activity, context or usage sampling.
  async readIdentity(group) {
    let connection;
    try {
      let scope = group;
      connection = await this.open(this.connectionOptions);
      const target = await this.observeTarget({ sessionGroup: scope, connection,
        readReady: this.readReady, readProcessTree: async () => [] });
      if (!target.present) return absent(group, this.env);
      scope = sourceScope(group, target);
      return { sessionGroup: group, sourceScope: scope, present: true, tmuxName: target.tmuxName,
        runId: target.runId, runtime: target.runtime, sessionId: target.sessionId,
        ready: target.ready && scopeMatches(scope, target), launchConfig: target.launchConfig,
        tmuxTarget: descriptor(target) };
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
    const fresh = await this.readIdentity(scene.sessionGroup);
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
        readReady: this.readReady, readProcessTree: async () => [] });
      if (!sameRun(scene, target)) throw fail('RUNID_MISMATCH', 'Pinned target changed');
      return await operation({ connection, target });
    } finally { connection?.close(); }
  }

  async readScreen(scene) {
    return this.withTarget(scene, ({ connection, target }) => this.sessionOps({}).captureScreen({ connection, target }));
  }

  async stop(scene) {
    return this.sessionOps({ tmux: this.connectionOptions, env: this.env })
      .stop({ tmuxName: scene.tmuxName, expectedRunId: scene.runId });
  }
}
