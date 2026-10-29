#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const dataDir = path.join(zylosDir, 'components', 'dashboard');
const backupDir = path.join(dataDir, 'backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

fs.mkdirSync(backupDir, { recursive: true });

for (const name of ['config.json', 'dashboard.db']) {
  const src = path.join(dataDir, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(backupDir, `${stamp}-${name}`));
  }
}

console.log(`dashboard backup complete: ${backupDir}`);
