import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { hookTimerChunk, runHookProcess } from '../c4-hook-process.js';

const script = new URL('./helpers/hook-process-child.js', import.meta.url).pathname;
const invoke = (mode, argument, options = {}) => runHookProcess({ command: process.execPath,
  args: [script, mode, ...(argument === undefined ? [] : [String(argument)])], input: '', timeoutMs: 3000, ...options });

test('managed hook reads its payload only from stdin and keeps stderr private', async () => {
  const input = '{"content":"private payload $() `quoted`"}';
  const result = await invoke('normal', undefined, { input, timeoutMs: Number.MAX_VALUE });
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.stdout), { input, argv: ['normal'] });
  assert.equal('stderr' in result, false);
});

test('managed hook retains nonzero and signal exits even with valid-looking stdout', async () => {
  const nonzero = await invoke('nonzero');
  assert.equal(nonzero.exitCode, 7);
  assert.equal(nonzero.stdout, '{"decision":"continue"}');
  assert.equal(nonzero.timedOut, false);
  const signal = await invoke('signal');
  assert.equal(signal.exitCode, null);
  assert.equal(signal.signal, 'SIGTERM');
  assert.equal(signal.timedOut, false);
});

test('managed hook reports a missing executable without a timeout', async () => {
  const result = await runHookProcess({ command: '/nonexistent-hook-command', input: '', timeoutMs: 3000 });
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(result.timedOut, false);
});

test('managed hook uses each declared timeout and accepts fractional positive durations', async () => {
  const timed = await invoke('delay', 200, { timeoutMs: 60 });
  assert.equal(timed.timedOut, true);
  const completed = await invoke('delay', 80, { timeoutMs: 1000 });
  assert.equal(completed.timedOut, false);
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.stdout, 'finished');
  const fractional = await invoke('delay', 200, { timeoutMs: 0.1 });
  assert.equal(fractional.timedOut, true);
});

test('managed hook rejects absent or nonpositive and nonfinite timeouts', async () => {
  for (const timeoutMs of [undefined, null, '100', 0, -1, NaN, Infinity]) {
    await assert.rejects(invoke('normal', undefined, { timeoutMs }), /finite positive number/);
  }
});

test('timer segmentation preserves long and fractional declared timeouts', () => {
  const maximum = 2 ** 31 - 1;
  assert.equal(hookTimerChunk(maximum + 100), maximum);
  assert.equal(hookTimerChunk(Number.MAX_VALUE), maximum);
  assert.equal(hookTimerChunk((maximum + 100) - maximum), 100);
  assert.equal(hookTimerChunk(0.5), 0.5);
});

test('stdout accepts exactly one MiB of UTF-8 bytes and stops one byte above it', async () => {
  const maximum = 1024 * 1024;
  const exact = await invoke('stdout', maximum);
  assert.equal(exact.outputTooLarge, false);
  assert.equal(exact.timedOut, false);
  assert.equal(exact.exitCode, 0);
  assert.equal(Buffer.byteLength(exact.stdout), maximum);
  assert.equal(exact.stdout.length, maximum / 2);
  const oversized = await invoke('stdout', maximum + 1);
  assert.equal(oversized.outputTooLarge, true);
  assert.equal(oversized.timedOut, false);
  assert.ok(Buffer.byteLength(oversized.stdout) <= maximum);
});

test('stderr above the stdout bound is drained without affecting the result', async () => {
  const result = await invoke('stderr');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'finished');
  assert.equal(result.error, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputTooLarge, false);
  assert.equal('stderr' in result, false);
});

test('an elapsed deadline wins when child close arrives before the timeout callback', async t => {
  const schedule = globalThis.setTimeout;
  let callbacks = 0;
  // Delay callback delivery without changing the monotonic clock or product
  // source. The child still runs and exits through the real spawn/close path.
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => schedule(() => {
    callbacks++;
    callback(...args);
  }, delay + 1000));
  const result = await invoke('delay', 100, { timeoutMs: 60 });
  assert.equal(callbacks, 0, 'the deadline callback has not run');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'finished');
  assert.equal(result.timedOut, true, 'elapsed deadline takes precedence over successful exit');
});

test('stdout overflow retains timeout precedence when the deadline callback is delayed', async t => {
  const schedule = globalThis.setTimeout;
  let callbacks = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => schedule(() => {
    callbacks++;
    callback(...args);
  }, delay + 1000));
  const result = await invoke('stdout-delay', 1024 * 1024 + 1, { timeoutMs: 60 });
  assert.equal(callbacks, 0);
  assert.equal(result.outputTooLarge, true);
  assert.equal(result.timedOut, true);
});

function active(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    }
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 }).trim();
    return state !== '' && !state.startsWith('Z');
  } catch (error) {
    if (error.code === 'ENOENT' || error.status === 1) return false;
    throw error;
  }
}

// Real fixture children only. The official runner isolates HOME, ZYLOS_DIR,
// PM2_HOME and short TMPDIR; children inherit that fixture environment. No tmux,
// PM2, database or network is used. Run when hook spawn/deadline/cleanup changes;
// declaration or wire-only edits may skip these cases. Teardown kills the one
// known process group on assertion failure and removes only its own directory.
for (const mode of ['inherited', 'orphan', 'orphan-inherited']) {
  test(`managed hook stops ${mode} child process activity`, { timeout: 10000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-process-'));
    const filename = path.join(root, 'leaf.pid');
    let pid;
    t.after(() => {
      try { process.kill(-Number(fs.readFileSync(`${filename}.leader`, 'utf8')), 'SIGKILL'); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      if (!pid && fs.existsSync(filename)) pid = Number(fs.readFileSync(filename, 'utf8'));
      if (pid && active(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const result = await invoke(mode, filename, { timeoutMs: mode === 'inherited' ? 500 : 3000 });
    pid = Number(fs.readFileSync(filename, 'utf8'));
    assert.equal(Number.isSafeInteger(pid) && pid > 1, true);
    assert.equal(result.timedOut, mode === 'inherited');
    assert.equal(result.exitCode, mode === 'inherited' ? null : 0);
    if (mode === 'orphan-inherited') assert.deepEqual(JSON.parse(result.stdout), { version: 1, decision: 'continue' });
    for (let i = 0; i < 100 && active(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(active(pid), false, 'fixture descendant must no longer be running');
  });
}

function ownedFiles(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-owner-'));
  const filename = path.join(root, 'leaf.pid');
  const pidAt = file => {
    try { return Number(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const kill = (pid, group = false) => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    try { process.kill(group ? -pid : pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  t.after(() => {
    kill(pidAt(`${filename}.leader`), true);
    kill(pidAt(filename));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { filename, pidAt, kill };
}

test('infinite stdout terminates on output size before a long declared timeout', { timeout: 5000 }, async t => {
  const f = ownedFiles(t);
  const started = performance.now();
  const result = await invoke('infinite-stdout', f.filename, { timeoutMs: 10000 });
  assert.equal(result.outputTooLarge, true);
  assert.equal(result.timedOut, false);
  assert.ok(performance.now() - started < 2000, 'overflow must stop promptly rather than waiting for timeout');
});

test('an immediate abort remains a normal exit when the hook never reads large stdin', async () => {
  const result = await invoke('early-abort', undefined, { input: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, null, 'EPIPE from early stdin closure does not replace an abort');
  assert.equal(result.timedOut, false);
  assert.deepEqual(JSON.parse(result.stdout), { version: 1, decision: 'abort', message: 'too large' });
});

test('parent signal and exit listeners are removed after every invocation', async () => {
  const events = ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit'];
  const before = events.map(event => process.listenerCount(event));
  const pending = invoke('delay', 100);
  assert.deepEqual(events.map(event => process.listenerCount(event)), before.map(count => count + 1));
  await pending;
  assert.deepEqual(events.map(event => process.listenerCount(event)), before);
  await invoke('delay', 200, { timeoutMs: 1 });
  assert.deepEqual(events.map(event => process.listenerCount(event)), before);
  await runHookProcess({ command: '/nonexistent-hook-command', input: '', timeoutMs: 3000 });
  assert.deepEqual(events.map(event => process.listenerCount(event)), before);
  await invoke('stdout', 1024 * 1024 + 1);
  assert.deepEqual(events.map(event => process.listenerCount(event)), before);
});

// Standalone parent processes import the real runner. Every test owns both the
// parent's process group and the hook's separate group, with teardown independent
// of the runner under test. No source rewriting, signal mock or live process is
// involved. SIGKILL cannot run a parent cleanup handler and is not promised here.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit']) {
  test(`parent ${signal} terminates its active managed hook group`, { timeout: 10000 }, async t => {
    const f = ownedFiles(t);
    const parent = spawn(process.execPath, [script, 'supervise', f.filename], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const closed = new Promise(resolve => parent.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })));
    t.after(async () => {
      if (parent.exitCode === null && parent.signalCode === null) f.kill(parent.pid, true);
      await closed;
    });
    let diagnostics = '';
    for (const stream of [parent.stdout, parent.stderr]) stream.on('data', data => {
      diagnostics += data.toString();
      if (diagnostics.length > 65536) { diagnostics = diagnostics.slice(-65536); f.kill(parent.pid, true); }
    });
    let timer;
    try {
      await Promise.race([
        new Promise(resolve => parent.once('message', resolve)),
        closed.then(() => { throw new Error(`Parent exited before its hook started: ${diagnostics}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Parent fixture readiness timeout')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
    const leader = f.pidAt(`${f.filename}.leader`), leaf = f.pidAt(f.filename);
    assert.equal(Number.isSafeInteger(leader) && leader > 1, true);
    assert.equal(Number.isSafeInteger(leaf) && leaf > 1, true);
    assert.equal(active(leader), true);
    assert.equal(active(leaf), true);
    if (signal === 'exit') parent.send('exit');
    else parent.kill(signal);
    const result = await closed;
    assert.deepEqual(result, signal === 'exit' ? { code: 23, signal: null } : { code: null, signal });
    for (let i = 0; i < 100 && (active(leader) || active(leaf)); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(active(leader), false, diagnostics);
    assert.equal(active(leaf), false, diagnostics);
  });
}
