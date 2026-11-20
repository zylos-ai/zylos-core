import { UNSUPPORTED } from '../contract.js';

function statuslineActivity(sample) {
  return {
    idle: sample.agent_state === 'idle',
    tasksRunning: sample.task_count > 0 ||
      (Array.isArray(sample.subagents) && sample.subagents.some(agent => agent?.status === 'running')),
  };
}

export const busy = Object.freeze({
  source: 'statusline',
  queuedPromptsInTurn: false,
  transcript: UNSUPPORTED,
  statuslineActivity,
});
