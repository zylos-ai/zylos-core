#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

// Future version migrations go here.
// Example:
//   const configPath = path.join(dataDir, 'config.json');
//   if (fs.existsSync(configPath)) {
//     const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
//     // migrate fields...
//     fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
//   }

// Core owns runtime hooks and statusLine; standalone lifecycle is retired.
