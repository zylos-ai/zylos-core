// Actual service observation methods on a private server. Invocation is explicit;
// this helper is never discovered as a test and writes evidence outside the repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createTestEnvironment } from '../../scripts/test-environment.js';
import { isolatedTmux } from './isolated-tmux.js';
const [source, countRaw, durationRaw = '20000', view = 'watched'] = process.argv.slice(2);
const repo = fs.realpathSync(source), count = Number(countRaw), duration = Number(durationRaw);
if (![6, 12].includes(count) || duration < 1000 || duration > 60000 || !['watched', 'unwatched'].includes(view)) throw new Error('Expected REPO 6|12 DURATION_MS watched|unwatched');
const environment = createTestEnvironment();
const cleanups = [];
const children = new Set();
const stop = () => { for (const child of children) child.kill('SIGTERM'); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
let succeeded = false;
try {
  process.env.TMPDIR = path.join(environment.root, 'tmp'); fs.mkdirSync(process.env.TMPDIR);
  const f = isolatedTmux({ after(fn) { cleanups.unshift(fn); } }, { parentDir: '/tmp', prefix: 'poll-', tmuxArgs: ['-f', '/dev/null'] });
  const binary = fs.realpathSync(execFileSync('sh', ['-c', 'command -v "$1"', 'sh', f.binary], { encoding: 'utf8' }).trim());
  const clientDir = path.join(environment.root, 'bin'); fs.mkdirSync(clientDir);
  const client = path.join(clientDir, 'tmux');
  execFileSync('cc', ['-O2', '-o', client, fileURLToPath(new URL('../fixtures/tmux-cpu-client.c', import.meta.url))], { timeout: 10000 });
  fs.mkdirSync(path.join(process.env.ZYLOS_DIR, '.zylos'));
  fs.writeFileSync(path.join(process.env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  for (let index = 0; index < count; index++) {
    const group = index === 0 ? 'origin' : `worker-${index}`;
    const runId = `run-${group}`, sessionId = `sid-${group}`;
    f.tmux('new-session', '-d', '-s', `zylos-group-${group}`, '-e', `ZYLOS_RUN_ID=${runId}`,
      '-e', `ZYLOS_SESSION_GROUP=${group}`, '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', 'sleep', '600');
    const dir = path.join(process.env.ZYLOS_DIR, 'activity-monitor/session-groups', group); fs.mkdirSync(dir, { recursive: true });
    for (const [name, value] of Object.entries({
      'current-session.json': { runId, sessionId, ts: Date.now(), startupControlIds: [] },
      'agent-status.json': { runId, sessionId, state: 'idle' },
      'statusline.json': { session_id: sessionId, zylos: { v: 1, runId, capturedAt: Date.now() }, context_window: { used_percentage: 17 }, rate_limits: { five_hour: { used_percentage: 10 } } },
    })) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  console.log(JSON.stringify({ isolation: { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socket: f.socketPath }, repo, count, duration, view, tmux: execFileSync(binary, ['-V'], { encoding: 'utf8' }).trim() }));
  const results = await Promise.all(['dashboard', 'monitor', 'dispatcher'].map(async service => {
    const log = path.join(environment.root, `${service}.cpu`);
    const started = performance.now();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./session-poll-benchmark-worker.js', import.meta.url)), repo, service, String(duration), view], {
      env: { ...process.env, ZYLOS_PACKAGE_ROOT: repo, PATH: `${clientDir}:${process.env.PATH}`, TMUX: `${f.socketPath},0,0`,
        BENCH_SOCKET: f.socketPath, BENCH_CLIENT: client, BENCH_TMUX_BIN: binary, BENCH_TMUX_LOG: log },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    children.add(child);
    const timeout = setTimeout(() => child.kill('SIGKILL'), duration + 30000);
    try {
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      const wallMs = performance.now() - started;
      const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
      const cpuUs = rows.reduce((total, line) => total + line.split(' ').reduce((sum, value) => sum + Number(value), 0), 0);
      return { service, exitCode, wallMs: Math.round(wallMs), tmuxProcesses: rows.length,
        tmuxPerSecond: rows.length / (duration / 1000), childCpuMs: cpuUs / 1000, childCpuPercent: cpuUs / (duration * 10) };
    } finally { clearTimeout(timeout); children.delete(child); }
  }));
  console.log(JSON.stringify({ results }));
  succeeded = results.every(value => value.exitCode === 0);
  if (!succeeded) process.exitCode = 1;
} finally {
  stop();
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('close', () => { clearTimeout(timeout); resolve(); });
  })));
  for (const cleanup of cleanups) await cleanup();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  environment.cleanup({ preserveTmp: !succeeded });
}
