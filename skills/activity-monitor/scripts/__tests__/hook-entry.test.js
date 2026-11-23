import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readProcessInfo } from '../claude-pid.js';
import { writePaneProcess } from '../../../../cli/lib/runtime/pane-process.js';

const scripts = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(scripts, 'hook-entry.js');
const TARGET = path.join(scripts, '__tests__', 'fixtures', 'hook-entry-target.js');
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

