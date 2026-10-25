import { spawnSync } from 'node:child_process';
import { getSessionAdapter, SUPPORTED_RUNTIMES } from '../lib/runtime/index.js';
import { commandExists } from '../lib/shell-utils.js';

export async function executeAuth(args, { exists = commandExists, adapter = getSessionAdapter, spawn = spawnSync } = {}) {
  const runtime = args[0];
  const invalid = args.slice(1).some(arg => arg !== '--json') || args.filter(arg => arg === '--json').length > 1;
  if (!runtime || invalid) return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Usage: zylos auth <runtime> [--json]', persisted: [] } };
  if (!SUPPORTED_RUNTIMES.includes(runtime)) return { ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: 'Unsupported runtime', persisted: [] } };
  if (!exists(runtime)) return { ok: false, error: { code: 'RUNTIME_NOT_INSTALLED', message: 'Run zylos init first', persisted: [] } };
  try {
    const result = spawn(runtime, runtime === 'claude' ? ['auth', 'login'] : ['login'], { stdio: ['inherit', 2, 2] });
    if (result.signal || result.status === 130) return { ok: false, error: { code: 'AUTH_CANCELLED', message: 'Authentication cancelled', persisted: null, configChanged: false } };
    if (result.error || result.status !== 0) throw new Error('Native authentication failed');
    let checked;
    try { checked = await adapter(runtime).checkAuth(); }
    catch { checked = { status: 'uncertain' }; }
    if (checked.status !== 'success') return { ok: false, error: { code: checked.status === 'failure' ? 'AUTH_FAILED' : 'AUTH_NOT_CONFIRMED',
      message: 'Authentication was not confirmed', persisted: null, configChanged: false } };
    return { ok: true, data: { runtime, authStatus: 'success' } };
  } catch (error) { return { ok: false, error: { code: 'AUTH_FAILED', message: error.message, persisted: null, configChanged: false } }; }
}

export async function authCommand(args) {
  const result = await executeAuth(args);
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else if (result.ok) console.log(`OK: ${result.data.runtime} authenticated`);
  else console.error(`Error [${result.error.code}]: ${result.error.message}`);
  if (!result.ok) process.exitCode = 1;
  return result;
}
