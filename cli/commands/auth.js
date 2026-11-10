import { spawn as spawnChild } from 'node:child_process';
import { getSessionAdapter, SUPPORTED_RUNTIMES } from '../lib/runtime/index.js';
import { commandExists } from '../lib/shell-utils.js';
import { notifyAuthCompleted } from '../lib/am-sock-client.js';
import { claudeSettingsOverrideNotice, relayLoginNotice, syncClaudeRelayTraffic } from '../lib/runtime-setup.js';

export function runNativeAuth(runtime, args) {
  return new Promise(resolve => {
    let cancelled = false;
    const child = spawnChild(runtime, args, { stdio: ['inherit', 2, 2] });
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

export async function executeAuth(args, { exists = commandExists, adapter = getSessionAdapter, spawn = runNativeAuth,
  notifyRecovery = notifyAuthCompleted, syncRelayTraffic = syncClaudeRelayTraffic, relayNotice = relayLoginNotice } = {}) {
  const runtime = args[0];
  const deviceCode = args.includes('--device-code');
  const invalid = args.slice(1).some(arg => !['--json', '--device-code'].includes(arg)) ||
    ['--json', '--device-code'].some(flag => args.filter(arg => arg === flag).length > 1) ||
    (deviceCode && runtime !== 'codex');
  if (!runtime || invalid) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Usage: zylos auth <runtime> [--device-code (codex)] [--json]', persisted: [] } };
  if (!SUPPORTED_RUNTIMES.includes(runtime)) return { ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: 'Unsupported runtime', persisted: [] } };
  if (!exists(runtime)) return { ok: false, error: { code: 'RUNTIME_NOT_INSTALLED', message: 'Run zylos init first', persisted: [] } };
  try {
    const result = await spawn(runtime, runtime === 'claude' ? ['auth', 'login'] : ['login', ...(deviceCode ? ['--device-auth'] : [])], { stdio: ['inherit', 2, 2] });
    if (result.signal || result.status === 130) return { ok: false, error: { code: 'AUTH_CANCELLED', message: 'Authentication cancelled', persisted: null, configChanged: false } };
    if (result.error || result.status !== 0) throw new Error('Native authentication failed');
    let checked;
    try { checked = await adapter(runtime).checkAuth(); }
    catch { checked = { status: 'uncertain' }; }
    if (checked.status !== 'success') return { ok: false, error: { code: checked.status === 'failure' ? 'AUTH_FAILED' : 'AUTH_NOT_CONFIRMED',
      message: 'Authentication was not confirmed', persisted: null, configChanged: false } };
    // Subscription login: recompute the relay traffic setting from the saved state before the session restarts.
    if (runtime === 'claude' && !syncRelayTraffic()) {
      return { ok: false, error: { code: 'CREDENTIAL_SAVE_FAILED',
        message: 'Authenticated, but CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC could not be updated', persisted: null, configChanged: false } };
    }
    const relay = runtime === 'claude' ? relayNotice() : null;
    // settings.json values that would override the recomputed setting (read only).
    const override = runtime === 'claude' ? claudeSettingsOverrideNotice() : null;
    let recoveryNotified = false;
    try { recoveryNotified = await notifyRecovery(runtime) === true; } catch {}
    return { ok: true, data: { runtime, authStatus: 'success', recoveryNotified,
      warnings: [...(relay ? [{ code: 'RELAY_BASE_URL_KEPT', message: relay }] : []),
        ...(override ? [{ code: 'CLAUDE_SETTINGS_OVERRIDE', message: override }] : [])] } };
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
  else console.error(`Error [${result.error.code}]: ${result.error.message}`);
  if (!result.ok) process.exitCode = 1;
  return result;
}
