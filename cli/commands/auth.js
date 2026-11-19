import { spawn as spawnChild } from 'node:child_process';
import { findRuntime, SUPPORTED_RUNTIMES } from '../lib/runtime/index.js';
import { UNSUPPORTED } from '../lib/runtime/contract.js';
import { notifyAuthCompleted } from '../lib/am-sock-client.js';

export function runNativeAuth(command, args) {
  return new Promise(resolve => {
    let cancelled = false;
    const child = spawnChild(command, args, { stdio: ['inherit', 2, 2] });
    const interrupt = () => { cancelled = true; child.kill('SIGINT'); };
    process.on('SIGINT', interrupt);
    const finish = result => {
      process.removeListener('SIGINT', interrupt);
      resolve(cancelled ? { signal: 'SIGINT' } : result);
    };
    child.once('error', error => finish({ error }));
    child.once('close', (status, signal) => finish({ status, signal }));
  });
}

export async function executeAuth(args, { findRuntime: lookupRuntime = findRuntime, spawn = runNativeAuth,
  notifyRecovery = notifyAuthCompleted } = {}) {
  const runtime = args[0];
  const deviceCode = args.includes('--device-code');
  const rt = runtime ? await lookupRuntime(runtime) : null;
  const login = rt?.auth.nativeLogin;
  const invalid = args.slice(1).some(arg => !['--json', '--device-code'].includes(arg)) ||
    ['--json', '--device-code'].some(flag => args.filter(arg => arg === flag).length > 1) ||
    (deviceCode && (!login || login === UNSUPPORTED || !login.deviceArgs));
  if (!runtime || invalid) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Usage: zylos auth <runtime> [--device-code (codex)] [--json]', persisted: [] } };
  if (!SUPPORTED_RUNTIMES.includes(runtime)) return { ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: 'Unsupported runtime', persisted: [] } };
  const command = rt.identity.findExecutable();
  if (command === null) return { ok: false, error: { code: 'RUNTIME_NOT_INSTALLED', message: 'Run zylos init first', persisted: [] } };
  try {
    const result = login === UNSUPPORTED
      ? { status: 0 }
      : await spawn(command, deviceCode ? login.deviceArgs : login.args);
    if (result.signal || result.status === 130) return { ok: false, error: { code: 'AUTH_CANCELLED', message: 'Authentication cancelled', persisted: null, configChanged: false } };
    if (result.error || result.status !== 0) throw new Error('Native authentication failed');
    let checked;
    try { checked = await rt.auth.checkAuth(); }
    catch { checked = { status: 'uncertain' }; }
    if (checked.status !== 'success') {
      const warnings = rt.auth.overrideWarnings === UNSUPPORTED ? [] : rt.auth.overrideWarnings({ against: 'probe' });
      return { ok: false, error: { code: checked.status === 'failure' ? 'AUTH_FAILED' : 'AUTH_NOT_CONFIRMED',
        message: `Authentication was not confirmed; ${rt.auth.remedy}`, persisted: null, configChanged: false,
        ...(warnings.length ? { warnings } : {}) } };
    }
    let relay = [];
    if (rt.auth.afterLogin !== UNSUPPORTED) {
      const after = await rt.auth.afterLogin();
      if (!after.ok) {
        return { ok: false, error: { code: 'CREDENTIAL_SAVE_FAILED',
          message: after.message, persisted: null, configChanged: false } };
      }
      relay = after.warnings;
    }
    const override = rt.auth.overrideWarnings === UNSUPPORTED ? [] : rt.auth.overrideWarnings({ against: 'saved' });
    let recoveryNotified = false;
    try { recoveryNotified = await notifyRecovery(runtime) === true; } catch {}
    return { ok: true, data: { runtime, authStatus: 'success', recoveryNotified, warnings: [...relay, ...override] } };
  } catch (error) { return { ok: false, error: { code: 'AUTH_FAILED', message: error.message, persisted: null, configChanged: false } }; }
}

export async function authCommand(args, dependencies) {
  const result = await executeAuth(args, dependencies);
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else if (result.ok) {
    console.log(`OK: ${result.data.runtime} authenticated`);
    for (const warning of result.data.warnings) console.error(`Warning [${warning.code}]: ${warning.message}`);
    if (!result.data.recoveryNotified) console.log('Recovery will resume on the next message or when the cooldown expires.');
  }
  else {
    for (const warning of result.error.warnings ?? []) console.error(`Warning [${warning.code}]: ${warning.message}`);
    console.error(`Error [${result.error.code}]: ${result.error.message}`);
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}
