import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readConfigStrict } from './config-store.js';
import { isCaddyAvailable } from './caddy.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name = 'zylos-dashboard';
const READY_LIMIT = 30000;
function locations(root) {
  const code = path.join(root, '.claude/skills/dashboard');
  const data = path.join(root, 'components/dashboard');
  return { code, data, db: path.join(data, 'dashboard.db'), config: path.join(data, 'config.json'), ecosystem: path.join(root, 'pm2/ecosystem.config.cjs') };
}
function settings(root) {
  const loc = locations(root);
  const config = fs.existsSync(loc.config) ? JSON.parse(fs.readFileSync(loc.config, 'utf8')) : {};
  const port = config.port ?? 3470;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid Dashboard port');
  return { ...loc, configValue: config, port };
}
function run(command, args, root, timeout = 30000) {
  return execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore','pipe','pipe'], env: { ...process.env, ZYLOS_DIR: root } });
}
function realOrResolved(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}
// PM2 keeps the path it was started with, which may go through a symlinked
// HOME or ZYLOS_DIR while the upgrade passes the real installation path.
function samePath(file, expected) {
  return path.resolve(file) === expected || realOrResolved(file) === realOrResolved(expected);
}
function matches(processes, loc) {
  const found = processes.filter(p => p.name === name);
  return found.length === 1 && found[0].pm2_env?.status === 'online'
    && samePath(found[0].pm2_env.pm_exec_path || '', path.join(loc.code, 'src/index.js'))
    && samePath(found[0].pm2_env.pm_cwd || '', loc.code);
}
function managedPid(processes, loc) {
  const found = processes.filter(p => p.name === name
    && samePath(p.pm2_env?.pm_exec_path || '', path.join(loc.code, 'src/index.js')));
  return found.length === 1 && Number.isInteger(found[0].pid) && found[0].pid > 0 ? found[0].pid : null;
}

export function copyDashboardDb(zylosDir, txDir) {
  try {
    const { db } = locations(zylosDir);
    if (!fs.existsSync(db)) {
      return { ok: true, error: null };
    }
    const target = path.join(txDir, 'dashboard/db-copy');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (fs.existsSync(db+suffix)) fs.copyFileSync(db+suffix, path.join(target, 'dashboard.db'+suffix));
    }
    return { ok: true, error: null };
  } catch (error) { return { ok: false, error: { code: 'db_copy_failed', message: error.message } }; }
}

const DASHBOARD_SCHEMA_SCRIPT = `const [schemaUrl, driverUrl, file, action] = process.argv.slice(1);
const { inspectDatabase, migrateDatabase } = await import(schemaUrl);
const { default: Database } = await import(driverUrl);
try {
  const db = new Database(file, { fileMustExist: true, timeout: 5000 });
  try {
    if (action === 'migrate') migrateDatabase(db);
    process.stdout.write(JSON.stringify(inspectDatabase(db)));
  } finally { db.close(); }
} catch (error) { process.stderr.write(String(error?.message ?? error)); process.exitCode = 1; }`;
function dashboardSchema(loc, root, action) {
  // Resolve like the Dashboard's own ESM imports do: from the real location of
  // its schema module, so a symlinked skill still finds the sibling SQLite driver.
  const schemaFile = fs.realpathSync(path.join(loc.code, 'src/lib/schema.js'));
  const driver = path.join(path.dirname(schemaFile), '../../../comm-bridge/scripts/sqlite-driver.js');
  let output;
  try {
    output = run(process.execPath, ['--input-type=module', '-e', DASHBOARD_SCHEMA_SCRIPT,
      pathToFileURL(schemaFile).href, pathToFileURL(driver).href, loc.db, action], root, 120000);
  } catch (error) {
    const detail = String(error.stderr || '').trim() || (error.code === 'ETIMEDOUT' ? 'timed out' : error.message);
    throw Error(`Dashboard schema ${action} failed: ${detail}`);
  }
  return JSON.parse(output);
}
function restoreDashboardCopy(loc, copy) {
  // A migration child that died leaves its WAL or hot journal behind; replayed
  // onto the restored file it would bring the half-done migration back.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const source = path.join(copy, 'dashboard.db' + suffix);
    if (fs.existsSync(source)) fs.copyFileSync(source, loc.db + suffix);
    else {
      // A sidecar the copy did not have must not be replayed onto the restored file.
      try { fs.unlinkSync(loc.db + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
// The worker skips a legacy standalone Dashboard database during the upgrade
// migration; the first takeover migrates it here, before the service starts.
// The copy taken at cutoff is the rollback material for a failed migration.
export function migrateTakeoverDashboardDb({ zylosDir, transactionDir }) {
  const loc = locations(zylosDir);
  if (!fs.existsSync(loc.db)) return { state: 'absent' };
  if (!dashboardSchema(loc, zylosDir, 'inspect').needsMigration) return { state: 'unchanged' };
  const copy = transactionDir ? path.join(transactionDir, 'dashboard/db-copy') : null;
  if (!copy || !fs.existsSync(path.join(copy, 'dashboard.db'))) throw Error('Legacy Dashboard database copy is missing; the database was not migrated');
  try {
    const state = dashboardSchema(loc, zylosDir, 'migrate');
    if (state.needsMigration) throw Error('Dashboard migration remains incomplete');
    return { state: 'migrated', version: state.currentVersion };
  } catch (error) {
    restoreDashboardCopy(loc, copy);
    throw Error(`Dashboard database migration failed; the database was restored from the takeover copy (${error.message})`);
  }
}

export function applyDashboardRegistration({ zylosDir, transactionDir }) {
  try {
    const loc = settings(zylosDir);
    // Core's service phase publishes the shared template and records creation
    // intent. Registration consumes that artifact without rewriting it.
    if (!fs.existsSync(loc.ecosystem)) throw Error('Core ecosystem has not been published');
    // The hook provisions Dashboard authentication; it does not touch runtime hooks.
    try { run(process.execPath, [path.join(loc.code, 'hooks/post-install.js')], zylosDir); }
    catch (error) {
      // Exit metadata is useful without relaying hook output, which may contain
      // credentials from an older package or a failed configuration command.
      const detail=Number.isInteger(error.status) ? ` (exit ${error.status})`
        : error.code === 'ETIMEDOUT' ? ' (timed out)' : '';
      throw Error(`Dashboard configuration setup failed${detail}`);
    }
    try { migrateTakeoverDashboardDb({ zylosDir, transactionDir }); }
    catch (error) { return { state: 'failed', error: { code: 'dashboard_migration_failed', message: error.message } }; }
    // Lifecycle output is not part of the finalizer JSON protocol. Never forward
    // it: older hooks may include generated credentials even on stderr.
    run('pm2', ['start', loc.ecosystem, '--only', name, '--update-env'], zylosDir);
    const processes = JSON.parse(run('pm2', ['jlist'], zylosDir));
    if (!matches(processes, loc)) throw Error('Dashboard PM2 registration did not converge');
    run('pm2', ['save'], zylosDir);
    return { state: 'done' };
  } catch (error) { return { state: 'failed', error: { code: 'registration_failed', message: error.message } }; }
}

export function applyDashboardRoute({ zylosDir }) {
  try {
    const { port } = settings(zylosDir);
    // A fresh process binds the existing Caddy helper to the requested instance.
    const moduleUrl = pathToFileURL(path.join(packageRoot, 'cli/lib/caddy.js')).href;
    const script = `const {applyCaddyRoutes}=await import(process.argv[1]); process.stdout.write(JSON.stringify(applyCaddyRoutes('dashboard',JSON.parse(process.argv[2]))));`;
    const routes = [{ path: '/dashboard/*', type: 'reverse_proxy', target: `127.0.0.1:${port}`, strip_prefix: '/dashboard' }];
    const result = JSON.parse(run(process.execPath, ['--input-type=module','-e',script,moduleUrl,JSON.stringify(routes)], zylosDir));
    if (!result.success && result.error === 'caddy_not_available') return { state: 'skipped' };
    return result.success ? { state: 'done' } : { state: 'failed', error: { code: 'route_failed', message: result.error || result.action } };
  } catch (error) { return { state: 'failed', error: { code: 'route_failed', message: error.message } }; }
}

// Later upgrades restore only the previous running set; no re-registration or routing.
export function restoreDashboardService({ zylosDir }) {
  const loc = locations(zylosDir);
  let startError;
  try { run('pm2', ['start', loc.ecosystem, '--only', name, '--update-env'], zylosDir); }
  catch (error) { startError = error; }
  try {
    if (!matches(JSON.parse(run('pm2', ['jlist'], zylosDir)), loc)) throw Error('Dashboard is not online at its managed entry');
    run('pm2', ['save'], zylosDir);
    return { state: 'done' };
  } catch (error) { return { state: 'failed', error: { code: 'registration_failed', message: (startError || error).message } }; }
}

export async function verifyDashboard({ zylosDir }) {
  const checks = {}, errors = [];
  const deadline = Date.now() + READY_LIMIT;
  const remaining = () => Math.max(0, Math.floor(deadline - Date.now()));
  const timedOut = error => error.code === 'verify_timeout' || ['TimeoutError', 'AbortError'].includes(error.name);
  const health = async (url, expectedPid) => {
    const timeout = remaining();
    if (!timeout) throw Object.assign(Error('Dashboard verification timed out'), { code: 'verify_timeout' });
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    const body = await response.json();
    if (!response.ok || body.ok !== true || body.service !== name || body.pid !== expectedPid) throw Error('Dashboard health failed');
  };
  const failed = (item, code, location) => {
    checks[item] = false;
    errors.push({ item, code, location });
  };
  let loc;
  try { loc = settings(zylosDir); }
  catch { return { state: 'degraded', checks: { health: false }, errors: [{ item: 'health', code: 'health_failed', location: locations(zylosDir).config }] }; }
  const localUrl = `http://127.0.0.1:${loc.port}/api/health`;
  let confirmedPid;
  let observedFailure = false;
  do {
    const timeout = remaining();
    if (!timeout) break;
    let expectedPid;
    try { expectedPid = managedPid(JSON.parse(run('pm2', ['jlist'], zylosDir, timeout)), loc); }
    catch {}
    try {
      if (expectedPid == null) throw Error('Dashboard managed process is unavailable');
      await health(localUrl, expectedPid);
      confirmedPid = expectedPid;
      checks.health = true;
      break;
    }
    catch (error) {
      if (timedOut(error)) break;
      observedFailure = true;
    }
    if (remaining()) await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining())));
  } while (remaining());
  if (!checks.health) failed('health', observedFailure ? 'health_failed' : 'verify_timeout', localUrl);

  let routeLocation = path.join(zylosDir, '.zylos/config.json');
  if (isCaddyAvailable(zylosDir)) try {
    const configured = readConfigStrict(routeLocation);
    if (configured.state !== 'ok' && configured.state !== 'missing') throw Error('Core URL configuration is unreadable');
    const { domain, protocol = 'https', port } = configured.config || {};
    if (domain != null && typeof domain !== 'string') throw Error('Invalid public domain');
    if (domain) {
      if (!['http', 'https'].includes(protocol) || port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw Error('Invalid public URL');
      // Match the Core Caddyfile generator's explicit-port rule.
      const publicBase = new URL(`${port != null ? 'http' : protocol}://${domain}${port != null ? ':' + port : ''}`);
      if (publicBase.username || publicBase.password || publicBase.pathname !== '/' || publicBase.search || publicBase.hash) throw Error('Invalid public URL');
      routeLocation = new URL('/dashboard/api/health', publicBase).href;
      await health(routeLocation, confirmedPid);
      checks.route = true;
    }
  } catch (error) { failed('route', timedOut(error) ? 'verify_timeout' : 'route_failed', routeLocation); }
  return { state: errors.length ? 'degraded' : 'ready', checks, errors };
}
