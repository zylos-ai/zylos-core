import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'dotenv';
import { withConfigLock } from './config-mutation.js';
import { createScheduleTz } from './workbench/schedule-tz.js';
import { loadCoreModule } from './core-modules.js';
import { readJsonBody, sendJson } from './http.js';
import { isSameOriginRequest } from './request-origin.js';

const { readConfigStrict } = await loadCoreModule('config-store.js');
const { createPm2Helpers } = await loadCoreModule('pm2.js');
const execAsync = promisify(exec);

export const INSTANCE_TIMEZONE_PATH = '/api/settings/timezone';
const SERVICES = [
  ['scheduler', 'scheduler/scripts/daemon.js'],
  ['web-console', 'web-console/scripts/server.js'],
  ['zylos-openmax', 'openmax/src/comm-bridge.js'],
];

class TimezoneSettingsError extends Error {
  constructor(error, status) { super(error); this.code = error; this.status = status; }
}
const fail = (error, status) => { throw new TimezoneSettingsError(error, status); };
function readableTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 128 || tz !== tz.trim() || /[\r\n\0]/.test(tz)) return false;
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

// Only writes require canonical IANA spelling. Existing read semantics, including
// the scheduler's validation and fallback, remain owned by the shared reader.
function writableTimezone(tz) {
  if (!readableTimezone(tz) || tz !== 'UTC' && !tz.includes('/')) return false;
  return new Intl.DateTimeFormat(undefined, { timeZone: tz }).resolvedOptions().timeZone === tz;
}

function samePath(left, right) {
  try { return typeof left === 'string' && fs.realpathSync(left) === fs.realpathSync(right); }
  catch { return false; }
}

/** Keep every byte outside the effective (last) TZ value, including quotes and comments. */
export function replaceTimezoneValue(text, tz) {
  if (!writableTimezone(tz)) fail('invalid_timezone', 400);
  // Follow dotenv's assignment grammar, retaining original offsets rather than
  // normalizing newlines. A quoted value can span lines and contain TZ text.
  const assignment = /^(\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?))(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/dmg;
  let selected;
  for (const match of text.matchAll(assignment)) {
    if (match[2] !== 'TZ') continue;
    const raw = match[3] || '';
    const trimmed = raw.trim();
    let start = match.indices[3]?.[0] ?? match.indices[1][1];
    start += raw.length - raw.trimStart().length;
    let end = start + trimmed.length;
    if (trimmed.length >= 2 && ['"', "'", '`'].includes(trimmed[0]) && trimmed.at(-1) === trimmed[0]) {
      start += 1; end -= 1;
    }
    selected = { start, end };
  }
  if (selected) return text.slice(0, selected.start) + tz + text.slice(selected.end);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return text + (text && !text.endsWith('\n') ? newline : '') + `TZ=${tz}${newline}`;
}

function readEnvironment(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('tz_env_read_error', 503);
    return fs.readFileSync(file, 'utf8');
  } catch { fail('tz_env_read_error', 503); }
}

async function writeEnvironment(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.promises.rename(temporary, file);
    const directory = await fs.promises.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

/** Service candidates are advisory; no applied-version ledger or restart on save. */
export function createInstanceTimezone({ zylosDir, readTimezone,
  readPm2 = () => null, restartService, execute = execAsync,
  log = message => process.stderr.write(`[timezone] ${message}\n`) } = {}) {
  const envFile = path.join(zylosDir, '.env');
  const configFile = path.join(zylosDir, '.zylos/config.json');
  const timezoneReader = readTimezone ?? createScheduleTz({ zylosDir });

  function policy() {
    const result = readConfigStrict(configFile);
    if (result.state === 'error' || result.state === 'ok' && Object.hasOwn(result.config, 'timezone_managed') &&
        typeof result.config.timezone_managed !== 'boolean') return 'config_unreadable';
    return result.state === 'ok' && result.config.timezone_managed === true ? 'timezone_managed' : null;
  }
  function requireWritable() {
    const reason = policy();
    if (reason) fail(reason === 'timezone_managed' ? 'timezone_managed' : reason, reason === 'timezone_managed' ? 409 : 503);
    return readEnvironment(envFile);
  }
  async function candidates() {
    let data;
    try { data = await readPm2(); } catch { data = null; }
    if (!Array.isArray(data?.processes)) return { restart_services: [], restart_status: 'unknown' };
    const restart_services = [];
    for (const [name, script] of SERVICES) {
      const expected = path.join(zylosDir, '.claude/skills', script);
      const matches = data.processes.filter(proc => proc?.name === name);
      if (matches.length !== 1) continue;
      const proc = matches[0], env = proc.pm2_env;
      if (env?.status !== 'online' || !samePath(env.pm_exec_path, expected)) continue;
      const ownedRoot = env.ZYLOS_DIR ?? env.env?.ZYLOS_DIR;
      const cwd = env.pm_cwd;
      const owned = ownedRoot !== undefined ? samePath(ownedRoot, zylosDir)
        : samePath(cwd, zylosDir) || samePath(cwd, path.dirname(expected)) ||
          samePath(cwd, path.join(zylosDir, '.claude/skills', script.split('/')[0]));
      if (owned) restart_services.push({ name, status: 'online' });
    }
    return { restart_services, restart_status: 'known' };
  }
  async function zone() {
    try {
      const value = await timezoneReader();
      const tz = typeof value === 'string' ? value : value?.tz;
      return readableTimezone(tz) ? tz : null;
    } catch { return null; }
  }
  async function get({ canWrite = true } = {}) {
    let reason = policy();
    try { readEnvironment(envFile); } catch { reason ||= 'tz_env_read_error'; }
    if (!canWrite) reason ||= 'read_only_access';
    return { tz: await zone(), writable: !reason, read_only_reason: reason, ...await candidates() };
  }
  async function save(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'tz') || !writableTimezone(body.tz)) fail('invalid_timezone', 400);
    let previous = null, changed = false;
    try {
      requireWritable();
      await withConfigLock(envFile, async () => {
        const text = requireWritable();
        const current = parse(text).TZ;
        previous = readableTimezone(current) ? current : null;
        changed = current !== body.tz;
        if (changed) await writeEnvironment(envFile, replaceTimezoneValue(text, body.tz));
        else await fs.promises.chmod(envFile, 0o600);
      });
    } catch (error) {
      if (error instanceof TimezoneSettingsError) throw error;
      fail('tz_write_failed', 500);
    }
    if (changed) log(`TZ saved: ${previous || '(unknown)'} -> ${body.tz}`);
    return { ok: true, changed, previous, ...await get() };
  }
  const restartOne = restartService || (async (name, tz) => {
    let execution;
    const helpers = createPm2Helpers({ exec: (command, options) => {
      execution = execute(command, {
        ...options, env: { ...process.env, ZYLOS_DIR: zylosDir, TZ: tz }, timeout: 15_000, killSignal: 'SIGKILL',
      });
      return execution;
    } });
    // Preserve the existing named restart/environment policy while keeping its
    // asynchronous completion and failure inside this request's lifecycle.
    helpers.restartManagedProcess(name, { updateEnv: true });
    await execution;
  });
  async function restart(body) {
    const restarted = [], failed = [];
    let remaining = [];
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true ||
          Object.keys(body).some(key => !['tz', 'confirm', 'services'].includes(key)) || !writableTimezone(body.tz) ||
          !Array.isArray(body.services) || body.services.length === 0 || body.services.length > SERVICES.length ||
          body.services.some(name => !SERVICES.some(([allowed]) => name === allowed)) ||
          new Set(body.services).size !== body.services.length) fail('confirmation_required', 400);
      // Until discovery succeeds, every confirmed service is still unattempted.
      remaining = body.services.map(name => ({ name, status: 'online' }));
      const current = parse(requireWritable()).TZ;
      if (current !== body.tz) fail('timezone_changed', 409);
      const discovery = await candidates();
      if (discovery.restart_status !== 'known') fail('service_discovery_unavailable', 503);
      remaining = discovery.restart_services.filter(service => body.services.includes(service.name));
      for (const { name } of [...remaining]) {
        // An asynchronous service restart must not apply a later edit without confirmation.
        const fresh = await candidates();
        if (fresh.restart_status !== 'known') fail('service_discovery_unavailable', 503);
        if (parse(requireWritable()).TZ !== body.tz) fail('timezone_changed', 409);
        if (!fresh.restart_services.some(service => service.name === name)) {
          remaining = remaining.filter(service => service.name !== name);
          continue;
        }
        try {
          await restartOne(name, body.tz); restarted.push(name);
          remaining = remaining.filter(service => service.name !== name);
        }
        catch { failed.push({ name, error: 'restart_failed' }); }
      }
      log(`TZ services restart: ${restarted.join(',') || '(none)'}${failed.length ? '; failed=' + failed.map(item => item.name).join(',') : ''}`);
      return { ok: failed.length === 0, status: 200, restarted, failed,
        restart_services: failed.map(({ name }) => ({ name, status: 'online' })), restart_status: 'known' };
    } catch (error) {
      if (error instanceof TimezoneSettingsError) return { ok: false, error: error.code, status: error.status, restarted, failed,
        restart_services: remaining, restart_status: error.code === 'service_discovery_unavailable' ? 'unknown' : 'known' };
      return { ok: false, error: 'restart_failed', status: 500, restarted, failed, restart_services: remaining, restart_status: 'unknown' };
    }
  }
  return { get, save, restart };
}

export async function handleInstanceTimezone(req, res, url, { auth, timezone }) {
  if (url.pathname !== INSTANCE_TIMEZONE_PATH) return false;
  const context = auth.resolveAuthContext(req);
  if (!context) { sendJson(res, 401, { error: 'authentication_required' }); return true; }
  if (req.method === 'GET') { sendJson(res, 200, await timezone.get({ canWrite: context?.scope === 'admin' })); return true; }
  if (req.method !== 'PUT') { sendJson(res, 405, { error: 'method_not_allowed' }); return true; }
  if (context?.scope !== 'admin') { sendJson(res, 403, { error: 'insufficient_scope', required: 'admin' }); return true; }
  if (context.kind === 'cookie' && !isSameOriginRequest(req)) { sendJson(res, 403, { error: 'same_origin_required' }); return true; }
  try { sendJson(res, 200, await timezone.save(await readJsonBody(req, 4096))); }
  catch (error) { sendJson(res, error.status || 400, { error: error.code || 'invalid_timezone' }); }
  return true;
}

/** The existing action path, with the same write proof as saving the setting. */
export async function handleInstanceTimezoneRestart(req, res, url, { auth, timezone, runAction } = {}) {
  if (url.pathname !== '/api/actions/restart-timezone-services' || req.method !== 'POST') return false;
  const context = auth.resolveAuthContext(req);
  if (context?.scope !== 'admin') { sendJson(res, 403, { error: 'insufficient_scope', required: 'admin' }); return true; }
  if (context.kind === 'cookie' && !isSameOriginRequest(req)) { sendJson(res, 403, { error: 'same_origin_required' }); return true; }
  let body;
  try { body = await readJsonBody(req, 4096); }
  catch (error) { sendJson(res, error.status || 400, { error: error.message }); return true; }
  const result = await (runAction ? runAction(body) : timezone.restart(body));
  sendJson(res, result.status || (result.ok ? 200 : 400), result);
  return true;
}
