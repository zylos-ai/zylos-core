import path from 'node:path';
import { readConfigStrict } from './config-store.js';
import { bold, dim, heading, warn } from './colors.js';

function readConfig(file) {
  const result = readConfigStrict(file);
  if (result.state === 'error') throw new Error('Dashboard access configuration is unreadable');
  return result.config || {};
}

export function dashboardAccessAddress({ zylosDir, routed = false }) {
  const config = readConfig(path.join(zylosDir, 'components/dashboard/config.json'));
  const port = config.port ?? 3470;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Dashboard port');
  if (routed) {
    const core = readConfig(path.join(zylosDir, '.zylos/config.json'));
    if (core.domain) {
      const base = new URL(`${core.port != null ? 'http' : core.protocol || 'https'}://${core.domain}${core.port != null ? ':' + core.port : ''}`);
      if (base.username || base.password || base.pathname !== '/' || base.search || base.hash || !['http:', 'https:'].includes(base.protocol)) {
        throw new Error('Invalid Dashboard public URL');
      }
      return { url: new URL('/dashboard/', base).href, localOnly: false };
    }
  }
  return { url: `http://127.0.0.1:${port}/`, localOnly: true };
}

export function printDashboardInfo(access, log = console.log) {
  if (!access) return;
  log('');
  log(heading('Dashboard'));
  try {
    const address = dashboardAccessAddress(access);
    log(`    URL: ${bold(address.url)}`);
    if (address.localOnly) log('    Local access only through this port; no public route is configured.');
  } catch (error) { log(`    ${warn(error.message)}`); }
  printDashboardPassword(access, log);
  log('');
}

export function printDashboardPassword(access, log = console.log) {
  const password = access.password;
  delete access.password;
  if (password && access.quiet) {
    log('    Dashboard password generated. Run "zylos dashboard reset-password" on the host or inside the container to generate and display a new random password.');
  } else if (password) {
    log(`    Password: ${bold(password)}`);
    log('    Save this password now. It is shown only once and is not saved in plaintext.');
  } else if (access.provisionFailed) {
    log(warn('    Dashboard password setup could not be confirmed. Run "zylos dashboard reset-password".'));
  } else {
    log(dim('    Password already configured. Reset it with "zylos dashboard reset-password".'));
  }
}
