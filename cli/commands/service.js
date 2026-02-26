/**
 * Service management commands
 */

import { execSync, spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZYLOS_DIR, SKILLS_DIR } from '../lib/config.js';
import { bold, dim, green, red, yellow, cyan, success, error, warn, heading } from '../lib/colors.js';
import { commandExists } from '../lib/shell-utils.js';

export function showStatus() {
  console.log(heading('Zylos Status') + '\n' + dim('============') + '\n');

  // Check Claude Code readiness
  if (!commandExists('claude')) {
    console.log(`${bold('Claude')}: ${red('NOT INSTALLED')}`);
    console.log(`  ${dim('→ Run: zylos init')}`);
  } else {
    // Check authentication
    let authenticated = false;
    try {
      const result = spawnSync('claude', ['auth', 'status'], {
        stdio: 'pipe', encoding: 'utf8', timeout: 10000,
      });
      authenticated = result.status === 0;
    } catch {}

    if (!authenticated) {
      console.log(`${bold('Claude')}: ${red('NOT AUTHENTICATED')}`);
      console.log(`  ${dim('→ Run: zylos init to authenticate')}`);
    } else {
      // Check terms/bypass acceptance
      let termsAccepted = false;
      try {
        const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        termsAccepted = !!settings.skipDangerousModePermissionPrompt;
      } catch {}

      if (!termsAccepted) {
        console.log(`${bold('Claude')}: ${yellow('NOT READY')} ${dim('— autonomous mode not yet accepted')}`);
        console.log(`  ${dim('→ Run: zylos init to complete setup')}`);
      } else {
        // Check runtime status from activity monitor
        const statusFile = path.join(ZYLOS_DIR, 'activity-monitor', 'claude-status.json');
        if (fs.existsSync(statusFile)) {
          try {
            const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            const stateStr = status.state.toUpperCase();
            const coloredState = stateStr === 'IDLE' ? green(stateStr) : stateStr === 'BUSY' ? yellow(stateStr) : stateStr;
            console.log(`${bold('Claude')}: ${coloredState}`);
            if (status.idle_seconds !== undefined) {
              console.log(`  ${dim('Idle:')} ${status.idle_seconds}s`);
            }
            if (status.last_check_human) {
              console.log(`  ${dim('Last check:')} ${status.last_check_human}`);
            }
          } catch {
            console.log(`${bold('Claude')}: ${yellow('UNKNOWN')} ${dim('(status file unreadable)')}`);
          }
        } else {
          console.log(`${bold('Claude')}: ${yellow('UNKNOWN')} ${dim('(no status file)')}`);
        }
      }
    }
  }

  console.log('');

  // Check PM2 services
  console.log(heading('Services (PM2):'));
  try {
    const pm2Output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(pm2Output);
    if (processes.length === 0) {
      console.log(`  ${dim('No services running')}`);
    } else {
      processes.forEach(p => {
        const st = p.pm2_env.status;
        if (st === 'online' || st === 'running') {
          console.log(`  ${success(`${bold(p.name)}: ${st}`)}`);
        } else {
          console.log(`  ${error(`${bold(p.name)}: ${st}`)}`);
        }
      });
    }
  } catch (e) {
    console.log(`  ${dim('PM2 not available or no services')}`);
  }

  console.log('');

  // Check disk space
  console.log(heading('Disk:'));
  try {
    const df = execSync(`df -h ${ZYLOS_DIR} | tail -1`, { encoding: 'utf8' });
    const parts = df.trim().split(/\s+/);
    console.log(`  Used: ${bold(parts[2])} / ${parts[1]} (${parts[4]})`);
  } catch (e) {
    console.log(`  ${dim('Unable to check')}`);
  }
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
  console.log(heading('Starting Zylos services...'));

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
      const envOpts = svc.env ? svc.env.split(' ').map(e => `--env ${e}`).join(' ') : '';
      execSync(`pm2 start ${svc.script} --name ${svc.name} ${envOpts} 2>/dev/null`, { stdio: 'pipe' });
      console.log(`  ${success(bold(svc.name))}`);
      started++;
    } catch (e) {
      try {
        execSync(`pm2 restart ${svc.name} 2>/dev/null`, { stdio: 'pipe' });
        console.log(`  ${success(`${bold(svc.name)} ${dim('(restarted)')}`)}`);
        started++;
      } catch (e2) {
        console.log(`  ${error(`${bold(svc.name)} ${dim('(failed)')}`)}`);
      }
    }
  }

  if (started > 0) {
    execSync('pm2 save 2>/dev/null', { stdio: 'pipe' });
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
  console.log(heading('Restarting Zylos services...'));
  const services = ['activity-monitor', 'scheduler', 'c4-dispatcher', 'web-console'];
  try {
    execSync(`pm2 restart ${services.join(' ')} 2>/dev/null || true`, { stdio: 'inherit' });
    console.log(success('Services restarted.'));
  } catch (e) {
    console.error(error('Failed to restart services'));
  }
}
