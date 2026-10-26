import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// A private socket for every fixture; never targets the user's tmux server.
export function isolatedTmux(t, { prefix = 'test-tmux-', parentDir = os.tmpdir(),
  socketName = 's', tmuxArgs = [], timeout = 3000, trim = true,
  env, beforeCleanup = () => {} } = {}) {
  const dir = fs.mkdtempSync(path.join(parentDir, prefix));
  const socketPath = path.join(dir, socketName);
  const binary = process.env.TEST_TMUX_BIN || 'tmux';
  const tmux = (...args) => {
    const output = execFileSync(binary, [...tmuxArgs, '-S', socketPath, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env,
    });
    return trim ? output.trim() : output;
  };
  t.after(async () => {
    try { await beforeCleanup(); }
    finally {
      try { tmux('kill-server'); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return { dir, socketPath, binary, tmux,
    waitForServerExit: options => waitForServerExit({ binary, socketPath, ...options }) };
}

// kill-server acknowledges the request before the server has closed its socket.
// Observe actual absence before creating a replacement on the same socket.
export async function waitForServerExit({ binary, socketPath, timeoutMs = 5000 }) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = spawnSync(binary, ['-u', '-S', socketPath, '-N', 'list-sessions'], {
      encoding: 'utf8', timeout: Math.max(1, Math.ceil(deadline - performance.now())),
    });
    if (result.error) throw result.error;
    if (result.status === 1 && /^(?:no server running(?: on .*)?|error connecting[^\n]*No such file[^\n]*)\r?$/m.test(result.stderr.trim())) return;
    if (result.status !== 0 && !/^server exited unexpectedly\r?$/m.test(result.stderr.trim())) {
      throw new Error(`Unexpected tmux exit probe: ${result.stderr.trim()}`);
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for the isolated tmux server to exit');
}

// CLI consumers resolve `tmux` on PATH instead of accepting a binary option.
export function tmuxClientEnv({dir,socketPath,binary}, env = process.env) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const executable = execFileSync('sh', ['-c', 'command -v "$1"', 'sh', binary], {encoding:'utf8'}).trim();
  fs.symlinkSync(executable, path.join(binDir, 'tmux'));
  return {...env, PATH:`${binDir}${path.delimiter}${env.PATH || ''}`,
    TMUX_TMPDIR:dir, TMUX:`${socketPath},0,0`};
}
