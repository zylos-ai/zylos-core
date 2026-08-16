import fs from 'node:fs';
import path from 'node:path';

import { ENV_FILE } from './config.js';

function readEnvValue(key) {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'));
    if (match) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  } catch {}
  return '';
}

export function buildManagedPath({
  envPath = process.env.PATH || '',
  systemPath = process.env.SYSTEM_PATH || readEnvValue('SYSTEM_PATH'),
} = {}) {
  return [...new Set([
    ...(systemPath || '').split(path.delimiter).filter(Boolean),
    ...(envPath || '').split(path.delimiter).filter(Boolean),
  ])].join(path.delimiter);
}

export function buildManagedPm2Env(env = process.env) {
  return {
    ...env,
    PATH: buildManagedPath({ envPath: env.PATH || '', systemPath: env.SYSTEM_PATH || readEnvValue('SYSTEM_PATH') }),
  };
}
