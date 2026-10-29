#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/lib/auth.js';

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');
const configPath = path.join(dataDir, 'config.json');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

if (!fs.existsSync(configPath)) {
  const plaintext = crypto.randomBytes(16).toString('hex');
  const config = {
    port: 3470,
    host: '127.0.0.1',
    auth: {
      enabled: true,
      password: hashPassword(plaintext)
    },
    observer: {
      enabled: false
    }
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

console.log(`dashboard data dir ready: ${dataDir}`);

// Core owns runtime hooks and statusLine; standalone lifecycle is retired.
