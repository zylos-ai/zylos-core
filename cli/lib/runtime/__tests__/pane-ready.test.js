import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readProcessStart } from '../../../../skills/activity-monitor/scripts/claude-pid.js';
import { readPaneProcess } from '../../../../skills/activity-monitor/scripts/pane-process.js';
import { recordPaneProcess } from '../launch-flow.js';
import { setupLaunch } from './launch-tmux-fixture.js';
const { openTmuxConnection } = await import('../tmux-connection.js');
const { observeSessionTarget, paneReady } = await import('../session-target.js');
const binary = process.env.TEST_TMUX_BIN || 'tmux';

const ready = (sessionId, publisher = {}) => ({ runId: 'r1', sessionId, ts: 1, startupControlIds: [], ...publisher });

test('a launch records the confirmed pane process of its run', async t => {
  const f = await setupLaunch(t);
  await f.launch({ tmuxName: 'grouped', sessionGroup: 'g1', runId: 'run-g1' });
  await f.launch({ tmuxName: 'single', sessionGroup: null, runId: 'run-origin', launchConfig: { runtime: 'codex', mode: 'default' } });
  for (const [tmuxName, group, runId, runtime] of [['grouped', 'g1', 'run-g1', 'claude'], ['single', 'origin', 'run-origin', 'codex']]) {
    const panePid = Number(f.tmux('display-message', '-p', '-t', `=${tmuxName}:`, '#{pane_pid}').trim());
    const record = readPaneProcess(path.join(f.dir, 'activity-monitor', 'session-groups', group));
    assert.deepEqual(record, { v: 1, runId, runtime, panePid, paneStart: readProcessStart(panePid) });
  }
});

test('a pane record that cannot be written never fails the launch', () => {
  const base = { runId: 'r', launchConfig: { runtime: 'claude' }, sessionGroup: 'g1', root: '/nonexistent', panePid: 5 };
  assert.equal(recordPaneProcess({ ...base, readStart: () => null, write: () => assert.fail('must not write') }), null);
  assert.equal(recordPaneProcess({ ...base, readStart: () => '1', write: () => { throw new Error('disk full'); } }), null);
  assert.equal(recordPaneProcess({ ...base, launchConfig: { runtime: 'gemini' }, readStart: () => '1' }), null);
});

test('READY from another process of the run keeps the last READY of the pane process', () => {
  const group = 'ready-unit';
  const options = { runId: 'r1', runtime: 'claude', panePid: 100, readInfo: pid => (pid === 100 ? { start: '500', comm: 'claude' } : null) };
  const own = ready('main-1', { runtimePid: 100, runtimeStart: '500', runtimeParentPid: 1 });
  assert.equal(paneReady(group, own, options), own);
  const child = ready('child-1', { runtimePid: 222, runtimeStart: '900', runtimeParentPid: 100, runtimeParentStart: '500' });
  assert.equal(paneReady(group, child, options), own);
  const reused = ready('child-2', { runtimePid: 100, runtimeStart: '501', runtimeParentPid: 1 });
  assert.equal(paneReady(group, reused, options), own);

  // /clear in the same process publishes a new session that is accepted.
  const cleared = ready('main-2', { runtimePid: 100, runtimeStart: '500', runtimeParentPid: 1 });
  assert.equal(paneReady(group, cleared, options), cleared);
  // A new pane process (restart) is accepted for its own run.
  const restarted = { ...ready('main-3', { runtimePid: 300, runtimeStart: '700', runtimeParentPid: 1 }), runId: 'r2' };
  assert.equal(paneReady(group, restarted, { ...options, runId: 'r2', panePid: 300, readInfo: () => ({ start: '700', comm: 'claude' }) }), restarted);
  // A child READY in that run never falls back to the previous run's READY.
  assert.equal(paneReady('ready-unit-2', { ...child, runId: 'r2' }, { ...options, runId: 'r2', panePid: 300, readInfo: () => ({ start: '700', comm: 'claude' }) }), null);
});

test('Codex READY from the native child of the pane wrapper is the pane process', () => {
  const options = { runId: 'r1', runtime: 'codex', panePid: 100, readInfo: () => ({ start: '500', comm: 'node' }) };
  const native = ready('codex-main', { runtimePid: 101, runtimeStart: '510', runtimeParentPid: 100, runtimeParentStart: '500' });
  assert.equal(paneReady('ready-codex', native, options), native);
  const exec = ready('codex-exec', { runtimePid: 150, runtimeStart: '600', runtimeParentPid: 140, runtimeParentStart: '590' });
  assert.equal(paneReady('ready-codex', exec, options), native);
});

test('a native Codex pane process ignores READY from its own direct child', () => {
  const options = { runId: 'r1', runtime: 'codex', panePid: 100, readInfo: () => ({ start: '500', comm: 'codex' }) };
  const main = ready('codex-main', { runtimePid: 100, runtimeStart: '500', runtimeParentPid: 1 });
  assert.equal(paneReady('ready-native-codex', main, options), main);
  // `codex exec` or `claude -p` run by the Codex shell tool without an intermediate shell.
  const child = ready('codex-exec', { runtimePid: 150, runtimeStart: '600', runtimeParentPid: 100, runtimeParentStart: '500' });
  assert.equal(paneReady('ready-native-codex', child, options), main);
  // A pane process that cannot be read gives no parent rule either.
  const unreadable = { ...options, readInfo: () => null };
  const second = ready('codex-exec-2', { runtimePid: 151, runtimeStart: '601', runtimeParentPid: 100, runtimeParentStart: '500' });
  assert.equal(paneReady('ready-native-codex', second, unreadable), main);
});

test('READY without a publisher, malformed or of another run is passed through unchanged', () => {
  const options = { runId: 'r1', runtime: 'claude', panePid: 100, readInfo: () => ({ start: '500', comm: 'claude' }) };
  const legacy = ready('legacy');
  assert.equal(paneReady('ready-legacy', legacy, options), legacy);
  const other = { ...ready('other', { runtimePid: 9 }), runId: 'r0' };
  assert.equal(paneReady('ready-legacy', other, options), other);
  assert.equal(paneReady('ready-legacy', null, options), null);
  assert.equal(paneReady('ready-legacy', legacy, { ...options, runId: null }), legacy);
});

// Real tmux on a private socket (isolatedTmux: own TMUX_TMPDIR and socket, killed with the test).
// Covers: observeSessionTarget reading the real tmux pane_pid for a pane without a
// pane-process record and ignoring a READY from another process. Run when
// session-target.js, paneReady/belongsToPane or the tmux observation format changes;
// skip when tmux is not installed (other changes are covered by the unit cases above).
test('a real pane without a pane record ignores READY published by another process', async t => {
  let connection;
  const { tmux, socketPath } = isolatedTmux(t, { prefix: 'pane-ready-', socketName: 'tmux.sock', beforeCleanup: () => connection?.close() });
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-e', 'ZYLOS_RUN_ID=r1',
    '-e', 'ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}', 'sleep', '120');
  connection = await openTmuxConnection({ binary, socketPath, sessionName: 'fixture' });
  const panePid = Number(tmux('display-message', '-p', '-t', '=fixture:', '#{pane_pid}'));
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));

  let current = ready('main-1', { runtimePid: panePid, runtimeStart: readProcessStart(panePid), runtimeParentPid: 1 });
  const observe = () => observeSessionTarget({ sessionGroup: 'pane-ready-real', tmuxName: 'fixture', connection, readReady: async () => current });
  const first = await observe();
  assert.deepEqual([first.ready, first.sessionId], [true, 'main-1']);

  current = ready('child-1', { runtimePid: other.pid, runtimeStart: readProcessStart(other.pid), runtimeParentPid: process.pid });
  const second = await observe();
  assert.deepEqual([second.ready, second.sessionId], [true, 'main-1']);

  current = ready('main-2', { runtimePid: panePid, runtimeStart: readProcessStart(panePid), runtimeParentPid: 1 });
  const third = await observe();
  assert.deepEqual([third.ready, third.sessionId], [true, 'main-2']);
});
