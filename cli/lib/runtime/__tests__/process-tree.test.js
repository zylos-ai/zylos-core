import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const { readProcessTree, readTargetRuntime } = await import('../session-target.js');

// Real ps and /proc reads against private child processes; no tmux server, model CLI or
// account is touched. Run for process-tree or runtime-recognition changes; Linux only.
const linux = { skip: process.platform !== 'linux' };
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

function children(t) {
  const started = [];
  t.after(() => { for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return (file, args) => {
    const child = spawn(file, args, { stdio: 'ignore' });
    started.push(child);
    return child;
  };
}

// The pane root stands in for a shell whose child carries the runtime name.
function stub(t, start, childName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'process-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const named = path.join(dir, childName);
  fs.copyFileSync(execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim(), named);
  fs.chmodSync(named, 0o755);
  // The shell outlives its child so the pane root stays present when the runtime exits.
  return start('sh', ['-c', `"${named}" 120 & wait; sleep 120`]);
}

async function waitForChild(parentPid, name) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = (await readProcessTree()).find(item => item.ppid === parentPid && item.name === name);
    if (row) return row;
    await settle(10);
  }
  throw new Error(`child ${name} of ${parentPid} did not start`);
}

const observe = (pid, readTree) => readTargetRuntime({ connection: { command: async () => `${pid}\n` },
  paneId: '%1', rawF2: {}, readProcessTree: readTree });

test('runtime recognition reads names only for walked processes, independent of the process count', linux, async t => {
  const start = children(t);
  for (let i = 0; i < 400; i++) start('sleep', ['120']);
  const root = stub(t, start, 'claude');
  const runtime = await waitForChild(root.pid, 'claude');
  const total = (await readProcessTree()).length;
  assert.ok(total >= 400, `expected at least 400 processes, saw ${total}`);

  // A fresh process: earlier reads in this one leave uncollected buffers behind.
  const probe = new URL('./fixtures/process-tree-buffers.js', import.meta.url);
  const { observed, peak } = JSON.parse(execFileSync(process.execPath, [probe.pathname, String(root.pid)],
    { encoding: 'utf8', timeout: 30000 }));
  assert.deepEqual(observed, { runtime: 'claude', launchConfig: null, runtimeObservation: 'present', runtimePid: runtime.pid });
  console.log('process tree buffers:', JSON.stringify({ processes: total, peakArrayBufferGrowthBytes: peak }));
  // Reading every /proc/<pid>/comm with readFile allocated a 64 KiB buffer per process.
  assert.ok(peak < 2 * 1024 * 1024, `in-use buffers grew by ${peak} bytes for ${total} processes`);
});

test('a walked process that has exited is dropped even though the ps snapshot lists it', linux, async t => {
  const start = children(t);
  const root = stub(t, start, 'claude');
  const runtime = await waitForChild(root.pid, 'claude');
  const tree = await readProcessTree();
  assert.equal(tree.find(row => row.pid === runtime.pid)?.name, 'claude');
  process.kill(runtime.pid, 'SIGKILL');
  // The shell reaps its child; /proc/<pid> disappears while the snapshot still lists it.
  for (let attempt = 0; attempt < 200 && fs.existsSync(`/proc/${runtime.pid}`); attempt++) await settle(10);
  assert.equal(fs.existsSync(`/proc/${runtime.pid}`), false);
  assert.deepEqual(await observe(root.pid, async () => tree),
    { runtime: 'unknown', launchConfig: null, runtimeObservation: 'absent', runtimePid: undefined });
});

test('the Linux task name decides, not the path-trimmed ps name', linux, async t => {
  const start = children(t);
  // ps prints the task name "x/claude"; trimming it as a path would yield a false "claude".
  const root = start('python3', ['-c', "import ctypes,time; ctypes.CDLL(None).prctl(15,b'x/claude',0,0,0); time.sleep(120)"]);
  const comm = () => { try { return fs.readFileSync(`/proc/${root.pid}/comm`, 'utf8').trim(); } catch { return null; } };
  for (let attempt = 0; attempt < 200 && comm() !== 'x/claude'; attempt++) await settle(10);
  assert.equal(comm(), 'x/claude');
  const psName = execFileSync('ps', ['-o', 'comm=', '-p', String(root.pid)], { encoding: 'utf8' }).trim();
  assert.equal(path.basename(psName), 'claude', 'the ps name alone would match');
  assert.equal((await observe(root.pid, readProcessTree)).runtimeObservation, 'absent');
});
