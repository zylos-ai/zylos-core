import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const daemon = fileURLToPath(new URL('../daemon.js', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrapper = path.join(root, 'container.mjs');
  fs.writeFileSync(wrapper, 'await import(process.env.TEST_DAEMON_URL);\n');
  return { root, wrapper };
}
function launch(t, entry, root, target, pm2 = false) {
  const env = { ...process.env, HOME: root, ZYLOS_DIR: path.join(root, 'zylos'),
    PM2_HOME: path.join(root, 'pm2'), pmx: 'false', TEST_DAEMON_URL: pathToFileURL(target).href };
  delete env.pm_exec_path;
  if (pm2) env.pm_exec_path = target;
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', stopping = false;
    const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Scheduler entry did not exit after SIGTERM')); }, 10000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!stopping && stdout.includes('Scheduler started (TZ:')) { stopping = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
function assertStarted(result, root) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Scheduler started \(TZ:/);
  assert.equal(fs.existsSync(path.join(root, 'zylos/scheduler/scheduler.db')), true);
}

test('direct Scheduler entry starts and handles SIGTERM', async t => {
  const { root } = fixture(t);
  assertStarted(await launch(t, daemon, root, daemon), root);
});

test('PM2-style container import starts the pm_exec_path entry', async t => {
  const { root, wrapper } = fixture(t);
  assert.notEqual(wrapper, daemon);
  assertStarted(await launch(t, wrapper, root, daemon, true), root);
});

test('ordinary module import does not start Scheduler', async t => {
  const { root, wrapper } = fixture(t);
  const result = await launch(t, wrapper, root, daemon);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Scheduler started/);
  assert.equal(fs.existsSync(path.join(root, 'zylos/scheduler/scheduler.db')), false);
});

test('startup assertion detects the former argv-only guard under a PM2 container', async t => {
  const { root, wrapper } = fixture(t);
  let source = fs.readFileSync(daemon, 'utf8');
  const guard = 'const entry = process.env.pm_exec_path || process.argv[1];';
  assert.ok(source.includes(guard));
  source = source.replace(guard, 'const entry = process.argv[1];')
    .replace(/from '(\.\/[^']+)'/g, (_, relative) => `from '${new URL(relative, pathToFileURL(daemon)).href}'`);
  const mutant = path.join(root, 'mutant.mjs');
  fs.writeFileSync(mutant, source);
  const result = await launch(t, wrapper, root, mutant, true);
  assert.equal(result.code, 0, result.stderr);
  assert.throws(() => assertStarted(result, root), /Scheduler started/);
  assert.equal(fs.existsSync(path.join(root, 'zylos/scheduler/scheduler.db')), false);
});

// Optional local evidence uses the installed PM2 container directly, without
// starting a PM2 daemon, connecting to its sockets, or registering a service.
if (process.env.TEST_PM2_CONTAINER) test('installed PM2 fork container starts Scheduler', async t => {
  const { root } = fixture(t);
  assertStarted(await launch(t, process.env.TEST_PM2_CONTAINER, root, daemon, true), root);
});
