import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { readProcessInfo } from '../claude-pid.js';
import {
  PANE_PROCESS_FILE, readPaneProcess, writePaneProcess,
} from '../../../../cli/lib/runtime/pane-process.js';
import { classifyHookProcess } from '../pane-process.js';

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

const info = pid => {
  const value = readProcessInfo(pid);
  assert.ok(value, `process ${pid} is readable`);
  return value;
};

test('the record round-trips and malformed records read as missing', t => {
  const dir = runDir(t);
  assert.equal(readPaneProcess(dir), null);
  for (const runtime of ['claude', 'codex', 'agy']) {
    const record = writePaneProcess(dir, { runId: 'run-1', runtime, panePid: 42, paneStart: '1000' });
    assert.deepEqual(readPaneProcess(dir), record);
  }
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

  const main = await classifyHookProcess({ env, dir, trigger: info(pane.pid) });
  assert.equal(main.verdict, 'main');
  assert.equal(main.reason, 'pane_process');

  const child = await classifyHookProcess({ env, dir, trigger: info(other.pid) });
  assert.equal(child.verdict, 'child');
  assert.equal(child.reason, 'not_pane_process');
});

test('a Codex wrapper pane accepts its direct child and refuses other processes', async t => {
  const dir = runDir(t);
  const wrapper = await liveProcess(t, { child: true });
  const other = await liveProcess(t);
  writePaneProcess(dir, { runId: 'run-1', runtime: 'codex', panePid: wrapper.pid, paneStart: info(wrapper.pid).start });
  const env = { ZYLOS_RUN_ID: 'run-1' };

  const native = await classifyHookProcess({ env, dir, trigger: info(wrapper.childPid) });
  assert.equal(native.verdict, 'main');
  assert.equal(native.reason, 'pane_process_child');
  assert.equal((await classifyHookProcess({ env, dir, trigger: info(wrapper.pid) })).verdict, 'main');
  assert.equal((await classifyHookProcess({ env, dir, trigger: info(other.pid) })).verdict, 'child');

  // The same parentage under a Claude record is not the pane process.
  writePaneProcess(dir, { runId: 'run-1', runtime: 'claude', panePid: wrapper.pid, paneStart: info(wrapper.pid).start });
  assert.equal((await classifyHookProcess({ env, dir, trigger: info(wrapper.childPid) })).verdict, 'child');
});

test('missing evidence is undetermined, never a refusal', async t => {
  const dir = runDir(t);
  const pane = await liveProcess(t);
  const env = { ZYLOS_RUN_ID: 'run-1' };
  assert.deepEqual(await classifyHookProcess({ env, dir, trigger: null }), { verdict: 'unknown', reason: 'process_unreadable' });
  assert.deepEqual(await classifyHookProcess({ env, dir, trigger: info(pane.pid) }), { verdict: 'unknown', reason: 'record_missing' });

  writePaneProcess(dir, { runId: 'run-0', runtime: 'claude', panePid: pane.pid, paneStart: info(pane.pid).start });
  assert.deepEqual(await classifyHookProcess({ env, dir, trigger: info(pane.pid) }), { verdict: 'unknown', reason: 'record_other_run' });

  writePaneProcess(dir, { runId: 'run-1', runtime: 'codex', panePid: pane.pid, paneStart: info(pane.pid).start });
  const unreadableParent = await classifyHookProcess({
    env, dir, trigger: { pid: 999999, ppid: pane.pid, start: '5', comm: 'codex' }, readInfo: () => null,
  });
  assert.deepEqual([unreadableParent.verdict, unreadableParent.reason], ['unknown', 'pane_unreadable']);
});

