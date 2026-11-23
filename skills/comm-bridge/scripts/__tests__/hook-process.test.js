import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { runHookProcess } from '../c4-hook-process.js';

const script = new URL('./helpers/hook-process-child.js', import.meta.url).pathname;
const invoke = (mode, argument, options = {}) => runHookProcess({ command: process.execPath,
  args: [script, mode, ...(argument === undefined ? [] : [String(argument)])], input: '', timeoutMs: 3000, ...options });

function active(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    }
    const state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 }).trim();
    return state !== '' && !state.startsWith('Z');
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code) || error.status === 1) return false;
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
      let leader;
      try { leader = Number(fs.readFileSync(`${filename}.leader`, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Number.isSafeInteger(leader) && leader > 1) {
        for (const target of [-leader, leader]) {
          try { process.kill(target, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
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
    let running = active(pid);
    for (let i = 0; i < 100 && running; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      running = active(pid);
    }
    assert.equal(running, false, 'fixture descendant must no longer be running');
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
    const leader = pidAt(`${filename}.leader`);
    kill(leader, true);
    kill(leader);
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
