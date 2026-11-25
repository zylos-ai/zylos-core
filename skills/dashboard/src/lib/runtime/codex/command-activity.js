const BASENAME = /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,79}$/u;
const SECRET_NAME = /^(?:sk-|xox[a-z]-|gh[pousr]_|github_pat_|AKIA|eyJ)/i;

function basename(value) {
  if (typeof value !== 'string' || /[:@?\s#$=`"'\\]/u.test(value)) return null;
  const name = value.split('/').at(-1);
  return BASENAME.test(name) && !SECRET_NAME.test(name) ? name : null;
}

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
    const name = basename(action);
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
      const name = basename(part.path ?? part.name);
      if (name) label = { key: 'viewFile', arg: name };
    } else if (part?.type === 'search') label = { key: 'searchFiles' };
    else if (part?.type === 'list_files') label = { key: 'listDirectory' };
    else label = commandKind(part?.cmd);
    first ??= label;
    count++;
    allReads &&= label?.key === 'viewFile';
  }
  return { first, count, allReads };
}

export function commandActivityLabel(activity) {
  if (!activity?.first) return null;
  const { first, count, allReads } = activity;
  return count > 1 ? { ...first, count, more: allReads ? 'files' : 'commands' } : first;
}
