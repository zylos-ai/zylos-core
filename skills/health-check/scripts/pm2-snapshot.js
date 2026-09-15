#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PM2_TIMEOUT_MS = 30_000;
const PM2_MAX_BUFFER = 50 * 1024 * 1024;

export class Pm2SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Pm2SnapshotError';
  }
}

function safeString(value) {
  return typeof value === 'string' ? value : null;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

export function sanitizePm2Processes(processes) {
  if (!Array.isArray(processes)) {
    throw new Pm2SnapshotError('PM2 returned an unexpected response shape');
  }

  const services = processes.map((process) => ({
    name: safeString(process?.name),
    status: safeString(process?.pm2_env?.status),
    pid: safeNumber(process?.pid),
    restart_time: safeNumber(process?.pm2_env?.restart_time),
  }));

  return {
    total: services.length,
    online: services.filter((service) => service.status === 'online').length,
    services,
  };
}

export function collectPm2Snapshot(run = spawnSync) {
  const result = run('pm2', ['jlist'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PM2_TIMEOUT_MS,
    maxBuffer: PM2_MAX_BUFFER,
  });

  if (result?.error || result?.status !== 0) {
    throw new Pm2SnapshotError('Unable to collect PM2 process status');
  }

  let processes;
  try {
    processes = JSON.parse(result.stdout);
  } catch {
    throw new Pm2SnapshotError('PM2 returned invalid JSON');
  }

  return sanitizePm2Processes(processes);
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(collectPm2Snapshot(), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Pm2SnapshotError
      ? error.message
      : 'Unable to collect PM2 process status';
    process.stderr.write(`PM2 health snapshot failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
