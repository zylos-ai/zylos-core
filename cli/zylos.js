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
  const configFile = path.join(ZYLOS_DIR, 'pm2.config.js');

  if (!fs.existsSync(configFile)) {
    console.error(`PM2 config not found: ${configFile}`);
    console.log('Run zylos install first.');
    process.exit(1);
  }

  try {
    execSync(`pm2 start ${configFile}`, { stdio: 'inherit' });
    console.log('\nServices started. Run "zylos status" to check.');
  } catch (e) {
    console.error('Failed to start services');
    process.exit(1);
  }
}

function stopServices() {
  console.log('Stopping Zylos services...');
  try {
    execSync('pm2 stop activity-monitor scheduler 2>/dev/null || true', { stdio: 'inherit' });
    console.log('Services stopped.');
  } catch (e) {
    console.error('Failed to stop services');
  }
}

function restartServices() {
  console.log('Restarting Zylos services...');
  try {
    execSync('pm2 restart activity-monitor scheduler 2>/dev/null || true', { stdio: 'inherit' });
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
