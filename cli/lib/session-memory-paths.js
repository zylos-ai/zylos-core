/** W4-W6 locations only; callers own writing and mode-transition sequencing. */
import path from 'node:path';
import { assertSessionGroup, groupMemoryDir, zylosRoot } from './session-group-paths.js';

export function assertModeSwitchRunId(runId) {
  if (typeof runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    const error = new Error('Invalid mode-switch UUID');
    error.code = 'MODE_SWITCH_RUN_INVALID';
    throw error;
  }
  return runId;
}
export function handoffPath(sessionGroup = null, env = process.env) {
  return path.join(sessionGroup === null ? path.join(zylosRoot(env), 'memory') : groupMemoryDir(sessionGroup, env), 'handoff.md');
}
export function rulesPath(group, env = process.env) {
  return path.join(groupMemoryDir(group, env), 'rules.md');
}
export function modeSwitchDir(runId, env = process.env) {
  return path.join(zylosRoot(env), 'memory', 'mode-switch', assertModeSwitchRunId(runId));
}
export function modeSwitchPreviousDir(runId, scope, env = process.env) {
  if (scope !== '_global') assertSessionGroup(scope);
  return path.join(modeSwitchDir(runId, env), 'previous', scope);
}
export function modeSwitchDonePath(runId, scope, env = process.env) {
  return path.join(modeSwitchPreviousDir(runId, scope, env), '.done');
}
export function modeSwitchUngroupedPath(runId, env = process.env) {
  return path.join(modeSwitchDir(runId, env), 'ungrouped.md');
}
export function modeSwitchGroupPath(runId, group, env = process.env) {
  return path.join(modeSwitchDir(runId, env), `${assertSessionGroup(group)}.md`);
}
