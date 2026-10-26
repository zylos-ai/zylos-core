import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectConfigLockCapability, configLockArgs } from '../config-lock.js';

const WORKER = fileURLToPath(new URL('./codex-trust-worker.js', import.meta.url));

// Each worker gets the launch environment without mutating the parent process.
// The lock covers marker revalidation, feature/config writes and marker commit.
// Its scope is the global Codex home, shared by groups and Zylos instances.
export async function ensureLaunchHooksTrusted({ zylosDir, projectDir = zylosDir,
  codexBin = 'codex', env = process.env }) {
  const capability = detectConfigLockCapability({ env });
  if (!capability) throw new Error('Codex hook trust failed: kernel lock unavailable');
  const homeDir = env.HOME || os.homedir();
  const requestedHome = path.resolve(projectDir, env.CODEX_HOME || path.join(homeDir, '.codex'));
  fs.mkdirSync(requestedHome, { recursive: true, mode: 0o700 });
  const codexHome = fs.realpathSync(requestedHome);
  const lockFile = path.join(codexHome, 'zylos-hooks-trust.lock');
  const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Codex hook trust lock is not a regular file');
    // Reuse the existing kernel-lock backend, but never its fail-open JSON store.
    // The worker's version query and app-server calls already have timeouts.
    const args = configLockArgs(capability, 30_000, [process.execPath, WORKER,
      JSON.stringify({ zylosDir, projectDir, codexBin, homeDir, codexHome })]);
    await new Promise((resolve, reject) => {
      const child = spawn(capability.executable, args, {
        env, cwd: projectDir, stdio: ['ignore', 'ignore', 'pipe', fd],
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
  } catch (cause) {
    throw new Error('Codex hook trust failed before runtime launch', { cause });
  } finally {
    fs.closeSync(fd);
  }
}
