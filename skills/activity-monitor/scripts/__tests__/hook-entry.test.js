import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readProcessInfo } from '../claude-pid.js';
import { writePaneProcess } from '../pane-process.js';
import { childSessionRecord, hookName } from '../hook-entry.js';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(scripts, 'hook-entry.js');
const TARGET = path.join(scripts, '__tests__', 'fixtures', 'hook-entry-target.js');
const ACTIVITY = path.join(scripts, 'hook-activity.js');
const PACKAGE_ROOT = path.resolve(scripts, '..', '..', '..');

function instance(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'zylos');
  const runDir = path.join(zylosDir, 'activity-monitor', 'session-groups', 'g1');
  const env = {
    PATH: process.env.PATH, HOME: root, ZYLOS_DIR: zylosDir, ZYLOS_PACKAGE_ROOT: PACKAGE_ROOT,
    ZYLOS_SESSION_GROUP: 'g1', ZYLOS_RUN_ID: 'run-1', ZYLOS_MODEL_CONFIG: JSON.stringify({ runtime: 'claude' }),
    HOOK_ENTRY_TARGET_MARK: path.join(root, 'target-ran.jsonl'),
  };
  return {
    env, runDir,
    mark: env.HOOK_ENTRY_TARGET_MARK,
    ledger: path.join(runDir, 'child-sessions.jsonl'),
    errorLog: path.join(zylosDir, 'activity-monitor', 'hook-activity-errors.log'),
  };
}

/** Run the entry as this test process's direct child (this process plays the runtime that fired the hook). */
async function runEntry(t, env, args, payload = {}) {
  const proc = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 15000);
  t.after(() => { clearTimeout(timer); proc.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  proc.stdout.on('data', chunk => { stdout += chunk; });
  proc.stderr.on('data', chunk => { stderr += chunk; });
  proc.stdin.end(JSON.stringify(payload));
  const [code] = await once(proc, 'exit');
  clearTimeout(timer);
  return { code, stdout, stderr };
}

const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const self = () => readProcessInfo(process.pid);

test('the pane main process runs the target in-process with its own argv and stdin', async t => {
  const f = instance(t);
  writePaneProcess(f.runDir, { runId: 'run-1', runtime: 'claude', panePid: process.pid, paneStart: self().start });
  const result = await runEntry(t, f.env, [TARGET, '--shard', 'activity'], { hook_event_name: 'Stop' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'target output\n');
  const [ran] = lines(f.mark).map(JSON.parse);
  assert.deepEqual(ran.argv, [TARGET, '--shard', 'activity']);
  assert.deepEqual(JSON.parse(ran.input), { hook_event_name: 'Stop' });
  assert.deepEqual(lines(f.errorLog), []);
});

test('a child process of the run runs nothing and prints nothing', async t => {
  const f = instance(t);
  writePaneProcess(f.runDir, { runId: 'run-1', runtime: 'claude', panePid: process.ppid, paneStart: readProcessInfo(process.ppid).start });
  const result = await runEntry(t, f.env, [TARGET], { hook_event_name: 'Stop' });
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
  assert.deepEqual(lines(f.mark), []);
  assert.deepEqual(lines(f.ledger), []);
  assert.deepEqual(lines(f.errorLog), []);
});

test('a child SessionStart leaves exactly one cost record and nothing else', async t => {
  const f = instance(t);
  // A Codex pane: this process is not its pane process (nor that process's direct child).
  const pane = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
  t.after(() => pane.kill('SIGKILL'));
  writePaneProcess(f.runDir, { runId: 'run-1', runtime: 'codex', panePid: pane.pid, paneStart: readProcessInfo(pane.pid).start });
  const transcript = path.join(f.env.HOME, '.claude', 'projects', 'p', 'child-1.jsonl');
  const result = await runEntry(t, f.env, [ACTIVITY], {
    hook_event_name: 'SessionStart', source: 'startup', session_id: 'child-1', transcript_path: transcript,
  });
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
  const records = lines(f.ledger).map(JSON.parse);
  assert.equal(records.length, 1);
  const { ts, ...record } = records[0];
  assert.ok(Number.isSafeInteger(ts));
  assert.deepEqual(record, { v: 1, runtime: 'claude', session_group: 'g1', run_id: 'run-1', session_id: 'child-1', transcript_path: transcript });
  assert.deepEqual(fs.readdirSync(f.runDir).sort(), ['child-sessions.jsonl', 'pane-process.json']);

  // Other child events of that target add nothing.
  await runEntry(t, f.env, [ACTIVITY], { hook_event_name: 'PostToolUse', session_id: 'child-1', transcript_path: transcript });
  assert.equal(lines(f.ledger).length, 1);
});

test('a Codex child of a Claude pane is recorded under its own runtime', async t => {
  const f = instance(t);
  const pane = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
  t.after(() => pane.kill('SIGKILL'));
  writePaneProcess(f.runDir, { runId: 'run-1', runtime: 'claude', panePid: pane.pid, paneStart: readProcessInfo(pane.pid).start });
  const transcript = path.join(f.env.HOME, '.codex', 'sessions', '2026', '11', '17', 'rollout-child-2.jsonl');
  const result = await runEntry(t, f.env, [ACTIVITY], { hook_event_name: 'SessionStart', session_id: 'child-2', transcript_path: transcript });
  assert.deepEqual([result.code, result.stdout], [0, '']);
  const [record] = lines(f.ledger).map(JSON.parse);
  assert.deepEqual([record.runtime, record.session_id, record.transcript_path], ['codex', 'child-2', transcript]);
});

test('an undetermined process runs the hook and logs one complete line', async t => {
  const f = instance(t);
  const result = await runEntry(t, f.env, [TARGET, '--shard', 'start-prompt'], { hook_event_name: 'SessionStart' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(lines(f.mark).length, 1);
  const log = lines(f.errorLog);
  assert.equal(log.length, 1);
  assert.match(log[0], /hook-entry: main process undetermined, hook allowed reason=record_missing/);
  assert.match(log[0], new RegExp(` pid=${process.pid} runtime=claude hook=hook-entry-target\\.js#start-prompt session_group="g1" run_id="run-1"$`));
});

test('a hook without a run id under a non-tmux parent is refused', async t => {
  const f = instance(t);
  const { ZYLOS_RUN_ID, ZYLOS_SESSION_GROUP, ...env } = f.env;
  // A plain node process stands between this test and the entry, so the trigger's parent is this (non-tmux) process.
  const relay = `const c=require('child_process').spawn(process.execPath,${JSON.stringify([ENTRY, TARGET])},{stdio:'inherit'});c.on('exit',x=>process.exit(x))`;
  const proc = spawn(process.execPath, ['-e', relay], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => proc.kill('SIGKILL'));
  let stdout = '';
  proc.stdout.on('data', chunk => { stdout += chunk; });
  proc.stdin.end('{}');
  const [code] = await once(proc, 'exit');
  assert.deepEqual([code, stdout], [0, '']);
  assert.deepEqual(lines(f.mark), []);
});

test('the entry refuses a relative or non-script target', async t => {
  const f = instance(t);
  for (const target of ['hook-activity.js', path.join(scripts, 'README.md')]) {
    const result = await runEntry(t, f.env, [target]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /usage: hook-entry\.js/);
  }
});

test('hook names and cost records keep only what the Dashboard needs', () => {
  assert.equal(hookName('/x/hook-activity.js', ['--shard', 'stop']), 'hook-activity.js#stop');
  assert.equal(hookName('/x/statusline.js'), 'statusline.js');
  const options = { env: { ZYLOS_RUN_ID: 'r' }, location: { kind: 'single', sessionGroup: null }, trigger: { comm: 'codex' }, nowMs: 7 };
  assert.deepEqual(childSessionRecord({ hook_event_name: 'SessionStart', session_id: 's', transcript_path: '/t.jsonl' }, options),
    { v: 1, ts: 7, runtime: 'codex', session_group: 'origin', run_id: 'r', session_id: 's', transcript_path: '/t.jsonl' });
  assert.equal(childSessionRecord({ hook_event_name: 'SessionStart', session_id: 's' }, options), null);
  assert.equal(childSessionRecord({ hook_event_name: 'Stop', session_id: 's', transcript_path: '/t.jsonl' }, options), null);
  assert.equal(childSessionRecord({ hook_event_name: 'SessionStart', session_id: 's', transcript_path: '/t.jsonl' },
    { ...options, location: { kind: 'legacy' } }).session_group, null);
});
