import { execFileSync } from 'node:child_process';
import { ZYLOS_DIR } from '../lib/config.js';
import { printDashboardPassword } from '../lib/dashboard-access.js';
import { provisionDashboardAuth } from '../../skills/dashboard/src/lib/auth-provision.js';

export async function dashboardCommand(args) {
  if (args.length === 0 || args.some(arg => ['--help', '-h'].includes(arg))) {
    console.log('Usage: zylos dashboard reset-password\nGenerate a new Dashboard password, show it once, and restart a running Dashboard.');
    return;
  }
  if (args.length !== 1 || args[0] !== 'reset-password') throw new Error('Usage: zylos dashboard reset-password');
  const access = { zylosDir: ZYLOS_DIR, ...await provisionDashboardAuth(ZYLOS_DIR, { reset: true }) };
  let running;
  try {
    const pid = execFileSync('pm2', ['pid', 'zylos-dashboard'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!/^\d*$/.test(pid)) throw new Error('Invalid process status');
    running = Number(pid) > 0;
    if (running) {
      execFileSync('pm2', ['restart', 'zylos-dashboard'], { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
      console.log('Dashboard password updated and Dashboard restarted.');
    } else console.log('Dashboard password updated. It takes effect the next time Dashboard starts.');
  } catch {
    console.error('Dashboard password saved, but service status/restart could not be confirmed. Restart Dashboard before signing in.');
    process.exitCode = 2;
  }
  printDashboardPassword(access);
}
