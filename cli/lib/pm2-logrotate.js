/**
 * PM2 log rotation for every PM2-managed Zylos process.
 *
 * Init and Core self-upgrade make sure the pm2-logrotate module is present in
 * the current PM2_HOME. An existing module and all of its settings are left
 * untouched; only a missing module is configured and installed. Failure never
 * fails the caller: it returns a warning that names a command to run later.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const LOG_ROTATE_MODULE = 'pm2-logrotate';

// Size is checked every workerInterval seconds, so a file can grow past
// max_size between checks; it is a rotation threshold, not a hard cap.
export const LOG_ROTATE_DEFAULTS = Object.freeze([
  ['max_size', '10M'],
  ['retain', '7'],
  ['compress', 'true'],
  ['workerInterval', '30'],
  ['rotateInterval', '0 0 * * *'],
]);

export const LOG_ROTATE_TIMEOUTS = Object.freeze({ set: 20_000, install: 180_000 });

const OUTPUT_LIMIT = 64 * 1024;

function shellArgument(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function setArguments([key, value]) {
  return ['set', `${LOG_ROTATE_MODULE}:${key}`, value];
}

/** Copyable command that applies the defaults and installs the module. */
export function logRotateInstallCommand() {
  return [...LOG_ROTATE_DEFAULTS.map(setArguments), ['install', LOG_ROTATE_MODULE]]
    .map(args => ['pm2', ...args].map(shellArgument).join(' '))
    .join(' && ');
}

/** Same PM2 home the spawned `pm2` resolves: PM2_HOME, else its home's .pm2. */
export function resolvePm2Home(env = process.env) {
  return env.PM2_HOME || path.resolve(env.HOME || os.homedir(), '.pm2');
}

/**
 * Reads PM2's own module database, the record `pm2 install` checks before
 * deciding a module is already installed. Returns true, false, or throws when
 * the database exists but cannot be read.
 */
export function isLogRotateInstalled(pm2Home) {
  let text;
  try {
    text = fs.readFileSync(path.join(pm2Home, 'module_conf.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const conf = text.trim() ? JSON.parse(text) : {};
  return [conf?.['module-db-v2'], conf?.['tar-modules']]
    .some(db => db && typeof db === 'object' && Object.hasOwn(db, LOG_ROTATE_MODULE));
}

/**
 * Runs `pm2 <args>` in its own process group so a timeout also stops npm
 * started by `pm2 install`. Resolves {ok, code, signal, timedOut, stderr}.
 */
export function runPm2(args, { timeoutMs, env = process.env, command = 'pm2' } = {}) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    let stderr = '';
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({ stderr: stderr.trim(), ...result });
    };
    try {
      child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ ok: false, code: null, signal: null, timedOut: false, error: error.message });
      return;
    }
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-OUTPUT_LIMIT); });
    child.on('error', error => finish({ ok: false, code: null, signal: null, timedOut: false, error: error.message }));
    // Wait for buffered stderr, but never for a descendant that keeps the pipe open.
    let exited;
    child.on('exit', (code, signal) => {
      exited = { ok: code === 0, code, signal, timedOut: false };
      setTimeout(() => finish(exited), 1000);
    });
    child.on('close', () => { if (exited) finish(exited); });
    timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, code: null, signal: 'SIGKILL', timedOut: true });
    }, timeoutMs);
  });
}

function failureReason(args, result, timeoutMs) {
  const command = `pm2 ${args[0]}`;
  if (result.timedOut) return `${command} did not finish within ${Math.round(timeoutMs / 1000)} s`;
  if (result.error) return `${command} could not run: ${result.error}`;
  const detail = result.stderr ? `: ${result.stderr.split('\n').filter(Boolean).at(-1)}` : '';
  return `${command} exited with ${result.code ?? result.signal}${detail}`;
}

/** One-line warning for a missing module, with the command that installs it. */
export function logRotateFailureWarning(reason) {
  return `PM2 log rotation is not installed (${reason}). PM2 logs of Zylos services and components will not be rotated automatically. `
    + `Install it later with: ${logRotateInstallCommand()}`;
}

/**
 * Ensures pm2-logrotate exists in the current PM2_HOME.
 * Result state: 'present' (left untouched), 'installed', or 'failed' with a
 * one-line `warning`. Never throws and never restarts other PM2 processes.
 */
export async function ensurePm2LogRotate({
  env = process.env,
  pm2Home = resolvePm2Home(env),
  run = runPm2,
  timeouts = LOG_ROTATE_TIMEOUTS,
} = {}) {
  try {
    if (isLogRotateInstalled(pm2Home)) return { state: 'present' };
  } catch (error) {
    const warning = `Could not read PM2 module records in ${path.join(pm2Home, 'module_conf.json')} (${error.message}); `
      + `pm2-logrotate was not installed or changed. If \`pm2 ls\` does not list ${LOG_ROTATE_MODULE}, PM2 logs are not rotated automatically; `
      + `install it with: ${logRotateInstallCommand()}`;
    return { state: 'failed', warning };
  }
  const steps = [...LOG_ROTATE_DEFAULTS.map(entry => [setArguments(entry), timeouts.set]),
    [['install', LOG_ROTATE_MODULE], timeouts.install]];
  for (const [args, timeoutMs] of steps) {
    let result;
    try { result = await run(args, { timeoutMs, env }); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (!result?.ok) return { state: 'failed', warning: logRotateFailureWarning(failureReason(args, result || {}, timeoutMs)) };
  }
  let recorded = false;
  try { recorded = isLogRotateInstalled(pm2Home); } catch {}
  if (!recorded) return { state: 'failed', warning: logRotateFailureWarning(`pm2 install finished but PM2 has no ${LOG_ROTATE_MODULE} module record`) };
  return { state: 'installed' };
}

export function describeLogRotateDefaults() {
  return LOG_ROTATE_DEFAULTS.map(([key, value]) => `${key}=${value}`).join(', ');
}
