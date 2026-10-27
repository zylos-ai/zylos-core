import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectConfigLockCapability, configLockArgs } from '../config-lock.js';

const WORKER = fileURLToPath(new URL('./codex-trust-worker.js', import.meta.url));

function runTrustWorker(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
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

// Keep synchronous trust work off the supervisor's event loop and preserve its
// environment. When available, the lock covers the entire shared-home trust
// transaction; missing lock tooling warns and still permits startup.
export async function ensureLaunchHooksTrusted({ zylosDir, projectDir = zylosDir,
  codexBin = 'codex', env = process.env }) {
  const capability = detectConfigLockCapability({ env });
  const homeDir = env.HOME || os.homedir();
  const requestedHome = path.resolve(projectDir, env.CODEX_HOME || path.join(homeDir, '.codex'));
  fs.mkdirSync(requestedHome, { recursive: true, mode: 0o700 });
  const codexHome = fs.realpathSync(requestedHome);
  const workerArgs = [WORKER, JSON.stringify({ zylosDir, projectDir, codexBin, homeDir, codexHome })];
  if (!capability) {
    process.stderr.write('Warning: Codex hook trust lock unavailable; continuing without concurrency protection.\n');
    await runTrustWorker(process.execPath, workerArgs, {
      env, cwd: projectDir, stdio: ['ignore', 'ignore', 'pipe'],
    });
    return;
  }
  const lockFile = path.join(codexHome, 'zylos-hooks-trust.lock');
  const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Codex hook trust lock is not a regular file');
    const args = configLockArgs(capability, 30_000, [process.execPath, ...workerArgs]);
    await runTrustWorker(capability.executable, args, {
      env, cwd: projectDir, stdio: ['ignore', 'ignore', 'pipe', fd],
    });
  } catch (cause) {
    throw new Error('Codex hook trust failed before runtime launch', { cause });
  } finally {
    fs.closeSync(fd);
  }
}
