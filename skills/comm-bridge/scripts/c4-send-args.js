export function sendError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseSendArgs(args, { isTTY = false } = {}) {
  if (args[0] === '--absorbed-reply') {
    if (args.length !== 3 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args[1]) ||
        !/^[1-9][0-9]{0,18}$/.test(args[2])) throw sendError('INVALID_ARGS', 'Expected --absorbed-reply <runId> <id> with stdin content');
    return { kind: 'absorbed', runId: args[1], id: args[2], stdin: true };
  }
  if (args.length < 2) throw sendError('INVALID_ARGS', 'Usage: node c4-send.js <channel> [endpoint] --stdin');
  const positional = args.filter(arg => arg !== '--stdin');
  const stdinAvailable = !isTTY || positional.length !== args.length;
  const groupIndex = positional.indexOf('--session-group');
  let groupName;
  if (groupIndex !== -1) {
    if (positional[0] === 'void' || groupIndex !== positional.length - 2 ||
        positional.lastIndexOf('--session-group') !== groupIndex || !positional[groupIndex + 1] ||
        positional[groupIndex + 1].startsWith('--')) {
      throw sendError('INVALID_ARGS', 'Place --session-group <L> last; use stdin for content containing option tokens');
    }
    groupName = positional.splice(groupIndex, 2)[1];
  }
  if (positional.some(arg => ['--group', '--absorbed-reply', '--session-group'].includes(arg))) {
    throw sendError('INVALID_ARGS', 'Reserved option token; use stdin for literal content');
  }
  if (groupIndex !== -1 && positional.length > 3) throw sendError('INVALID_ARGS', 'Extra arguments; use stdin');
  const result = { kind: positional[0] === 'void' ? 'void' : 'external', channel: positional[0], endpoint: null, groupName };
  if (stdinAvailable && positional.length <= 2) {
    if (!positional.length) throw sendError('INVALID_ARGS', 'Channel is required');
    return { ...result, endpoint: positional[1] ?? null, stdin: true };
  }
  if (positional.length < 2) throw sendError('INVALID_ARGS', 'Message is required');
  return { ...result, endpoint: positional.length >= 3 ? positional[1] : null,
    message: positional[positional.length >= 3 ? 2 : 1].replace(/\\n/g, '\n'), stdin: false };
}
