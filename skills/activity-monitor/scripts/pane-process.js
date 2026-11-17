/**
 * Which process is a run's pane main process.
 *
 * The launcher records the tmux pane process of each run in
 * `<run dir>/pane-process.json` right after tmux confirms the pane. The pane
 * command execs the runtime, so the recorded pid and start time are the
 * runtime's own (Claude), or the launcher wrapper whose child is the native
 * runtime (Codex). Hooks never write this record.
 *
 * Child runtimes started inside a session (an upgrade evaluation, an agent's
 * `claude -p` or `codex exec`) inherit the run variables and read the same
 * record, which is what lets them recognise themselves as not the pane
 * process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProcessInfo, firstNonShellAncestor } from './claude-pid.js';

export const PANE_PROCESS_FILE = 'pane-process.json';
const RUNTIMES = new Set(['claude', 'codex']);

const positive = value => Number.isSafeInteger(value) && value > 0;
const startValue = value => typeof value === 'string' && value.length > 0 && value.length <= 64;

export function writePaneProcess(dir, { runId, runtime, panePid, paneStart }) {
  if (typeof runId !== 'string' || !runId || !RUNTIMES.has(runtime) || !positive(panePid) || !startValue(paneStart)) {
    throw new TypeError('Invalid pane process record');
  }
  const record = { v: 1, runId, runtime, panePid, paneStart };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, PANE_PROCESS_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  return record;
}

export function readPaneProcess(dir, { fsImpl = fs } = {}) {
  let value;
  try { value = JSON.parse(fsImpl.readFileSync(path.join(dir, PANE_PROCESS_FILE), 'utf8')); }
  catch { return null; }
  if (!value || value.v !== 1 || typeof value.runId !== 'string' || !value.runId || !RUNTIMES.has(value.runtime) ||
    !positive(value.panePid) || !startValue(value.paneStart)) return null;
  return value;
}

/**
 * Whether a process identity `{pid, start, ppid, parentStart}` is the pane
 * process: the pane process itself, or for Codex its direct child (the native
 * runtime under the launcher wrapper).
 */
export function belongsToPane(identity, { runtime, panePid, paneStart = null }) {
  if (!identity || !positive(panePid)) return false;
  // A start time missing on either side compares pids only.
  const sameStart = start => start == null || paneStart == null || start === paneStart;
  if (identity.pid === panePid) return sameStart(identity.start);
  if (runtime === 'codex' && identity.ppid === panePid) return sameStart(identity.parentStart);
  return false;
}

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
export function classifyHookProcess({ env = process.env, dir, trigger, readInfo = readProcessInfo }) {
  if (!trigger) return { verdict: 'unknown', reason: 'process_unreadable' };
  if (!env.ZYLOS_RUN_ID) {
    const parent = firstNonShellAncestor(trigger.ppid, readInfo);
    if (!parent) return { verdict: 'unknown', reason: 'process_unreadable' };
    if (isTmux(parent)) return { verdict: 'main', reason: 'tmux_pane_process' };
    if (trigger.comm === 'codex') {
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
  if (record.runtime === 'codex' && trigger.ppid === record.panePid) {
    const parentStart = readInfo(record.panePid)?.start ?? null;
    if (parentStart === null) return { verdict: 'unknown', reason: 'pane_unreadable', record };
    return belongsToPane({ ...trigger, parentStart }, pane)
      ? { verdict: 'main', reason: 'pane_process_child', record }
      : { verdict: 'child', reason: 'pane_pid_reused', record };
  }
  return { verdict: 'child', reason: 'not_pane_process', record };
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
export function childRuntimeOf(trigger, transcriptPath) {
  const name = trigger?.comm?.replace(/\.exe$/, '');
  if (RUNTIMES.has(name)) return name;
  const location = typeof transcriptPath === 'string' ? transcriptPath.replaceAll('\\', '/') : '';
  if (location.includes('/.codex/')) return 'codex';
  if (location.includes('/.claude/')) return 'claude';
  return null;
}
