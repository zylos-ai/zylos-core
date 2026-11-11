import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { buildInstalledLayout } from './helpers/installed-layout.js';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const child = fileURLToPath(new URL('./helpers/single-driver-dashboard-child.js', import.meta.url));
const writer = fileURLToPath(new URL('./helpers/c4-probe-writer.js', import.meta.url));

// Boundary: one Dashboard process in the installed layout (Core package, installed comm-bridge and Dashboard skills,
// each with its own copy of the SQLite driver) reading C4 through its own reader, Core's read store and the chat send
// path. Run when any module that opens SQLite, the driver loader, the Core module loader or the chat send loader
// changes, or when the install layout changes; UI-only changes can skip it.
// Isolation: everything lives under one fresh directory of the runner's TMPDIR with private HOME, ZYLOS_DIR,
// PM2_HOME, TMPDIR and tmux directory; sudo, systemctl and apt-get resolve to logging stand-ins; no tmux server,
// PM2, network or live configuration is used. Children are killed and the directory removed when the test ends.
let layout;
test.before(() => {
  layout = buildInstalledLayout(packageRoot);
  const init = spawnSync(process.execPath, [writer, path.join(layout.skills, 'comm-bridge', 'scripts'), 'init'],
    { env: layout.env, cwd: layout.root, encoding: 'utf8', timeout: 20000 });
  assert.equal(init.status, 0, init.stderr);
});
test.after(() => {
  if (!layout) return;
  const escalated = fs.existsSync(layout.shimLog) ? fs.readFileSync(layout.shimLog, 'utf8') : '';
  fs.rmSync(layout.root, { recursive: true, force: true });
  assert.equal(escalated, '', 'no privileged or system command may run');
});

function startDashboard(t) {
  const process_ = fork(child, [path.join(layout.skills, 'dashboard')], { env: layout.env, cwd: layout.root,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  process_.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  t.after(() => { if (process_.exitCode === null) process_.kill('SIGKILL'); });
  let next = 0;
  const pending = new Map();
  process_.on('message', message => pending.get(message.id)?.(message));
  const failure = once(process_, 'exit').then(([code]) => { throw new Error(`Dashboard process exited ${code}: ${stderr}`); });
  failure.catch(() => {});
  const ask = command => Promise.race([failure, new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => reject(new Error(`${command} timed out: ${stderr}`)), 20000);
    pending.set(id, message => {
      clearTimeout(timer); pending.delete(id);
      message.ok ? resolve(message) : reject(new Error(message.error));
    });
    process_.send({ id, command });
  })]);
  const ready = Promise.race([failure, once(process_, 'message').then(([message]) => message)]);
  return { ask, ready };
}

function write(content) {
  const result = spawnSync(process.execPath, [writer, path.join(layout.skills, 'comm-bridge', 'scripts'), 'write', content],
    { env: layout.env, cwd: layout.root, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).id;
}

test('after a Core state read, a group snapshot and the chat send path, the Dashboard process has one SQLite driver', { timeout: 120000 }, async t => {
  const dashboard = startDashboard(t);
  assert.equal((await dashboard.ready).ready, true);
  await dashboard.ask('tick');
  assert.equal((await dashboard.ask('send')).namespace, 'dashboard');
  await dashboard.ask('tick');
  const { drivers } = await dashboard.ask('drivers');
  t.diagnostic(JSON.stringify({ drivers: drivers.map(file => path.relative(layout.root, file)) }));
  assert.equal(drivers.length, 1, `exactly one better_sqlite3.node may be mapped, found ${drivers.length}`);
});

test('rows another process writes keep reaching the Dashboard reader while Core reads open and close C4', { timeout: 120000 }, async t => {
  // No connection outside this Dashboard process stays open, so each writer closes as the last one it can see.
  const dashboard = startDashboard(t);
  assert.equal((await dashboard.ready).ready, true);
  const seen = [];
  for (let round = 0; round < 4; round++) {
    await dashboard.ask('tick');
    const written = write(`probe ${round}`);
    const { latest } = await dashboard.ask('read');
    seen.push({ written, latest });
    if (latest !== written) break;
  }
  t.diagnostic(JSON.stringify(seen));
  assert.equal(seen.length, 4, `the reader stopped seeing new rows: ${JSON.stringify(seen)}`);
  for (const { written, latest } of seen) assert.equal(latest, written);
});
