import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectConfigLockCapability, configLockArgs } from '../../config-lock.js';
import { ZYLOS_DIR } from '../../config.js';
import { buildKickPrompt } from '../kick-prompt.js';
import { adapterError, launchEnvironment, memoryMcpServerPath, runtimeExecutable } from '../session-command.js';

export const env = Object.freeze({
  fromDotenv: Object.freeze([]),
  fromDotenvOrProcess: Object.freeze([]),
  fixed: Object.freeze({}),
});
export const helpProbe = 'always';
export const promptPlacement = 'kick';
export const efforts = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export const overrideHelpFlags = Object.freeze(['--model']);

export function buildArgs(config, { root, help = '', bypassPermissions = true }) {
  const args = ['-c', 'tools.experimental_request_user_input.enabled=false',
    '-c', 'features.goals=false', '-c', 'features.apps=false'];
  if (/(?:^|\s)--no-daemon(?:\s|$)/m.test(help)) args.push('--no-daemon');
  if (bypassPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (config.mode === 'override') {
    args.push('--model', config.model, '-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`);
  }
  const memoryServer = {
    command: 'node', args: [memoryMcpServerPath(root)],
    env_vars: ['ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'ZYLOS_DIR'],
  };
  for (const [key, value] of Object.entries(memoryServer)) {
    args.push('-c', `mcp_servers.zylos-memory.${key}=${JSON.stringify(value)}`);
  }
  args.push(buildKickPrompt());
  return args;
}

const WORKER = fileURLToPath(new URL('./trust-worker.js', import.meta.url));

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
async function ensureLaunchHooksTrusted({ zylosDir, projectDir = zylosDir,
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

export async function prepare(options = {}) {
  const env = options.env || process.env;
  const root = await fs.promises.realpath(options.root || ZYLOS_DIR);
  const codexBin = (options.runtimeExecutable || runtimeExecutable)('codex', env);
  // Trust must succeed before launch can create a tmux session.
  try {
    await ensureLaunchHooksTrusted({ zylosDir: root, projectDir: root,
      codexBin, env: launchEnvironment(root, env) });
  } catch (cause) {
    // Trust failing stops the launch, so Codex is not running: say so, with the trust step's own report.
    let reason = cause;
    while (reason?.cause instanceof Error) reason = reason.cause;
    const report = (reason?.message || 'hook trust failed').replace(/\.+$/, '');
    const message = `Codex did not start: ${report}. ` +
      'Hook trust must succeed before Codex starts and is tried again at the next launch; ' +
      'run `zylos init` to retry it now and see the result.';
    process.stderr.write(`${message}\n`);
    throw adapterError('LAUNCH_FAILED', message, cause);
  }
}
