import path from 'node:path';
import { groupMemoryDir, zylosRoot } from './session-group-paths.js';

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
