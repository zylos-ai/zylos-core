// Codex 0.167.0 multi-agent rollout lines for one parent turn that starts and finishes a subagent.
//
// Shapes are taken from the Codex 0.167.0 binary's tool definitions and strings, not from a recorded rollout:
// - v2 (multi_agents_v2): `spawn_agent` takes `task_name` and `message` and answers `{"task_name": …}` (the
//   canonical task path, e.g. `/root/task_3`), with no agent id; `wait_agent` waits on the mailbox and answers
//   "Wait completed." / "Wait timed out." without naming agents; a finished subagent is reported to its parent as a
//   `<subagent_notification>` input.
// - v1 in code mode: the agent calls `tools.spawn_agent(…)` / `tools.wait_agent(…)` from JavaScript run by the
//   `exec` custom tool, and the rollout holds only that exec call and the text the script printed.
// Replace these with recorded 0.167.0 lines when available; tests read only the fields used below.

const at = second => `2026-11-08T10:00:${String(second).padStart(2, '0')}.000Z`;
const item = (second, payload) => ({ timestamp: at(second), type: 'response_item', payload });

/** v2: spawn by task name, wait on the mailbox, completion notice naming the task path. */
export function multiAgentV2Turn({ task = 'inspect_logs', path = `/root/${task}` } = {}) {
  return [
    item(1, { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'spawn-v2',
      arguments: JSON.stringify({ task_name: task, message: 'Look through the service logs for the restart', fork_turns: 'none' }) }),
    item(2, { type: 'function_call_output', call_id: 'spawn-v2', output: JSON.stringify({ task_name: path }) }),
    item(3, { type: 'function_call', name: 'wait_agent', namespace: 'collaboration', call_id: 'wait-v2', arguments: JSON.stringify({ timeout_ms: 60000 }) }),
    item(9, { type: 'message', role: 'user', content: [{ type: 'input_text',
      text: `<subagent_notification>${JSON.stringify({ agent_path: path, status: { completed: 'Found the restart at 02:04' } })}</subagent_notification>` }] }),
    item(9, { type: 'function_call_output', call_id: 'wait-v2', output: JSON.stringify({ message: 'Wait completed.', timed_out: false }) }),
  ];
}

/** v1 in code mode: spawn and wait inside `exec`, the script printing what the tools returned. */
export function codeModeV1Turn({ agentId = '019a6c2e-7b1d-7f00-9c41-5e2d8f0a1b23' } = {}) {
  return [
    item(1, { type: 'custom_tool_call', name: 'exec', call_id: 'exec-spawn',
      input: 'const agent = await tools.spawn_agent({ message: "Check the backup lock", agent_type: "explorer" });\ntext(JSON.stringify(agent));' }),
    item(2, { type: 'custom_tool_call_output', call_id: 'exec-spawn', output: [{ type: 'input_text',
      text: `Script completed\nWall time: 0.4 seconds\nOutput:\n${JSON.stringify({ agent_id: agentId, nickname: 'Kepler' })}` }] }),
    item(3, { type: 'custom_tool_call', name: 'exec', call_id: 'exec-wait',
      input: `const done = await tools.wait_agent({ targets: ["${agentId}"], timeout_ms: 120000 });\ntext(JSON.stringify(done));` }),
    item(8, { type: 'custom_tool_call_output', call_id: 'exec-wait', output: [{ type: 'input_text',
      text: `Script completed\nWall time: 5.1 seconds\nOutput:\n${JSON.stringify({ status: { [agentId]: { completed: 'The lock was stale' } }, timed_out: false })}` }] }),
  ];
}
