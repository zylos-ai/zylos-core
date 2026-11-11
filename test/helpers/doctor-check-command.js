#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = fs.realpathSync(process.env.DOCTOR_TEST_ROOT);
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
  assert.ok(fs.realpathSync(process.env[key]).startsWith(`${root}${path.sep}`));
}
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ command, args,
  socket: command === 'tmux' ? process.env.DOCTOR_TEST_TMUX_SOCKET : undefined }) + '\n');

if (command === 'which') {
  const binary = path.join(process.env.PATH, args[0]);
  if (!fs.existsSync(binary)) process.exit(1);
  console.log(binary);
} else if (command === 'claude') {
  if (args[0] === '--version') console.log('Claude Code 1.0.0');
  else if (args[0] === '-p' && args[1] === 'ping') console.log('pong');
  else if (args[0] === '-p' && args[1].startsWith('You are a Zylos repair agent.')) {
    if (process.env.DOCTOR_TEST_STATE === 'repair_once') {
      fs.writeFileSync(path.join(root, 'repaired'), 'done');
      fs.rmSync(path.join(root, 'session-checked'), { force: true });
    }
    console.log('Isolated repair control completed.');
  } else process.exit(2);
} else if (command === 'codex') {
  if (args[0] === '--version') console.log('codex-cli 1.0.0');
  else if (args.join(' ') === 'login status') console.error('Logged in using ChatGPT');
  else process.exit(2);
} else if (command === 'pm2') {
  if (args[0] === '--version') console.log('6.0.0');
  else if (args[0] === 'jlist') console.log(JSON.stringify([
    { name: 'activity-monitor', pm2_env: { status: 'online' } },
    // Optional built-in web services: DOCTOR_TEST_WEB lists name=status pairs, e.g. "zylos-dashboard=online caddy=online".
    ...(process.env.DOCTOR_TEST_WEB || '').split(' ').filter(Boolean).map(pair => {
      const [name, status] = pair.split('=');
      return { name, pm2_env: { status } };
    }),
    ...['worker-a', 'worker-b'].map(name => ({ name,
      pm2_env: { status: process.env.DOCTOR_TEST_STATE === 'pass' || (process.env.DOCTOR_TEST_STATE === 'repair_once' && fs.existsSync(path.join(root, 'repaired'))) ? 'online' : 'stopped' } })),
  ]));
  else process.exit(2);
} else if (command === 'tmux') {
  assert.equal(process.env.DOCTOR_TEST_TMUX_SOCKET, path.join(process.env.TMPDIR, 'tmux.sock'));
  if (args[0] === '-V') console.log('tmux 3.4');
  else if (args.includes('display-message')) {
    if (process.env.DOCTOR_TEST_ORIGIN === 'unknown_presence' && fs.existsSync(path.join(root, 'session-checked'))) {
      process.stderr.write('fixture observation unavailable\n');
      process.exit(2);
    }
    // No runtime session exists in this fixture: answer as a real tmux with no server.
    process.stderr.write(`no server running on ${process.env.DOCTOR_TEST_TMUX_SOCKET}\n`);
    process.exit(1);
  } else if (args[0] === 'has-session') {
    if (process.env.DOCTOR_TEST_MODE === 'multi') {
      if (process.env.DOCTOR_TEST_ORIGIN === 'unknown_presence') fs.writeFileSync(path.join(root, 'session-checked'), 'done');
      if (process.env.DOCTOR_TEST_ORIGIN === 'need_unreadable') {
        const db = path.join(process.env.ZYLOS_DIR, 'comm-bridge', 'c4.db');
        if (fs.existsSync(db)) fs.renameSync(db, `${db}.unreadable`);
      }
      process.exit(1);
    }
  } else process.exit(2);
} else if (command === 'curl') {
  console.log(args.includes('-w') ? '200' : '[]');
} else process.exit(2);
