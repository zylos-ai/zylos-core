import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_STDOUT_BYTES = 1024 * 1024;

/** One Node timer segment; the caller recomputes the remaining monotonic time. */
export function hookTimerChunk(remainingMs) {
  return Math.min(remainingMs, MAX_TIMER_MS);
}

/** One synchronous hook invocation; stdin carries the already serialized input. */
export async function runHookProcess({ command, args = [], input, timeoutMs, cwd, env = process.env }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a finite positive number');
  if (typeof input !== 'string') throw new TypeError('input must be a serialized string');

  return new Promise(resolve => {
    const started = performance.now();
    const output = [];
    let child, timer, stdoutBytes = 0, error = null, timedOut = false, outputTooLarge = false, settled = false;
    const grouped = process.platform !== 'win32';

    function terminate() {
      if (!child?.pid) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (cause) {
        if (cause.code !== 'ESRCH') error ??= cause;
      }
    }

    function finish(exitCode = null, signal = null) {
      if (settled) return;
      settled = true;
      // Close and timer callbacks may become runnable in the same event-loop
      // turn. A completed deadline wins regardless of callback ordering.
      timedOut ||= performance.now() - started >= timeoutMs;
      clearTimeout(timer);
      terminate();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ stdout: Buffer.concat(output, stdoutBytes).toString('utf8'), exitCode, signal, error, timedOut, outputTooLarge });
    }

    function deadline() {
      if (settled) return;
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining > 0) {
        // Node clamps larger timer delays to 1 ms. Rearm bounded chunks without
        // imposing a smaller maximum on the channel's declared timeout.
        timer = setTimeout(deadline, hookTimerChunk(remaining));
        return;
      }
      timedOut = true;
      terminate();
      // An inherited descriptor must not keep close pending after termination.
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }

    try {
      child = spawn(command, args, { cwd, env, shell: false, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (cause) {
      error = cause;
      finish();
      return;
    }
    child.once('error', cause => { error ??= cause; });
    child.stdout.on('data', chunk => {
      if (outputTooLarge) return;
      if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
        outputTooLarge = true;
        terminate();
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        return;
      }
      stdoutBytes += chunk.length;
      output.push(chunk);
    });
    // Hook stderr is not part of its result and may contain sensitive context.
    child.stderr.resume();
    child.stdin.on('error', cause => { if (cause.code !== 'EPIPE') error ??= cause; });
    child.once('exit', terminate);
    child.once('close', finish);
    deadline();
    if (!timedOut) child.stdin.end(input);
  });
}
