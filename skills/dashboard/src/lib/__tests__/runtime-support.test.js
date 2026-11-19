import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { TmuxObserverContainment } from '../observer-containment-tmux.js';
import { validateState } from '../observer-tmux-state.js';
import { readObserverGeometry } from '../observer-size-monitor.js';
import { StateEngine } from '../state-engine.js';

// Native commands and port selection are replaced at their I/O boundaries;
// publication touches only the runner's private temporary data directory.
test('Observer publishes and validates an agy managed target without executing native commands', async t => {
  const dataDir = await fs.realpath(await fs.mkdtemp('/tmp/o'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const binaryPath = path.join(dataDir, 'inert-binary');
  await fs.writeFile(binaryPath, 'never executed', { mode: 0o700 });
  const target = { sessionMode: 'multi', sessionGroup: 'telegram:42', runtime: 'agy', runId: 'agy-run', tmuxName: 'zylos-group-telegram=42' };
  const commands = [];
  const adapter = new TmuxObserverContainment({ dataDir, resolveTarget: async () => target,
    choosePort: async () => 23456,
    exec: async (_file, args) => {
      commands.push(args);
      assert(['has-session', 'display-message'].some(command => args.includes(command)));
      return { stdout: args.includes('display-message') ? path.join(dataDir, 'unused.sock') : '' };
    },
  });
  const state = await adapter._publish({ generation: 1, binaryPath, runtime: 'agy', observerTarget: target });
  assert(state.socketRoot.startsWith(dataDir + path.sep), 'socket metadata must stay in the private fixture');
  assert.equal(state.target, target.tmuxName);
  assert.deepEqual((await validateState(state.root)).observerTarget, target);
  assert.equal(commands.length, 2);
  assert.match(await fs.readFile(state.layoutFile, 'utf8'), /"-r"/);
  assert.deepEqual(await readObserverGeometry(state, async (_file, args) => {
    assert(args.includes(`=${target.tmuxName}:`));
    return { stdout: '120 39 on' };
  }), { cols: 120, rows: 40, windowRows: 39, statusLines: 1 });
  await assert.rejects(adapter._publish({ generation: 2, binaryPath, runtime: 'foreign', observerTarget: target }), { code: 'unsupported_runtime' });
});

test('agy usage health stays unsupported when retained Claude and Codex collectors are healthy', () => {
  const rows = ['jsonl_usage', 'codex_rollout'].map(name => ({ name, signal_type: 'collector_liveness', status: 'healthy', extra: { last_success: new Date(1000000).toISOString() } }));
  for (const runtime of ['claude', 'codex', 'agy']) {
    const engine = new StateEngine({ getSourceHealth: () => rows }, [], { runtime }, { now: () => 1000000 });
    const entry = engine.getSourceHealth().runtime_progress.jsonl_usage;
    assert.equal(entry.status, runtime === 'agy' ? 'unsupported' : 'healthy');
    assert.equal(entry.capability, runtime === 'agy' ? 'unsupported' : 'supported');
    assert.equal(entry.fresh, runtime !== 'agy');
  }
});

test('switch-runtime forwards all supported runtimes to the CLI and rejects unknown runtimes before execution', async t => {
  const calls = [];
  const execFile = () => assert.fail('only the promisified command boundary is used');
  execFile[promisify.custom] = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: JSON.stringify({ ok: true, data: { result: 'unchanged' } }) };
  };
  t.mock.module('node:child_process', { namedExports: { ...childProcess, execFile } });
  t.mock.module('../core-modules.js', { namedExports: { loadCoreModule: async name => {
    if (name === 'runtime/descriptors.js') return import('../../../../../cli/lib/runtime/descriptors.js');
    assert.equal(name, 'config.js');
    return { readSessionMode: () => ({ mode: 'multi' }) };
  } } });
  const { handleCoreAction } = await import('../core-actions.js?runtime-support');
  for (const runtime of ['claude', 'codex', 'agy']) {
    const result = await handleCoreAction('switch-runtime', { runtime }, {});
    assert.equal(result.ok, true);
    assert.equal(result.messageKey, 'result.runtime_unchanged');
    assert.equal(result.messageParams.value, runtime);
    assert.equal(calls.at(-1).file, 'zylos');
    assert.deepEqual(calls.at(-1).args, ['runtime', runtime, '--json']);
    assert.equal(calls.at(-1).options.timeout, 65000);
  }
  assert.equal((await handleCoreAction('switch-runtime', { runtime: 'foreign' }, {})).error, 'INVALID_RUNTIME');
  assert.equal(calls.length, 3);
});
