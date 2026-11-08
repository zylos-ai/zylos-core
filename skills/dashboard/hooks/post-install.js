#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provisionDashboardAuth } from '../src/lib/auth-provision.js';

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const generated = await provisionDashboardAuth(zylosDir);
// Init alone requests a private pipe; normal lifecycle stdout/logs stay secret-free.
if (process.env.ZYLOS_DASHBOARD_PASSWORD_FD === '3') {
  fs.writeFileSync(3, JSON.stringify(generated));
}
console.log(`dashboard data dir ready: ${path.join(zylosDir, 'components', 'dashboard')}`);

// Core owns runtime hooks and statusLine; standalone lifecycle is retired.
