/**
 * Which process is a run's pane main process.
 *
 * The launcher records the tmux pane process of each run in
 * `<run dir>/pane-process.json` right after tmux confirms the pane. The pane
 * command execs the runtime, so the recorded pid and start time are the
 * runtime's own: Claude, native Codex (the Codex launcher can replace itself
 * with the native binary), or a Codex launcher wrapper that keeps running with
 * the native runtime as its child. Hooks never write this record.
 *
 * Child runtimes started inside a session (an upgrade evaluation, an agent's
 * `claude -p` or `codex exec`) inherit the run variables and read the same
 * record, which is what lets them recognise themselves as not the pane
 * process.
 */
import path from 'node:path';
import { readProcessInfo, firstNonShellAncestor } from './claude-pid.js';
import { loadCoreModule } from './core-modules.js';

const { belongsToPane, processName, readPaneProcess } = await loadCoreModule('runtime/pane-process.js');
const { runtimesWith } = await loadCoreModule('runtime/descriptors.js');
const usageRuntimes = runtimesWith('usage');

const isTmux = info => path.basename(info.comm).startsWith('tmux');

/**
 * Classify the process that fired a hook.
 *
 * - `main`: it is the run's pane process.
 * - `child`: it is determinably another process.
 * - `unknown`: the evidence needed to decide is missing or unreadable.
 *
 * A managed hook (ZYLOS_RUN_ID set) is compared with the run's pane-process
 * record. A hook without a run id belongs to no managed run, and its record
 * cannot exist: it is the pane process only when the tmux server started it
 * (Claude) or started its parent (the Codex wrapper).
 */
export async function classifyHookProcess({ env = process.env, dir, trigger, readInfo = readProcessInfo }) {
  if (!trigger) return { verdict: 'unknown', reason: 'process_unreadable' };
  if (!env.ZYLOS_RUN_ID) {
    const parent = firstNonShellAncestor(trigger.ppid, readInfo);
    if (!parent) return { verdict: 'unknown', reason: 'process_unreadable' };
    if (isTmux(parent)) return { verdict: 'main', reason: 'tmux_pane_process' };
    const runtime = processName(trigger.comm);
    const { findRuntime } = await loadCoreModule('runtime/index.js');
    const wrapsNative = (await findRuntime(runtime))?.identity.launcherWrapsNative === true;
    if (wrapsNative && processName(parent.comm) !== runtime) {
      const grandparent = firstNonShellAncestor(parent.ppid, readInfo);
      if (!grandparent) return { verdict: 'unknown', reason: 'process_unreadable' };
      if (isTmux(grandparent)) return { verdict: 'main', reason: 'tmux_pane_process' };
    }
    return { verdict: 'child', reason: 'not_tmux_pane_process' };
  }
  const record = dir ? readPaneProcess(dir) : null;
  if (!record) return { verdict: 'unknown', reason: 'record_missing' };
  if (record.runId !== env.ZYLOS_RUN_ID) return { verdict: 'unknown', reason: 'record_other_run' };
  const pane = { runtime: record.runtime, panePid: record.panePid, paneStart: record.paneStart };
  if (trigger.pid === record.panePid) {
    return belongsToPane(trigger, pane)
      ? { verdict: 'main', reason: 'pane_process', record }
      : { verdict: 'child', reason: 'pane_pid_reused', record };
  }
  if (trigger.ppid !== record.panePid) return { verdict: 'child', reason: 'not_pane_process', record };
  const { findRuntime } = await loadCoreModule('runtime/index.js');
  const wrapsNative = (await findRuntime(record.runtime))?.identity.launcherWrapsNative === true;
  if (!wrapsNative) return { verdict: 'child', reason: 'not_pane_process', record };
  const paneInfo = readInfo(record.panePid);
  if (!paneInfo) return { verdict: 'unknown', reason: 'pane_unreadable', record };
  if (typeof paneInfo.comm !== 'string' || !paneInfo.comm || processName(paneInfo.comm) === record.runtime) {
    return { verdict: 'child', reason: 'not_pane_process', record };
  }
  return belongsToPane({ ...trigger, parentStart: paneInfo.start }, { ...pane, paneComm: paneInfo.comm, wrapsNative })
    ? { verdict: 'main', reason: 'pane_process_child', record }
    : { verdict: 'child', reason: 'pane_pid_reused', record };
}

/** READY fields naming the process that published it, for the supervisor's pane check. */
export function readyProcessFields(trigger, { readInfo = readProcessInfo } = {}) {
  if (!trigger) return {};
  const parentStart = readInfo(trigger.ppid)?.start ?? null;
  return {
    runtimePid: trigger.pid, runtimeStart: trigger.start,
    runtimeParentPid: trigger.ppid, ...(parentStart === null ? {} : { runtimeParentStart: parentStart }),
  };
}

/** Runtime of a child process, from its process name or transcript location. */
export function childRuntimeOf(trigger, transcriptPath, markers = []) {
  const name = processName(trigger?.comm);
  if (usageRuntimes.includes(name)) return name;
  const location = typeof transcriptPath === 'string' ? transcriptPath.replaceAll('\\', '/') : '';
  for (const [id, marker] of markers) {
    if (location.includes(marker)) return id;
  }
  return null;
}
