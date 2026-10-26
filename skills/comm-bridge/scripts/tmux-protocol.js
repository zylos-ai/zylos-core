/** tmux wire vocabulary shared by core and deployed system skills. */
export const TMUX_COMMAND = Object.freeze(Object.fromEntries([
  'has-session', 'list-panes', 'kill-session', 'load-buffer', 'paste-buffer',
  'delete-buffer', 'capture-pane', 'send-keys', 'new-session', 'display-message',
  'show-environment', 'set-environment', 'if-shell', 'list-sessions', 'set-hook',
  'attach', 'kill-server', 'set-buffer', 'save-buffer',
].map(name => [name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), name])));

export const TMUX_FORMAT = Object.freeze({
  generation: '#{pid}:#{start_time}', panePid: '#{pane_pid}', sessionId: '#{session_id}',
  paneId: '#{pane_id}', sessionPane: '#{session_id}\t#{pane_id}',
  geometry: '#{cursor_x},#{cursor_y},#{pane_width},#{pane_height}',
  cursorX: '#{cursor_x}', cursorY: '#{cursor_y}',
  observation: '#{pid}:#{start_time}\t#{session_id}\t#{pane_id}\t#{?session_id,#{session_created},}',
  sessions: '#{session_name}\t#{session_created}',
  exec: '#{session_id}\t#{pane_id}\t#{pane_dead}\t#{pane_current_command}',
  stale: 'display-message -p "ZYLOS_STALE #{pid}:#{start_time}"',
  detachHint: 'display-message -d 3000 " Tip: Ctrl+B d to detach "',
});

export const IDENTITY_ERROR_CODES = Object.freeze(['TARGET_GONE', 'GENERATION_CHANGED', 'RUNID_MISMATCH']);
export const isIdentityError = error => IDENTITY_ERROR_CODES.includes(typeof error === 'string' ? error : error?.code);
export const isTmuxError = error => error?.code?.startsWith('TMUX_') || isIdentityError(error);
export const isMissingTarget = error => error?.code === 'TMUX_COMMAND_FAILED' && /can't find|no such|no current|session not found/i.test(error.message);
export const noServer = text => /^(?:no server running(?: on .*)?|no sessions|server exited unexpectedly|error connecting[^\n]*No such file[^\n]*)\r?$/m.test(text.trim());

export function tmuxError(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}
export function adapterError(code, message = code, cause) {
  return Object.assign(new Error(message), { code }, cause === undefined ? {} : { cause });
}
export function unavailableCommand(error, message = error.message) {
  return ['TMUX_COMMAND_FAILED', 'TMUX_RESPONSE_INVALID'].includes(error.code) ? tmuxError('TMUX_UNAVAILABLE', message, error.cause || 'error') : error;
}
// Group discovery deliberately retains its narrower legacy absence contract.
export function groupListNoServer(error) {
  const stderr = String(error.stderr || '').trim();
  return error.status === 1 && !error.code && (
    /^no server running on [^\n]+$/.test(stderr) ||
    /^error connecting to [^\n]+ \(No such file or directory\)$/.test(stderr));
}

export function validateTmuxArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) throw new TypeError('Invalid tmux argv');
}
// tmux command-parser tokens, never shell source or message text.
export const quoteTmux = value => `'${value.replaceAll("'", "'\\''")}'`;
export function tmuxGuardCondition(binding, kind) {
  const [pid, start] = binding.serverGeneration.split(':');
  const id = kind === 'session' ? binding.tmuxSessionId : binding.paneId;
  const field = kind === 'session' ? 'session_id' : 'pane_id';
  return `#{&&:#{==:#{pid},${pid}},#{&&:#{==:#{start_time},${start}},#{==:#{${field}},${id}}}}`;
}
export const tmuxGuardAction = commands => 'display-message -p ZYLOS_OK ; ' + commands.map(argv => argv.map(quoteTmux).join(' ')).join(' ; ');
export const formatLiteral = value => String(value).replace(/[#,}]/g, char => `#{a:${char.charCodeAt(0)}}`);
export function launchFormat(runId, launchConfig, sessionGroup) {
  const equal = (key, value) => `#{==:#{${key}},${formatLiteral(value)}}`;
  return [TMUX_FORMAT.generation, TMUX_FORMAT.sessionId, TMUX_FORMAT.paneId, TMUX_FORMAT.panePid, '#{session_created}',
    equal('ZYLOS_RUN_ID', runId), equal('ZYLOS_MODEL_CONFIG', JSON.stringify(launchConfig)),
    equal('ZYLOS_SESSION_GROUP', sessionGroup ?? '')].join('\t');
}
export const parseLaunchAddress = receipt => receipt?.match(/^(\d+:\d+)\t(\$\d+)\t(%\d+)\t/);
export const parseLaunchReceipt = receipt => receipt.match(/^(\d+:\d+)\t(\$\d+)\t(%\d+)\t(\d+)\t(\d+)\t([01])\t([01])\t([01])$/);
export const parseExecReceipt = output => output.match(/^(\$\d+)\t(%\d+)\t([01])\t([^\t\r\n]*)$/);
export const validGeneration = value => /^\d+:\d+$/.test(value);
export const validSessionId = value => /^\$\d+$/.test(value);
export const validPaneId = value => /^%\d+$/.test(value);

export function parseTargetObservation(output, pinned) {
  if (!output.trim()) return null;
  const [generation, tmuxSessionId, paneId, created] = output.split('\t');
  if (!pinned && validGeneration(generation) && tmuxSessionId === '' && paneId === '' && created === '') return null;
  if (!validGeneration(generation) || !validSessionId(tmuxSessionId) || !validPaneId(paneId) || !/^\d+$/.test(created)) {
    throw tmuxError('TMUX_UNAVAILABLE', 'Invalid tmux object identity', 'error');
  }
  return {generation, tmuxSessionId, paneId, created};
}

export function parseGuardResponse(output, error, generation) {
  const end = output.indexOf('\n');
  const first = end === -1 ? output : output.slice(0, end).replace(/\r$/, '');
  if (first === 'ZYLOS_OK') {
    if (error?.code === 'TMUX_NO_SERVER') error.code = 'TMUX_COMMAND_FAILED';
    if (error) throw error;
    return end === -1 ? '' : output.slice(end + 1);
  }
  const stale = first.match(/^ZYLOS_STALE (\d+:\d+)$/);
  if (stale && !error) throw tmuxError(stale[1] === generation ? 'TARGET_GONE' : 'GENERATION_CHANGED', 'tmux target guard rejected the operation');
  if (error?.code === 'TMUX_NO_SERVER') throw tmuxError('TARGET_GONE', 'tmux server is absent');
  if (error) throw error;
  throw tmuxError('TMUX_UNAVAILABLE', 'Invalid tmux guard response', 'error');
}

/** Decode show-environment -s as data; never evaluate its shell source. */
export function parseTmuxEnvironment(text) {
  const result = {};
  let offset = 0;
  while (offset < text.length) {
    const head = text.slice(offset).match(/^([^=\n]+)="/);
    if (!head) {
      const unset = text.slice(offset).match(/^unset ([^=\n]+);(?:\n|$)/);
      if (!unset) throw tmuxError('TMUX_RESPONSE_INVALID', 'Invalid tmux environment record');
      delete result[unset[1]];
      offset += unset[0].length;
      continue;
    }
    const name = head[1];
    offset += head[0].length;
    let value = '', closed = false;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') { closed = true; break; }
      if (char !== '\\') { value += char; continue; }
      let count = 1;
      while (text[offset] === '\\') { count++; offset++; }
      const next = text[offset];
      // -s doubles literal backslashes and escapes every dollar once. 3.4's
      // print layer adds one more slash before $[A-Za-z_{], so parity identifies
      // that extra byte without confusing a literal backslash with transport.
      if (next === '$') {
        value += '\\'.repeat(Math.floor((count - 1) / 2)) + '$'; offset++; continue;
      }
      value += '\\'.repeat(Math.floor(count / 2));
      if (count % 2 === 0) continue;
      if (next === '"' || next === '`') { value += next; offset++; continue; }
      const control = { n:'\n', r:'\r', b:'\b', a:'\x07', v:'\v', f:'\f', t:'\t', s:' ' };
      if (Object.hasOwn(control, next)) { value += control[next]; offset++; continue; }
      const octal = text.slice(offset).match(/^[0-7]{3}/);
      if (octal) { value += String.fromCharCode(parseInt(octal[0], 8)); offset += 3; continue; }
      throw tmuxError('TMUX_RESPONSE_INVALID', 'Invalid tmux environment escape');
    }
    const suffix = `; export ${name};`;
    if (!closed || !text.startsWith(suffix, offset)) throw tmuxError('TMUX_RESPONSE_INVALID', 'Invalid tmux environment record');
    offset += suffix.length;
    if (text[offset] === '\n') offset++;
    else if (offset !== text.length) throw tmuxError('TMUX_RESPONSE_INVALID', 'Invalid tmux environment separator');
    result[name] = value;
  }
  return result;
}

export function parseTmuxVersion(output) {
  const match = String(output).trim().match(/^tmux ((?:next-)?(\d+)\.(\d+)[a-z]*)(?:[-\s].*)?$/i);
  if (!match) return { version: 'unknown', useClientFlag: false, reason: 'unrecognized tmux -V output' };
  const major = Number(match[2]);
  const minor = Number(match[3]);
  return { version: match[1], major, minor,
    useClientFlag: major > 3 || (major === 3 && minor >= 4), reason: null };
}

export function parseLegacyPanePid(output) {
  const pid = parseInt(output.trim().split('\n')[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

export function parseGroupSessionRows(output, groupFromTmuxName) {
  const result = [];
  for (const line of String(output).split('\n')) {
    if (!line) continue;
    const [tmuxName, timestamp, ...extra] = line.split('\t');
    const sessionGroup = groupFromTmuxName(tmuxName);
    if (sessionGroup === null) continue;
    if (extra.length || !/^\d+$/.test(timestamp || '') || !Number.isSafeInteger(Number(timestamp))) {
      throw tmuxError('TMUX_RESPONSE_INVALID', 'Invalid tmux session creation timestamp');
    }
    result.push({ sessionGroup, tmuxName, createdAt: Number(timestamp) });
  }
  return result;
}
