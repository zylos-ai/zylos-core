#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const version = 'Claude Code isolated-new';
if (process.argv.includes('--version')) { console.log(version); process.exit(0); }
if (process.argv.includes('--help')) { console.log(' --model MODEL --effort EFFORT '); process.exit(0); }
const root = process.env.ZYLOS_DIR;
const runId = process.env.ZYLOS_RUN_ID;
const directory = path.join(root, 'activity-monitor/session-groups/origin');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'current-session.json'), JSON.stringify({
  runId, sessionId: 'installed-runtime-session', ts: Date.now(), startupControlIds: [],
}));
fs.writeFileSync(path.join(root, 'replacement-version.json'), JSON.stringify({ version, runId }));
process.stdout.write('\u276f ');
setInterval(() => {}, 1000);
