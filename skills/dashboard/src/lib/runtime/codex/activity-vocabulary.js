import { commandActivityLabel } from './command-activity.js';

// Calls that manage subagents rather than do work (both multi-agent tool generations, including an `exec` that
// calls them from code mode); the subagent itself is a subtask row. A code-mode `wait` with a cell id is not one of
// them: it resumes a yielded `exec`, whose step it ends.
const CODEX_AGENT_CONTROLS = new Set(['spawn_agent', 'send_input', 'wait_agent', 'close_agent', 'resume_agent',
  'send_message', 'list_agents', 'followup_task', 'interrupt_agent', 'wait', 'sleep']);
const CODEX_COMMANDS = new Set(['exec', 'exec_command', 'shell', 'local_shell', 'container.exec', 'write_stdin', 'unified_exec']);

const shortPath = value => String(value).split('/').filter(Boolean).slice(-3).join('/');
const plain = value => typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;

export default Object.freeze({
  toolEvents: 'transcript',
  stepLabel(event, { tool }) {
    if (event.meta.command_activity || CODEX_COMMANDS.has(tool)) {
      return commandActivityLabel(event.meta.command_activity) ?? { key: 'runCommand' };
    }
    if (tool === 'apply_patch') {
      const files = (plain(event.summary) ?? '').replace(/^Edit files:?\s*/, '').split(', ').filter(Boolean);
      return files.length === 1 ? { key: 'edit', arg: shortPath(files[0]) } : { key: 'editFiles' };
    }
    return { key: 'tool' };
  },
  opensStep(event, tool) {
    const { meta } = event;
    if (typeof meta.resumes_cell === 'string' || CODEX_AGENT_CONTROLS.has(tool)) return false;
    if (Array.isArray(meta.wraps_agent_tools) && meta.wraps_agent_tools.length) return false;
    return !!(meta.tool_use_id ?? meta.call_id);
  },
  subagentLaunchTools: Object.freeze([]),
  resumesCells: true,
});
