import { safeBasename, skillNameFromPath } from '../activity-path.js';

export const CODEX_COMMANDS = new Set(['exec', 'exec_command', 'shell', 'local_shell', 'container.exec', 'write_stdin', 'unified_exec']);

function commandKind(command) {
  if (typeof command !== 'string') return null;
  const prefix = command.match(/^([\w./-]+)(?:[ \t]+([\w./-]+)(?=\s|$))?/);
  if (!prefix) return null;
  const [, executable, action] = prefix;
  if (executable === 'git') {
    if (['status', 'diff', 'log'].includes(action)) return { key: 'codeStatus' };
    if (action === 'commit') return { key: 'commitCode' };
    if (action === 'push') return { key: 'pushCode' };
  }
  if (executable === 'gh' && action === 'pr') return { key: 'viewPr' };
  if (/(?:^|\/)c4-send(?:\.js)?$/.test(executable)) return { key: 'sendMessage' };
  if (['pytest', 'jest', 'vitest'].includes(executable) ||
      ['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'go', 'make'].includes(executable) && action === 'test') return { key: 'runTests' };
  if (['node', 'python', 'python3'].includes(executable)) {
    if (typeof action === 'string' && /(?:^|\/)c4-send\.js$/.test(action)) return { key: 'sendMessage' };
    if (action === '--test' || /(?:^|\/)run-node-tests\.js$/.test(action ?? '')) return { key: 'runTests' };
    const name = safeBasename(action);
    if (name && /\.(?:[cm]?js|ts|py)$/.test(name)) return { key: 'runScript', arg: name };
  }
  return null;
}

export function summarizeCommandActivity(item, previous) {
  const parsed = Array.isArray(item.parsed_cmd) && item.parsed_cmd.length ? item.parsed_cmd : [{ cmd: item.command }];
  let { first = null, count = 0, allReads = true } = previous ?? {};
  for (const part of parsed) {
    let label = null;
    if (part?.type === 'read') {
      const name = safeBasename(part.path ?? part.name), skill = skillNameFromPath(part.path);
      if (skill) label = { key: 'skill', arg: skill };
      else if (name) label = { key: 'read', arg: name };
    } else if (part?.type === 'search') label = { key: 'searchFiles' };
    else if (part?.type === 'list_files') label = { key: 'listDirectory' };
    else label = commandKind(part?.cmd);
    first ??= label;
    count++;
    allReads &&= label?.key === 'read' || label?.key === 'skill';
  }
  return { first, count, allReads };
}

export function commandActivityLabel(activity) {
  if (!activity?.first) return null;
  const { first, count, allReads } = activity;
  return count > 1 ? { ...first, count, more: allReads ? 'files' : 'commands' } : first;
}
