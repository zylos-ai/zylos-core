#!/usr/bin/env node
/**
 * Read-only report of how the hook entry classifies the runtime this command
 * runs under. Run it from a session's shell tool:
 *
 *   node ~/zylos/.claude/skills/activity-monitor/scripts/main-process-check.js
 *
 * It applies the same classification a hook would get, starting from this
 * command's first non-shell ancestor (the runtime that ran the shell). It only
 * reads process information, the run's pane-process record and the tmux pane
 * pid (of $TMUX_PANE, else of the group's zylos tmux session); it writes no
 * file and enqueues nothing.
 */
import { execFileSync } from 'node:child_process';
import { readHookTrigger, readProcessInfo } from './claude-pid.js';
import { belongsToPane, classifyHookProcess, readPaneProcess } from './pane-process.js';
import { isMainModule } from './is-main-module.js';
import { loadCoreModule } from './core-modules.js';
import { TMUX_FORMAT } from '../../comm-bridge/scripts/tmux-protocol.js';
import { tmuxClientArgs } from '../../comm-bridge/scripts/tmux-client-args.js';

function readTmuxPanePid(target, exec, env) {
  const args = tmuxClientArgs({}, env);
  try {
    const out = exec('tmux', [...args, 'display-message', '-p', '-t', target, TMUX_FORMAT.panePid], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000,
    }).trim();
    return /^\d+$/.test(out) ? { panePid: Number(out) } : { panePid: null, error: 'unexpected tmux output' };
  } catch (error) {
    return { panePid: null, error: error.code || 'tmux failed' };
  }
}

export async function checkMainProcess({
  env = process.env,
  readTrigger = () => readHookTrigger(),
  readInfo = readProcessInfo,
  exec = execFileSync,
} = {}) {
  const { runDirFromEnv, tmuxNameForGroup, tmuxPaneTarget } = await loadCoreModule('session-group-paths.js');
  let location = null, locationError = null;
  try { location = runDirFromEnv(env); } catch (error) { locationError = error.code || error.message; }
  const trigger = readTrigger();
  const decision = location
    ? classifyHookProcess({ env, dir: location.dir, trigger, readInfo })
    : { verdict: 'unknown', reason: `run_dir:${locationError}` };
  const record = location && env.ZYLOS_RUN_ID ? readPaneProcess(location.dir) : null;
  let tmuxTarget = env.TMUX_PANE || null;
  try { tmuxTarget ??= env.ZYLOS_RUN_ID ? tmuxPaneTarget(tmuxNameForGroup(env.ZYLOS_SESSION_GROUP ?? 'origin')) : null; }
  catch { tmuxTarget = null; }
  const tmux = tmuxTarget ? readTmuxPanePid(tmuxTarget, exec, env) : { panePid: null, error: 'no tmux target' };
  // What the supervisor's READY check would conclude for a READY this process published.
  let runtime = null;
  try { runtime = JSON.parse(env.ZYLOS_MODEL_CONFIG).runtime ?? null; } catch { /* unknown */ }
  const paneInfo = tmux.panePid !== null ? readInfo(tmux.panePid) : null;
  const tmuxPaneCheck = trigger && tmux.panePid !== null
    ? belongsToPane({ ...trigger, parentStart: readInfo(trigger.ppid)?.start ?? null },
      { runtime, panePid: tmux.panePid, paneStart: paneInfo?.start ?? null, paneComm: paneInfo?.comm ?? null })
    : null;
  return {
    determinable: decision.verdict !== 'unknown',
    mainProcess: decision.verdict === 'main',
    verdict: decision.verdict,
    reason: decision.reason,
    basis: {
      runId: env.ZYLOS_RUN_ID || null,
      sessionGroup: env.ZYLOS_SESSION_GROUP ?? null,
      runDir: location?.dir ?? null,
      trigger,
      triggerParent: trigger ? readInfo(trigger.ppid) : null,
      paneProcessRecord: record,
      tmuxTarget,
      tmuxPanePid: tmux.panePid,
      ...(tmux.error ? { tmuxError: tmux.error } : {}),
      recordMatchesTmux: record && tmux.panePid !== null ? record.panePid === tmux.panePid : null,
      runtime,
      tmuxPaneCheck,
    },
  };
}

if (isMainModule(import.meta.url)) {
  checkMainProcess().then(report => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`[main-process-check] ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
