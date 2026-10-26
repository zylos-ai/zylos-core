import { spawn } from 'node:child_process';
import { tmuxClientArgs } from './tmux-client-args.js';
import { tmuxError, validateTmuxArgv as validateArgv, noServer, TMUX_COMMAND as C,
  TMUX_FORMAT as F, tmuxGuardCondition, tmuxGuardAction, validGeneration, validSessionId,
  validPaneId, unavailableCommand, parseGuardResponse } from './tmux-protocol.js';
export { tmuxError } from './tmux-protocol.js';

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
    finally { active.delete(controller); }
  };
  const connection = {
    get closed() { return closed; },
    get binding() { return binding; },
    async cleanupBuffer(name) {
      if (!/^zylos-[0-9a-f-]{36}$/.test(name)) throw new TypeError('Invalid private buffer name');
      // A private buffer belongs to the send, not its pane. Cleanup must still
      // run after the pane disappears or the caller closes this executor.
      await runTmuxCommand([C.deleteBuffer, '-b', name], {
        ...options, noServerStart: true, signal: undefined,
      });
    },
    bindTarget(target) {
      const candidate = { serverGeneration: target.serverGeneration, tmuxSessionId: target.tmuxSessionId,
        paneId: target.paneId, tmuxName: target.tmuxName };
      if (!validGeneration(candidate.serverGeneration) || !validSessionId(candidate.tmuxSessionId) || !validPaneId(candidate.paneId)) {
        throw new TypeError('Invalid tmux target binding');
      }
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
      const id = kind === 'session' ? binding.tmuxSessionId : binding.paneId;
      const condition = tmuxGuardCondition(binding, kind);
      const action = tmuxGuardAction(commands);
      let output, error;
      try { output = await execute([C.ifShell, '-F', '-t', id, condition, action, F.stale], timeoutMs); }
      catch (caught) {
        error = caught; output = caught.stdout ?? '';
      }
      return parseGuardResponse(output, error, binding.serverGeneration);
    },
    close() { closed = true; for (const controller of active) controller.abort(); },
  };
  return connection;
}

export async function serverGeneration(connection) {
  let value;
  try { value = (await connection.command([C.displayMessage, '-p', F.generation])).trim(); }
  catch (error) {
    throw unavailableCommand(error);
  }
  if (!validGeneration(value)) throw tmuxError('TMUX_UNAVAILABLE', 'tmux server generation unavailable', 'error');
  return value;
}
