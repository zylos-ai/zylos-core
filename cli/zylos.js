#!/usr/bin/env node

/**
 * Zylos CLI - Main entry point
 * Usage: zylos <command> [options]
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
const SKILLS_DIR = path.join(process.env.HOME, '.claude', 'skills');

const commands = {
  status: showStatus,
  logs: showLogs,
  start: startServices,
  stop: stopServices,
  restart: restartServices,
  help: showHelp,
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  if (commands[command]) {
    await commands[command](args.slice(1));
  } else {
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }
}

function showStatus() {
  console.log('Zylos Status\n============\n');

  // Check Claude status
  const statusFile = path.join(process.env.HOME, '.claude-status');
  if (fs.existsSync(statusFile)) {
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      console.log(`Claude: ${status.state.toUpperCase()}`);
      if (status.idle_seconds !== undefined) {
        console.log(`  Idle: ${status.idle_seconds}s`);
      }
      if (status.last_check_human) {
        console.log(`  Last check: ${status.last_check_human}`);
      }
    } catch (e) {
      console.log('Claude: UNKNOWN (status file unreadable)');
    }
  } else {
    console.log('Claude: UNKNOWN (no status file)');
  }

  console.log('');

  // Check PM2 services
  console.log('Services (PM2):');
  try {
    const pm2Output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(pm2Output);
    if (processes.length === 0) {
      console.log('  No services running');
    } else {
      processes.forEach(p => {
        const status = p.pm2_env.status === 'online' ? '✓' : '✗';
        console.log(`  ${status} ${p.name}: ${p.pm2_env.status}`);
      });
    }
  } catch (e) {
    console.log('  PM2 not available or no services');
  }

  console.log('');

  // Check disk space
  console.log('Disk:');
  try {
    const df = execSync(`df -h ${ZYLOS_DIR} | tail -1`, { encoding: 'utf8' });
    const parts = df.trim().split(/\s+/);
    console.log(`  Used: ${parts[2]} / ${parts[1]} (${parts[4]})`);
  } catch (e) {
    console.log('  Unable to check');
  }
}

function showLogs(args) {
  const logType = args[0] || 'activity';

  const logFiles = {
    activity: path.join(ZYLOS_DIR, 'activity-log.txt'),
    scheduler: path.join(ZYLOS_DIR, 'scheduler-log.txt'),
    caddy: path.join(ZYLOS_DIR, 'logs', 'caddy-access.log'),
  };

  if (logType === 'pm2') {
    // Show PM2 logs
    const pm2 = spawn('pm2', ['logs', '--lines', '50'], { stdio: 'inherit' });
    pm2.on('close', () => process.exit(0));
    return;
  }

  const logFile = logFiles[logType];
  if (!logFile) {
    console.error(`Unknown log type: ${logType}`);
    console.log('Available: activity, scheduler, caddy, pm2');
    process.exit(1);
  }

  if (!fs.existsSync(logFile)) {
    console.log(`Log file not found: ${logFile}`);
    process.exit(1);
  }

  // Tail the log file
  const tail = spawn('tail', ['-f', '-n', '50', logFile], { stdio: 'inherit' });
  tail.on('close', () => process.exit(0));
}

function startServices() {
  console.log('Starting Zylos services...');

  const services = [
    { name: 'activity-monitor', script: path.join(SKILLS_DIR, 'self-maintenance', 'activity-monitor.js') },
    { name: 'scheduler', script: path.join(SKILLS_DIR, 'scheduler', 'scheduler.js'), env: `NODE_ENV=production ZYLOS_DIR=${ZYLOS_DIR}` },
    { name: 'c4-dispatcher', script: path.join(SKILLS_DIR, 'comm-bridge', 'c4-dispatcher.js') },
    { name: 'web-console', script: path.join(SKILLS_DIR, 'web-console', 'server.js'), env: `WEB_CONSOLE_PORT=3456 ZYLOS_DIR=${ZYLOS_DIR}` },
  ];

  let started = 0;
  for (const svc of services) {
    if (!fs.existsSync(svc.script)) {
      console.log(`  Skipping ${svc.name} (not installed)`);
      continue;
    }
    try {
      const envOpts = svc.env ? svc.env.split(' ').map(e => `--env ${e}`).join(' ') : '';
      execSync(`pm2 start ${svc.script} --name ${svc.name} ${envOpts} 2>/dev/null`, { stdio: 'pipe' });
      console.log(`  ✓ ${svc.name}`);
      started++;
    } catch (e) {
      // Already running or other error, try restart
      try {
        execSync(`pm2 restart ${svc.name} 2>/dev/null`, { stdio: 'pipe' });
        console.log(`  ✓ ${svc.name} (restarted)`);
        started++;
      } catch (e2) {
        console.log(`  ✗ ${svc.name} (failed)`);
      }
    }
  }

  if (started > 0) {
    execSync('pm2 save 2>/dev/null', { stdio: 'pipe' });
    console.log(`\n${started} services started. Run "zylos status" to check.`);
  } else {
    console.log('\nNo services started.');
  }
}

function stopServices() {
  console.log('Stopping Zylos services...');
  const services = ['activity-monitor', 'scheduler', 'c4-dispatcher', 'web-console'];
  try {
    execSync(`pm2 stop ${services.join(' ')} 2>/dev/null || true`, { stdio: 'inherit' });
    console.log('Services stopped.');
  } catch (e) {
    console.error('Failed to stop services');
  }
}

function restartServices() {
  console.log('Restarting Zylos services...');
  const services = ['activity-monitor', 'scheduler', 'c4-dispatcher', 'web-console'];
  try {
    execSync(`pm2 restart ${services.join(' ')} 2>/dev/null || true`, { stdio: 'inherit' });
    console.log('Services restarted.');
  } catch (e) {
    console.error('Failed to restart services');
  }
}

function showHelp() {
  console.log(`
Zylos CLI

Usage: zylos <command> [options]

Commands:
  status              Show system status
  logs [type]         Show logs (activity|scheduler|caddy|pm2)
  start               Start all services
  stop                Stop all services
  restart             Restart all services
  help                Show this help

Examples:
  zylos status
  zylos logs activity
  zylos logs pm2
  zylos start
`);
}

main().catch(console.error);
