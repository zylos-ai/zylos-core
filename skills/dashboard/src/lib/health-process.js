import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const bootId = randomUUID();

// Local installation verification binds the public boot identity to PM2's PID.
// This file is private and never served by the HTTP API.
export function publishHealthProcess(dataDir) {
  const target = path.join(dataDir, 'health-process.json');
  const temporary = `${target}.${bootId}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, bootId }) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
}
