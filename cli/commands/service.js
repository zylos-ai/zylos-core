/**
 * Service management commands
 */

import { savePm2ProcessList } from '../lib/pm2-save.js';
import { execSync, execFileSync, spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZYLOS_DIR, SKILLS_DIR, readZylosConfigOrThrow } from '../lib/config.js';
import { bold, dim, green, red, yellow, cyan, success, error, warn, heading } from '../lib/colors.js';
import { commandExists } from '../lib/shell-utils.js';
import { getCoreEcosystemPath, restartFromEcosystem, restartManagedProcess } from '../lib/pm2.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildPm2EnvFlags(envString) {
  if (!envString) return '';
  return envString
    .split(' ')
    .filter(Boolean)
    .map((entry) => `--env ${shellQuote(entry)}`)
    .join(' ');
}

export function restartServicesWithDeps({
  restartFromEcosystemFn = restartFromEcosystem,
  restartManagedProcessFn = restartManagedProcess,
  getCoreEcosystemPathFn = getCoreEcosystemPath,
  execSyncFn = execSync,
  logSuccess = console.log,
  logError = console.error,
} = {}) {
  const services = ['activity-monitor', 'scheduler', 'c4-dispatcher', 'web-console'];
  const ecosystemPath = getCoreEcosystemPathFn();
  const fallbackServices = [];
  let saveNeeded = false;

  for (const name of services) {
    try {
      restartFromEcosystemFn([name], { ecosystemPath, stdio: 'inherit' });
      saveNeeded = true;
    } catch {
      try {
        restartManagedProcessFn(name, {
          ecosystemPath,
          stdio: 'inherit',
          fallbackToPlainRestartOnError: true,
        });
        fallbackServices.push(name);
        saveNeeded = true;
      } catch {
        if (saveNeeded) {
          savePm2ProcessList({save: () => execSyncFn('pm2 save 2>/dev/null', { stdio: 'inherit' })});
        }
        logError(error('Failed to restart services'));
        return false;
      }
    }
  }

  if (saveNeeded) {
    savePm2ProcessList({save: () => execSyncFn('pm2 save 2>/dev/null', { stdio: 'inherit' })});
  }
  if (fallbackServices.length > 0) {
    logSuccess(success(`Services restarted. Plain PM2 fallback used for: ${fallbackServices.join(', ')}.`));
  } else {
    logSuccess(success('Services restarted.'));
  }
  return true;
}

export function collectHostStatus({ exec = execFileSync, disk = () => fs.statfsSync(ZYLOS_DIR) } = {}) {
  const result = { services: null, disk: null };
  try {
    result.services = JSON.parse(exec('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }))
      .map(item => ({ name: item.name, status: item.pm2_env?.status ?? 'unknown' }));
  } catch { /* Host data is supplementary to the session projection. */ }
  try {
    const stat = disk();
    result.disk = { total: stat.blocks * stat.bsize, available: stat.bavail * stat.bsize };
  } catch { /* Keep partial status available. */ }
  return result;
}

export async function showStatus(args = [], { collect, host = collectHostStatus, load = () => import('../lib/status-view.js') } = {}) {
  const json = args.includes('--json');
  let result;
  if (args.some(arg => arg !== '--json') || args.filter(arg => arg === '--json').length > 1) {
    result = { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Usage: zylos status [--json]', persisted: [] } };
  } else {
    try { result = { ok: true, data: await (collect || (await load()).collectStatus)() }; }
    catch (error) { result = { ok: false, error: { code: 'STATUS_UNAVAILABLE', message: error.message, persisted: [] } }; }
  }
  if (json) console.log(JSON.stringify(result));
  else if (!result.ok) console.error(`Error [${result.error.code}]: ${result.error.message}`);
  else {
    console.log(heading('Zylos Status'));
    console.log(`Session mode: ${result.data.sessionMode ?? 'single'}`);
    for (const row of [result.data.origin, ...result.data.groups]) {
      console.log(`  ${row.sessionGroup ?? 'single'}: ${row.presence} (${row.runtime ?? 'unknown'})`);
      if (row.status.valid) console.log(`    ${row.status.state}; idle: ${row.status.idleSeconds ?? 'unknown'}s`);
      if (row.error) console.error(`    ${row.error.message}`);
    }
    if (result.data.groupListError) console.error(`Groups unavailable: ${result.data.groupListError.message}`);
    for (const [runtime, health] of Object.entries(result.data.runtimeHealth)) console.log(`  ${runtime}: ${health.health ?? 'unknown'}`);
    const machine = host();
    console.log(heading('Services (PM2):'));
    if (machine.services === null) console.log('  unavailable');
    else if (!machine.services.length) console.log('  No services running');
    else for (const item of machine.services) console.log(`  ${item.name}: ${item.status}`);
    console.log(machine.disk ? `Disk: ${Math.round(machine.disk.available / 1024 ** 3)} GiB available / ${Math.round(machine.disk.total / 1024 ** 3)} GiB total` : 'Disk: unavailable');
  }
  if (!result.ok) process.exitCode = 1;
  return result;
}

export function showLogs(args) {
  const logType = args[0] || 'activity';

  const logFiles = {
    activity: path.join(ZYLOS_DIR, 'activity-log.txt'),
    scheduler: path.join(ZYLOS_DIR, 'scheduler-log.txt'),
    caddy: path.join(ZYLOS_DIR, 'http', 'caddy-access.log'),
  };

  if (logType === 'pm2') {
    const pm2 = spawn('pm2', ['logs', '--lines', '50'], { stdio: 'inherit' });
    pm2.on('close', () => process.exit(0));
    return;
  }

  const logFile = logFiles[logType];
  if (!logFile) {
    console.error(error(`Unknown log type: ${logType}`));
    console.log(dim('Available: activity, scheduler, caddy, pm2'));
    process.exit(1);
  }

  if (!fs.existsSync(logFile)) {
    console.log(error(`Log file not found: ${dim(logFile)}`));
    process.exit(1);
  }

  const tail = spawn('tail', ['-f', '-n', '50', logFile], { stdio: 'inherit' });
  tail.on('close', () => process.exit(0));
}

export function startServices() {
  readZylosConfigOrThrow();
  console.log(heading('Starting Zylos services...'));

  // Prefer ecosystem.config.cjs — it has proper PATH, env vars, and component services.
  const ecosystemPath = getCoreEcosystemPath();
  if (fs.existsSync(ecosystemPath)) {
    try {
      execSync(`pm2 start "${ecosystemPath}"`, { stdio: 'pipe' });
      savePm2ProcessList({save: () => execSync('pm2 save 2>/dev/null', { stdio: 'pipe' })});
      console.log(`  ${success('Started services from ecosystem.config.cjs')}`);
      console.log(`\n${green('Services started.')} Run ${dim('"zylos status"')} to check.`);
      return;
    } catch (e) {
      console.log(`  ${warn('Ecosystem start failed, falling back to individual starts.')}`);
    }
  }

  // Fallback: start core services individually (no ecosystem.config.cjs available)
  const services = [
    { name: 'activity-monitor', script: path.join(SKILLS_DIR, 'self-maintenance', 'activity-monitor.js') },
    { name: 'scheduler', script: path.join(SKILLS_DIR, 'scheduler', 'scheduler.js'), env: `NODE_ENV=production ZYLOS_DIR=${ZYLOS_DIR}` },
    { name: 'c4-dispatcher', script: path.join(SKILLS_DIR, 'comm-bridge', 'scripts', 'c4-dispatcher.js') },
    { name: 'web-console', script: path.join(SKILLS_DIR, 'web-console', 'server.js'), env: `WEB_CONSOLE_PORT=3456 ZYLOS_DIR=${ZYLOS_DIR}` },
  ];

  let started = 0;
  for (const svc of services) {
    if (!fs.existsSync(svc.script)) {
      console.log(`  ${warn(`${bold(svc.name)} ${dim('(not installed)')}`)}`);
      continue;
    }
    try {
      const envOpts = buildPm2EnvFlags(svc.env);
      execSync(`pm2 start ${shellQuote(svc.script)} --name ${shellQuote(svc.name)} ${envOpts} 2>/dev/null`, { stdio: 'pipe' });
      console.log(`  ${success(bold(svc.name))}`);
      started++;
    } catch (e) {
      try {
        try { execSync(`pm2 delete "${svc.name}" 2>/dev/null`, { stdio: 'pipe' }); } catch {}
        const envOpts = buildPm2EnvFlags(svc.env);
        execSync(`pm2 start ${shellQuote(svc.script)} --name ${shellQuote(svc.name)} ${envOpts} 2>/dev/null`, { stdio: 'pipe' });
        console.log(`  ${success(`${bold(svc.name)} ${dim('(started after cleanup)')}`)}`);
        started++;
      } catch (e2) {
        console.log(`  ${error(`${bold(svc.name)} ${dim('(failed)')}`)}`);
      }
    }
  }

  if (started > 0) {
    savePm2ProcessList({save: () => execSync('pm2 save 2>/dev/null', { stdio: 'pipe' })});
    console.log(`\n${green(started + ' services started.')} Run ${dim('"zylos status"')} to check.`);
  } else {
    console.log('\n' + warn('No services started.'));
  }
}

export function stopServices() {
  console.log(heading('Stopping Zylos services...'));
  const services = ['activity-monitor', 'scheduler', 'c4-dispatcher', 'web-console'];
  try {
    execSync(`pm2 stop ${services.join(' ')} 2>/dev/null || true`, { stdio: 'inherit' });
    console.log(success('Services stopped.'));
  } catch (e) {
    console.error(error('Failed to stop services'));
  }
}

export function restartServices() {
  readZylosConfigOrThrow();
  console.log(heading('Restarting Zylos services...'));
  restartServicesWithDeps();
}
