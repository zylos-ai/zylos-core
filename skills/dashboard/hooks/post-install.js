#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { provisionDashboardAuth } from '../src/lib/auth-provision.js';

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
await provisionDashboardAuth(zylosDir);
console.log(`dashboard data dir ready: ${path.join(zylosDir, 'components', 'dashboard')}`);

// Core owns runtime hooks and statusLine; standalone lifecycle is retired.
