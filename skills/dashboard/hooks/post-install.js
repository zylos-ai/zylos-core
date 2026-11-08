#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from '../src/lib/auth.js';
import { mutateConfig } from '../src/lib/config-mutation.js';

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');
const configPath = path.join(dataDir, 'config.json');

fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

const fresh = !fs.existsSync(configPath);
if (fresh || !JSON.parse(fs.readFileSync(configPath, 'utf8')).auth?.password) {
  await mutateConfig(configPath, config => {
    if (fresh) {
      const defaults = {
        port: 3470,
        host: '127.0.0.1',
        observer: { enabled: false }
      };
      for (const [key, value] of Object.entries(defaults)) {
        if (config[key] === undefined) config[key] = value;
      }
    }
    if (!config.auth?.password) {
      config.auth = { enabled: true, ...config.auth,
        password: hashPassword(crypto.randomBytes(16).toString('hex')) };
    }
  });
}

console.log(`dashboard data dir ready: ${dataDir}`);

// Core owns runtime hooks and statusLine; standalone lifecycle is retired.
