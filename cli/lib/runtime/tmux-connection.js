import { spawn } from 'node:child_process';
import { tmuxClientArgs } from './tmux-client-args.js';

export function tmuxError(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) {
    throw new TypeError('Invalid tmux argv');
  }
}

// This quotes tmux command-parser tokens, never shell source or message text.
function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
const noServer = text => /^(?:no server running(?: on .*)?|no sessions|error connecting[^\n]*No such file[^\n]*)\r?$/m.test(text.trim());

/** One ordinary client; timeout/cancellation waits for its exit and releases pipes. */
export function runTmuxCommand(argv, { socketPath, socketName, binary = 'tmux', configFile,
  timeoutMs = 3000, noServerStart = true, signal } = {}) {
  validateArgv(argv);
  const args = [...tmuxClientArgs({ socketPath, socketName }), ...(noServerStart ? ['-N'] : []),
    ...(configFile ? ['-f', configFile] : []), ...argv];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure, settled = false;
    const stop = error => {
      failure ??= error;
      child.stdout.destroy(); child.stderr.destroy();
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const abort = () => stop(tmuxError('TMUX_UNAVAILABLE', 'tmux command cancelled', 'error'));
    const timer = setTimeout(() => stop(tmuxError('TMUX_UNAVAILABLE', 'tmux command timed out', 'timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    child.stdout.on('error', error => stop(tmuxError('TMUX_UNAVAILABLE', error.message, 'error')));
    child.stderr.on('error', error => stop(tmuxError('TMUX_UNAVAILABLE', error.message, 'error')));
    child.on('error', error => { failure ??= tmuxError('TMUX_UNAVAILABLE', error.message, 'error'); });
    child.on('close', (code, exitSignal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const output = stdout.replace(/\r?\n$/, '');
      if (!failure && (code !== 0 || stderr.trim())) {
        failure = tmuxError(noServer(stderr) ? 'TMUX_NO_SERVER' : 'TMUX_COMMAND_FAILED',
          stderr.trim() || `tmux command exited ${code ?? exitSignal}`, 'error');
      }
      if (failure) reject(Object.assign(failure, { stdout: output, stderr, exitCode: code }));
      else resolve(output);
    });
  });
}

/** A socket-scoped executor. Bound commands are checked inside the receiving server. */
export async function openTmuxConnection(options = {}) {
  let closed = false, binding = null;
  const active = new Set();
  const execute = async (argv, timeoutMs = options.timeoutMs) => {
    if (closed) throw tmuxError('TMUX_UNAVAILABLE', 'tmux executor is closed', 'error');
    const controller = new AbortController(); active.add(controller);
    try { return await runTmuxCommand(argv, { ...options, timeoutMs, noServerStart: true, signal: controller.signal }); }
    catch (error) {
      if (error.cause === 'timeout') connection.close();
      throw error;
    } finally { active.delete(controller); }
  };
  const connection = {
    get closed() { return closed; },
    get binding() { return binding; },
    async cleanupBuffer(name) {
      if (!/^zylos-[0-9a-f-]{36}$/.test(name)) throw new TypeError('Invalid private buffer name');
      // A private buffer belongs to the send, not its pane. Cleanup must still
      // run after the pane disappears or a command timeout closes this executor.
      await runTmuxCommand(['delete-buffer', '-b', name], {
        ...options, noServerStart: true, signal: undefined,
      });
    },
    bindTarget(target) {
      const candidate = { serverGeneration: target.serverGeneration, tmuxSessionId: target.tmuxSessionId,
        paneId: target.paneId, tmuxName: target.tmuxName };
      if (!/^\d+:\d+$/.test(candidate.serverGeneration) || !/^\$\d+$/.test(candidate.tmuxSessionId) || !/^%\d+$/.test(candidate.paneId)) {
        throw new TypeError('Invalid tmux target binding');
      }
      if (candidate.serverGeneration !== connection.serverGeneration) throw tmuxError('GENERATION_CHANGED', 'tmux server generation changed');
      if (binding && ['serverGeneration','tmuxSessionId','paneId'].some(key => binding[key] !== candidate[key])) {
        throw tmuxError('TARGET_GONE', 'Cannot replace a bound tmux target');
      }
      binding ??= Object.freeze(candidate);
      return binding;
    },
    async command(argv, options = {}) { return connection.commandBatch([argv], options); },
    async commandBatch(commands, { kind = 'pane', timeoutMs } = {}) {
      if (!Array.isArray(commands) || !commands.length) throw new TypeError('Expected tmux commands');
      for (const argv of commands) validateArgv(argv);
      if (!binding) {
        if (commands.length !== 1) throw new TypeError('Batch requires a bound target');
        return execute(commands[0], timeoutMs);
      }
      if (!['pane','session'].includes(kind)) throw new TypeError('Invalid guard target kind');
      const [pid, start] = binding.serverGeneration.split(':');
      const id = kind === 'session' ? binding.tmuxSessionId : binding.paneId;
      const field = kind === 'session' ? 'session_id' : 'pane_id';
      const condition = `#{&&:#{==:#{pid},${pid}},#{&&:#{==:#{start_time},${start}},#{==:#{${field}},${id}}}}`;
      const action = 'display-message -p ZYLOS_OK ; ' + commands.map(argv => argv.map(quote).join(' ')).join(' ; ');
      let output, error;
      try { output = await execute(['if-shell', '-F', '-t', id, condition, action, 'display-message -p "ZYLOS_STALE #{pid}:#{start_time}"'], timeoutMs); }
      catch (caught) {
        error = caught; output = caught.stdout ?? '';
      }
      const end = output.indexOf('\n');
      const first = end === -1 ? output : output.slice(0, end).replace(/\r$/, '');
      if (first === 'ZYLOS_OK') {
        if (error?.code === 'TMUX_NO_SERVER') error.code = 'TMUX_COMMAND_FAILED';
        if (error) throw error;
        return end === -1 ? '' : output.slice(end + 1);
      }
      const stale = first.match(/^ZYLOS_STALE (\d+:\d+)$/);
      if (stale && !error) throw tmuxError(stale[1] === binding.serverGeneration ? 'TARGET_GONE' : 'GENERATION_CHANGED', 'tmux target guard rejected the operation');
      if (error?.code === 'TMUX_NO_SERVER') throw tmuxError('TARGET_GONE', 'tmux server is absent');
      if (error) throw error;
      throw tmuxError('TMUX_UNAVAILABLE', 'Invalid tmux guard response', 'error');
    },
    close() { closed = true; for (const controller of active) controller.abort(); },
  };
  try {
    const value = (await connection.command(['display-message', '-p', '#{pid}:#{start_time}'])).trim();
    if (!/^\d+:\d+$/.test(value)) throw tmuxError('TMUX_UNAVAILABLE', 'tmux server generation unavailable', 'error');
    Object.defineProperty(connection, 'serverGeneration', { value, enumerable: true });
    return connection;
  } catch (error) {
    connection.close();
    if (error.code === 'TMUX_COMMAND_FAILED') throw tmuxError('TMUX_UNAVAILABLE', error.message, error.cause || 'error');
    throw error;
  }
}

export async function serverGeneration(connection) {
  let value;
  try { value = (await connection.command(['display-message', '-p', '#{pid}:#{start_time}'])).trim(); }
  catch (error) {
    if (error.code === 'TMUX_COMMAND_FAILED') throw tmuxError('TMUX_UNAVAILABLE', error.message, error.cause || 'error');
    throw error;
  }
  if (!/^\d+:\d+$/.test(value)) throw tmuxError('TMUX_UNAVAILABLE', 'tmux server generation unavailable', 'error');
  return value;
}
