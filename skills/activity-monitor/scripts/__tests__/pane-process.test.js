import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { readProcessInfo } from '../claude-pid.js';
import {
  PANE_PROCESS_FILE, belongsToPane, childRuntimeOf, classifyHookProcess, readPaneProcess,
  readyProcessFields, writePaneProcess,
} from '../pane-process.js';

function runDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-process-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A real long-lived process, stopped with the test. With `child`, it also starts one child and reports its pid.
 */
async function liveProcess(t, { child = false } = {}) {
  const script = child
    ? "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e6)'],{stdio:'ignore'});" +
      "process.stdout.write(String(c.pid)+'\\n');process.on('SIGTERM',()=>{c.kill();process.exit(0)});setInterval(()=>{},1e6)"
    : "process.stdout.write('up\\n');setInterval(()=>{},1e6)";
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => proc.kill('SIGTERM'));
  const [line] = await once(proc.stdout, 'data');
  return { pid: proc.pid, childPid: child ? Number(String(line).trim()) : null };
}

/**
 * A real process named `codex` (a native Codex pane process) with one direct child.
 * The link points at /bin/sh, not node: Node 24 renames its main thread
 * `MainThread`, so a node process started through a link keeps no link name.
 * Both processes are stopped with the test.
 */
async function nativeCodexProcess(t) {
  const binary = path.join(runDir(t), 'codex');
  fs.symlinkSync('/bin/sh', binary);
  const proc = spawn(binary, ['-c', 'sleep 1000 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [line] = await once(proc.stdout, 'data');
  const childPid = Number(String(line).trim());
  t.after(() => {
    try { process.kill(childPid, 'SIGKILL'); } catch {}
    proc.kill('SIGKILL');
  });
  return { pid: proc.pid, childPid };
}

const info = pid => {
  const value = readProcessInfo(pid);
  assert.ok(value, `process ${pid} is readable`);
  return value;
};

test('the record round-trips and malformed records read as missing', t => {
  const dir = runDir(t);
  assert.equal(readPaneProcess(dir), null);
  const record = writePaneProcess(dir, { runId: 'run-1', runtime: 'claude', panePid: 42, paneStart: '1000' });
  assert.deepEqual(readPaneProcess(dir), record);
  assert.equal((fs.statSync(path.join(dir, PANE_PROCESS_FILE)).mode & 0o777), 0o600);
  assert.throws(() => writePaneProcess(dir, { runId: 'run-1', runtime: 'gemini', panePid: 42, paneStart: '1' }), TypeError);
  for (const bad of ['{', '{"v":2,"runId":"r","runtime":"claude","panePid":1,"paneStart":"1"}',
    '{"v":1,"runId":"r","runtime":"claude","panePid":0,"paneStart":"1"}']) {
    fs.writeFileSync(path.join(dir, PANE_PROCESS_FILE), bad);
    assert.equal(readPaneProcess(dir), null);
  }
});

test('a Claude pane process is main and any other process of the run is a child', async t => {
  const dir = runDir(t);
  const pane = await liveProcess(t);
  const other = await liveProcess(t);
  writePaneProcess(dir, { runId: 'run-1', runtime: 'claude', panePid: pane.pid, paneStart: info(pane.pid).start });
  const env = { ZYLOS_RUN_ID: 'run-1' };

  const main = classifyHookProcess({ env, dir, trigger: info(pane.pid) });
  assert.equal(main.verdict, 'main');
  assert.equal(main.reason, 'pane_process');

  const child = classifyHookProcess({ env, dir, trigger: info(other.pid) });
  assert.equal(child.verdict, 'child');
  assert.equal(child.reason, 'not_pane_process');
});

test('a reused pane pid with a different start time is a child', async t => {
  const dir = runDir(t);
  const pane = await liveProcess(t);
  writePaneProcess(dir, { runId: 'run-1', runtime: 'claude', panePid: pane.pid, paneStart: '1' });
  const result = classifyHookProcess({ env: { ZYLOS_RUN_ID: 'run-1' }, dir, trigger: info(pane.pid) });
  assert.equal(result.verdict, 'child');
  assert.equal(result.reason, 'pane_pid_reused');
});

test('a Codex wrapper pane accepts its direct child and refuses other processes', async t => {
  const dir = runDir(t);
  const wrapper = await liveProcess(t, { child: true });
  const other = await liveProcess(t);
  writePaneProcess(dir, { runId: 'run-1', runtime: 'codex', panePid: wrapper.pid, paneStart: info(wrapper.pid).start });
  const env = { ZYLOS_RUN_ID: 'run-1' };

  const native = classifyHookProcess({ env, dir, trigger: info(wrapper.childPid) });
  assert.equal(native.verdict, 'main');
  assert.equal(native.reason, 'pane_process_child');
  assert.equal(classifyHookProcess({ env, dir, trigger: info(wrapper.pid) }).verdict, 'main');
  assert.equal(classifyHookProcess({ env, dir, trigger: info(other.pid) }).verdict, 'child');

  // The same parentage under a Claude record is not the pane process.
  writePaneProcess(dir, { runId: 'run-1', runtime: 'claude', panePid: wrapper.pid, paneStart: info(wrapper.pid).start });
  assert.equal(classifyHookProcess({ env, dir, trigger: info(wrapper.childPid) }).verdict, 'child');
});

test('a native Codex pane process refuses its own direct child', async t => {
  const dir = runDir(t);
  const pane = await nativeCodexProcess(t);
  assert.equal(info(pane.pid).comm, 'codex');
  assert.equal(info(pane.childPid).ppid, pane.pid);
  writePaneProcess(dir, { runId: 'run-1', runtime: 'codex', panePid: pane.pid, paneStart: info(pane.pid).start });
  const env = { ZYLOS_RUN_ID: 'run-1' };

  assert.equal(classifyHookProcess({ env, dir, trigger: info(pane.pid) }).reason, 'pane_process');
  // `codex exec` or `claude -p` run by the Codex shell tool without an intermediate shell.
  const child = classifyHookProcess({ env, dir, trigger: info(pane.childPid) });
  assert.deepEqual([child.verdict, child.reason], ['child', 'not_pane_process']);
});

test('missing evidence is undetermined, never a refusal', async t => {
  const dir = runDir(t);
  const pane = await liveProcess(t);
  const env = { ZYLOS_RUN_ID: 'run-1' };
  assert.deepEqual(classifyHookProcess({ env, dir, trigger: null }), { verdict: 'unknown', reason: 'process_unreadable' });
  assert.deepEqual(classifyHookProcess({ env, dir, trigger: info(pane.pid) }), { verdict: 'unknown', reason: 'record_missing' });

  writePaneProcess(dir, { runId: 'run-0', runtime: 'claude', panePid: pane.pid, paneStart: info(pane.pid).start });
  assert.equal(classifyHookProcess({ env, dir, trigger: info(pane.pid) }).reason, 'record_other_run');

  writePaneProcess(dir, { runId: 'run-1', runtime: 'codex', panePid: pane.pid, paneStart: info(pane.pid).start });
  const unreadableParent = classifyHookProcess({
    env, dir, trigger: { pid: 999999, ppid: pane.pid, start: '5', comm: 'codex' }, readInfo: () => null,
  });
  assert.deepEqual([unreadableParent.verdict, unreadableParent.reason], ['unknown', 'pane_unreadable']);
});

test('a hook without a run id is the pane process only under the tmux server', () => {
  const tree = {
    1: { pid: 1, ppid: 0, start: '1', comm: 'tmux: server' },
    10: { pid: 10, ppid: 1, start: '10', comm: 'claude' },
    11: { pid: 11, ppid: 10, start: '11', comm: 'bash' },
    12: { pid: 12, ppid: 11, start: '12', comm: 'claude' },
    20: { pid: 20, ppid: 1, start: '20', comm: 'node' },
    21: { pid: 21, ppid: 20, start: '21', comm: 'codex' },
    22: { pid: 22, ppid: 21, start: '22', comm: 'sh' },
    23: { pid: 23, ppid: 22, start: '23', comm: 'codex' },
    30: { pid: 30, ppid: 1, start: '30', comm: 'bash' },
    31: { pid: 31, ppid: 30, start: '31', comm: 'claude' },
    50: { pid: 50, ppid: 1, start: '50', comm: 'codex' },
    51: { pid: 51, ppid: 50, start: '51', comm: 'codex' },
    52: { pid: 52, ppid: 50, start: '52', comm: 'bash' },
    53: { pid: 53, ppid: 52, start: '53', comm: 'codex' },
    54: { pid: 54, ppid: 50, start: '54', comm: 'claude' },
  };
  const readInfo = pid => tree[pid] ?? null;
  const classify = pid => classifyHookProcess({ env: {}, trigger: tree[pid], readInfo });
  assert.equal(classify(10).verdict, 'main');
  assert.equal(classify(31).verdict, 'main', 'a shell between tmux and the runtime is skipped');
  assert.equal(classify(21).verdict, 'main', 'native Codex under its launcher wrapper');
  assert.equal(classify(12).verdict, 'child', 'claude -p under a Claude pane');
  assert.equal(classify(23).verdict, 'child', 'codex exec under a Codex pane');
  assert.equal(classify(50).verdict, 'main', 'native Codex as the pane process');
  assert.equal(classify(51).verdict, 'child', 'codex exec started directly by a native Codex pane');
  assert.equal(classify(53).verdict, 'child', 'codex exec through a shell of a native Codex pane');
  assert.equal(classify(54).verdict, 'child', 'claude -p started directly by a native Codex pane');
  assert.deepEqual(classifyHookProcess({ env: {}, trigger: { pid: 40, ppid: 41, start: '1', comm: 'claude' }, readInfo }),
    { verdict: 'unknown', reason: 'process_unreadable' });
});

test('pane membership compares start times only when both sides know them', () => {
  const pane = { runtime: 'claude', panePid: 5, paneStart: '100' };
  assert.equal(belongsToPane({ pid: 5, start: '100' }, pane), true);
  assert.equal(belongsToPane({ pid: 5, start: '101' }, pane), false);
  assert.equal(belongsToPane({ pid: 5 }, pane), true);
  assert.equal(belongsToPane({ pid: 5, start: '101' }, { ...pane, paneStart: null }), true);
  assert.equal(belongsToPane({ pid: 6, ppid: 5, parentStart: '100' }, pane), false);
  const wrapper = { ...pane, runtime: 'codex', paneComm: 'node' };
  assert.equal(belongsToPane({ pid: 6, ppid: 5, parentStart: '100' }, wrapper), true);
  assert.equal(belongsToPane({ pid: 6, ppid: 5, parentStart: '99' }, wrapper), false);
  assert.equal(belongsToPane({ pid: 6, ppid: 5, parentStart: '100' }, { ...wrapper, paneComm: 'codex' }), false);
  assert.equal(belongsToPane({ pid: 6, ppid: 5, parentStart: '100' }, { ...wrapper, paneComm: null }), false);
  assert.equal(belongsToPane({ pid: 5 }, { ...pane, panePid: null }), false);
});

test('READY process fields name the publisher and its parent', async t => {
  const proc = await liveProcess(t);
  const fields = readyProcessFields(info(proc.pid));
  assert.equal(fields.runtimePid, proc.pid);
  assert.equal(fields.runtimeStart, info(proc.pid).start);
  assert.equal(fields.runtimeParentPid, process.pid);
  assert.equal(fields.runtimeParentStart, info(process.pid).start);
  assert.deepEqual(readyProcessFields(null), {});
  assert.equal('runtimeParentStart' in readyProcessFields({ pid: 3, ppid: 2, start: '1' }, { readInfo: () => null }), false);
});

test('a child runtime is named by its process or its transcript location', () => {
  assert.equal(childRuntimeOf({ comm: 'claude' }, null), 'claude');
  assert.equal(childRuntimeOf({ comm: 'codex.exe' }, null), 'codex');
  assert.equal(childRuntimeOf({ comm: 'node' }, '/home/a/.codex/sessions/2026/x.jsonl'), 'codex');
  assert.equal(childRuntimeOf({ comm: 'node' }, 'C:\\Users\\a\\.claude\\projects\\p\\s.jsonl'), 'claude');
  assert.equal(childRuntimeOf({ comm: 'node' }, '/tmp/s.jsonl'), null);
});
