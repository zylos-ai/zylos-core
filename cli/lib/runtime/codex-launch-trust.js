import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./codex-trust-worker.js', import.meta.url));

// Keep synchronous trust work off the supervisor's event loop. Each worker gets
// the launch environment without mutating the parent process. Shared Codex
// config writes are intentionally not serialized and require no lock executable.
export async function ensureLaunchHooksTrusted({ zylosDir, projectDir = zylosDir,
  codexBin = 'codex', env = process.env }) {
  const homeDir = env.HOME || os.homedir();
  const codexHome = path.resolve(projectDir, env.CODEX_HOME || path.join(homeDir, '.codex'));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER,
      JSON.stringify({ zylosDir, projectDir, codexBin, homeDir, codexHome })], {
      env, cwd: projectDir, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostic = '', failure;
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2048); });
    child.on('error', error => { failure = error; });
    child.on('close', (code, signal) => {
      if (failure) reject(failure);
      else if (code === 0 && !signal) resolve();
      else reject(new Error(diagnostic.trim() || `Trust worker failed (${code ?? signal})`));
    });
  });
}
