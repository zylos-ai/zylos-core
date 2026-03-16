import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN_DIR } from './config.js';

const PATH_FALLBACKS = [
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
];

export function splitPathEntries(value) {
  if (!value) return [];
  return String(value)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function dedupePathEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries.flatMap(splitPathEntries)) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function buildManagedPath(envMap = null) {
  const home = os.homedir();
  const nodeBin = path.dirname(process.execPath);
  return dedupePathEntries([
    BIN_DIR,
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'bin'),
    process.env.NVM_BIN,
    nodeBin,
    envMap?.get?.('SYSTEM_PATH'),
    process.env.SYSTEM_PATH,
    process.env.PATH,
    PATH_FALLBACKS,
  ]).join(path.delimiter);
}

export function parsePortNumber(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) return null;
  const port = Number.parseInt(str, 10);
  if (port < 1 || port > 65535) return null;
  return String(port);
}

export function resolvePort({ primaryKey, legacyKeys = [], envMap = null, envObject = process.env, defaultPort }) {
  const candidates = [primaryKey, ...legacyKeys];
  for (const key of candidates) {
    const fromProcess = parsePortNumber(envObject?.[key]);
    if (fromProcess) return fromProcess;
    const fromEnv = parsePortNumber(envMap?.get?.(key));
    if (fromEnv) return fromEnv;
  }
  return String(defaultPort);
}

export function getWebConsolePort(envMap = null, envObject = process.env) {
  return resolvePort({
    primaryKey: 'WEB_CONSOLE_PORT',
    legacyKeys: ['ZYLOS_WEB_PORT'],
    envMap,
    envObject,
    defaultPort: 3456,
  });
}

export function getPm2Home(home = os.homedir()) {
  return path.join(home, '.pm2');
}

export function findBinaryInPath(binaryName, searchPath) {
  for (const dir of splitPathEntries(searchPath)) {
    const candidate = path.join(dir, binaryName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return null;
}

export function findPm2Binary(envMap = null) {
  const managedPath = buildManagedPath(envMap);
  const explicit = findBinaryInPath('pm2', managedPath);
  if (explicit) return explicit;

  const adjacentToNode = path.join(path.dirname(process.execPath), 'pm2');
  try {
    fs.accessSync(adjacentToNode, fs.constants.X_OK);
    return adjacentToNode;
  } catch {
    return 'pm2';
  }
}

export function buildStablePm2SystemdUnit({ user, home, pm2Path, pathValue, pm2Home }) {
  return `[Unit]
Description=PM2 process manager for ${user}
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=simple
User=${user}
Environment=PATH=${pathValue}
Environment=PM2_HOME=${pm2Home}
Environment=HOME=${home}
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
ExecStart=${pm2Path} resurrect --no-daemon
ExecReload=${pm2Path} reload all
ExecStop=${pm2Path} kill
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}
