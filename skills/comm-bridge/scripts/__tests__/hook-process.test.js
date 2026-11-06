import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
for (const mode of ['inherited', 'orphan']) {
  test(`managed hook stops ${mode} child process activity`, { skip: process.platform === 'win32', timeout: 10000 }, async t => {
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
    for (let i = 0; i < 100 && active(pid); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(active(pid), false, 'fixture descendant must no longer be running');
  });
}
