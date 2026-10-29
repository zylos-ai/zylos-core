#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runObserverPreUninstall } from '../src/lib/observer-control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = process.env.ZYLOS_DASHBOARD_DATA_DIR || path.join(zylosDir, 'components', 'dashboard');

const observerResult = await runObserverPreUninstall({ dataDir, configPath: path.join(dataDir, 'config.json') });

console.log(`observer cleanup: ${observerResult.mode}`);

// Core owns runtime hooks and statusLine; standalone lifecycle is retired.
