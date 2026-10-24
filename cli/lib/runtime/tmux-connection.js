import { spawn } from 'node:child_process';
import { tmuxClientArgs } from './tmux-client-args.js';

export function tmuxError(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

// Quote for tmux's command parser, not a shell. Newlines cannot create commands.
function quote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw new TypeError('Invalid tmux argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** One short-lived control client. Never reconnects, including after socket reuse. */
export async function openTmuxConnection({ socketPath, socketName, sessionName, timeoutMs = 3000, binary = 'tmux' } = {}) {
  const args = [...tmuxClientArgs({ socketPath, socketName }), '-N', '-C', 'attach-session', '-f', 'ignore-size,no-output', ...(sessionName ? ['-t', `=${sessionName}`] : [])];
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let dead = false, buffer = '', stderr = '', frame = null, pending = null, queue = Promise.resolve();
  let initialResolve, initialReject;
  const initial = new Promise((resolve, reject) => { initialResolve = resolve; initialReject = reject; });
  let startupTimer;
  const acknowledgedSessionKills = new Set();
  const fatal = (error) => {
    if (dead) return;
    dead = true;
    clearTimeout(startupTimer);
    initialReject(error);
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill();
  };
  startupTimer = setTimeout(() => fatal(tmuxError('TMUX_UNAVAILABLE', 'tmux connection timed out', 'timeout')), timeoutMs);
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  child.on('error', error => fatal(tmuxError('TMUX_UNAVAILABLE', error.message, 'error')));
  child.stdin.on('error', error => fatal(tmuxError('TMUX_UNAVAILABLE', error.message, 'error')));
  child.on('close', () => {
    const code = /no server running|error connecting.*No such file|no sessions/.test(stderr) ? 'TMUX_NO_SERVER' : 'TMUX_UNAVAILABLE';
    fatal(tmuxError(code, stderr.trim() || 'tmux connection closed', 'error'));
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      if (line.startsWith('%begin ')) { frame = { id: line.slice(7), lines: [] }; continue; }
      if (frame && (line.startsWith('%end ') || line.startsWith('%error '))) {
        if (line.slice(line.indexOf(' ') + 1) !== frame.id) { fatal(tmuxError('TMUX_UNAVAILABLE', 'tmux frame mismatch', 'error')); return; }
        const result = frame.lines.join('\n'); frame = null;
        const error = line.startsWith('%error ') ? tmuxError('TMUX_COMMAND_FAILED', result || 'tmux command failed', 'error') : null;
        if (initialResolve) {
          clearTimeout(startupTimer);
          if (error) {
            const code = /no sessions|no server running/.test(error.message) ? 'TMUX_NO_SERVER' : /can.t find session/.test(error.message) ? 'TARGET_GONE' : 'TMUX_UNAVAILABLE';
            initialReject(tmuxError(code, error.message, 'error'));
          } else initialResolve();
          initialResolve = null;
        } else if (pending) {
          const p = pending; pending = null; clearTimeout(p.timer);
          // A successful kill of an exact object ID is positive removal evidence,
          // even when killing the final session immediately closes this client.
          if (!error && p.argv.length === 3 && p.argv[0] === 'kill-session' && p.argv[1] === '-t' && /^\$\d+$/.test(p.argv[2])) {
            acknowledgedSessionKills.add(p.argv[2]);
          }
          error ? p.reject(error) : p.resolve(result);
        }
        continue;
      }
      if (frame) frame.lines.push(line);
      // %exit precedes process close; keep stderr diagnostics for classification.
    }
  });
  const connection = {
    get closed() { return dead; },
    didAcknowledgeSessionKill(sessionId) { return acknowledgedSessionKills.has(sessionId); },
    command(argv) {
      let command, commandArgv;
      try {
        if (!Array.isArray(argv) || !argv.length) throw new TypeError('Expected tmux argv');
        commandArgv = [...argv];
        command = commandArgv.map(quote).join(' ') + '\n';
      } catch (error) { return Promise.reject(error); }
      const result = queue.then(() => {
        if (dead) throw tmuxError('TMUX_UNAVAILABLE', 'tmux connection is closed', 'error');
        return new Promise((resolve, reject) => {
          pending = { argv: commandArgv, resolve, reject, timer: setTimeout(() => fatal(tmuxError('TMUX_UNAVAILABLE', 'tmux command timed out', 'timeout')), timeoutMs) };
          child.stdin.write(command);
        });
      });
      queue = result.catch(() => {});
      return result;
    },
    close() { clearTimeout(startupTimer); fatal(tmuxError('TMUX_UNAVAILABLE', 'tmux connection closed', 'error')); },
  };
  try {
    await initial;
    Object.defineProperty(connection, 'serverGeneration', { value: await serverGeneration(connection), enumerable: true });
    return connection;
  } catch (error) { connection.close(); throw error; }
}

/** Read only on the caller's held connection; never reopen by socket name. */
export async function serverGeneration(connection) {
  const value = (await connection.command(['display-message', '-p', '#{pid}:#{start_time}'])).trim();
  if (!/^\d+:\d+$/.test(value)) throw tmuxError('TMUX_UNAVAILABLE', 'tmux server generation unavailable', 'error');
  return value;
}
