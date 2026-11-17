import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmuxClientArgs } from '../tmux-client-args.js';
import { runTmuxCommand } from '../tmux-connection.js';
import { parseReadResponse, parseGuardResponse, groupListNoServer } from '../tmux-protocol.js';
import * as helpers from '../tmux-helpers.js';
import { listGroupTmuxSessions } from '../../session-group-paths.js';
import { createTmuxSender } from '../../../../skills/comm-bridge/scripts/tmux-send-keys.js';
import { isManagedClaudeProcess } from '../../../../skills/activity-monitor/scripts/runtime-generation.js';
import { targetArgs, outerArgs } from '../../../../skills/dashboard/src/lib/observer-tmux-state.js';
import { SessionAdapter } from '../session-adapter.js';
import { settleLaunch } from '../session-launch.js';
import { attachCommand } from '../../../commands/attach.js';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-directory-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function environment(t, root) {
  const previous = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = root;
  t.after(() => { if (previous === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previous; });
}

test('private directory selects an explicit default or named socket and validates existing permissions', t => {
  const root = directory(t), env = { TMUX_TMPDIR: root };
  const socketDirectory = path.join(root, `tmux-${process.getuid()}`);
  assert.deepEqual(tmuxClientArgs({}, env), ['-u', '-S', path.join(socketDirectory, 'default')]);
  assert.deepEqual(tmuxClientArgs({ socketName: 'test' }, env), ['-u', '-S', path.join(socketDirectory, 'test')]);
  assert.deepEqual(tmuxClientArgs({ socketPath: '/explicit/socket' }, env), ['-u', '-S', '/explicit/socket']);
  assert.equal(fs.statSync(socketDirectory).mode & 0o777, 0o700);
  fs.chmodSync(socketDirectory, 0o755);
  assert.throws(() => tmuxClientArgs({}, env), { code: 'TMUX_DIR_UNSAFE' });
});

test('unset directory preserves socket selection; invalid directory is never silently ignored', t => {
  const root = directory(t);
  assert.deepEqual(tmuxClientArgs({}, {}), ['-u']);
  assert.deepEqual(tmuxClientArgs({ utf8: false }, {}), []);
  assert.deepEqual(tmuxClientArgs({ socketPath: '/explicit/socket', utf8: false }, {}), ['-S', '/explicit/socket']);
  assert.deepEqual(tmuxClientArgs({ socketName: 'test' }, {}), ['-u', '-L', 'test']);
  for (const value of ['', 'relative']) assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: value }), { code: 'TMUX_DIR_UNSAFE' });
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: path.join(root, 'missing') }), { code: 'TMUX_DIR_MISSING' });
  fs.chmodSync(root, 0o777);
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: root }), { code: 'TMUX_DIR_UNSAFE' });
  fs.chmodSync(root, 0o700);
  const link = path.join(root, 'link'); fs.symlinkSync(root, link);
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: link }), { code: 'TMUX_DIR_UNSAFE' });
});

test('directory owned by another user is rejected before socket preparation', { skip: process.getuid() === 0 }, () => {
  assert.equal(fs.statSync('/').uid, 0);
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: '/' }), { code: 'TMUX_DIR_UNSAFE' });
});

test('missing directory rejects every shared client before executing any binary', async t => {
  environment(t, path.join(directory(t), 'missing'));
  let calls = 0;
  const exec = () => { calls++; throw Error('must not execute'); };
  const sender = createTmuxSender({ exec });
  const sync = [
    () => helpers.tmuxHasSession('test'), () => helpers.tmuxGetPanePid('test'),
    () => helpers.tmuxKillSession('test'), () => helpers.tmuxCapturePaneText('test'),
    () => helpers.tmuxPasteBuffer('test', '/unused', 'buffer'), () => helpers.tmuxDeleteBuffer('buffer'),
    () => helpers.tmuxNewSession(['new-session', '-d']), () => helpers.tmuxSendKeys('test', 'Enter'),
    () => sender.getCapability(), () => sender.sendKeys('test', ['Enter']),
    () => isManagedClaudeProcess(123, { run: exec }),
    () => targetArgs({}, 'list-sessions'), () => outerArgs({ outerSocket: '/unused' }, 'kill-server'),
  ];
  for (const action of sync) assert.throws(action, { code: 'TMUX_DIR_MISSING' });
  await assert.rejects(async () => runTmuxCommand(['list-sessions'], { binary: '/must-not-execute' }), { code: 'TMUX_DIR_MISSING' });
  await assert.rejects(listGroupTmuxSessions({ exec }), { code: 'TMUX_DIR_MISSING' });
  const adapter = new SessionAdapter({ tmux: { binary: '/must-not-execute' } });
  await assert.rejects(adapter.isRunning({ tmuxName: 'test' }), { code: 'TMUX_DIR_MISSING' });
  await assert.rejects(adapter.stop({ tmuxName: 'test' }), { code: 'TMUX_DIR_MISSING' });
  await assert.rejects(adapter.launch({ sessionGroup: 'origin' }), { code: 'TMUX_DIR_MISSING' });
  let cleaned = false;
  await assert.rejects(settleLaunch({ tmuxName: 'test', runId: 'test', launchConfig: {}, sessionGroup: null,
    root: '/unused', script: { file: '/unused', cleanup() { cleaned = true; } } }), { code: 'TMUX_DIR_MISSING' });
  assert.equal(cleaned, true);
  await assert.rejects(attachCommand({ exec, resolve: async () => ({ sessionGroup: 'origin', runtime: 'claude', live: { tmuxName: 'test' } }) }), { code: 'TMUX_DIR_MISSING' });
  assert.equal(calls, 0);
});

test('directory errors survive read, guard and group-absence classification', () => {
  const error = Object.assign(Error('directory gone'), { code: 'TMUX_DIR_MISSING', status: 1,
    stderr: 'error connecting to /missing (No such file or directory)' });
  assert.equal(groupListNoServer(error), false);
  assert.throws(() => parseReadResponse('', error, {}), e => e === error);
  assert.throws(() => parseGuardResponse('', error, '1:2'), e => e === error);
});

test('adapter capture and delivery preserve directory failures without writing', async () => {
  const error = Object.assign(Error('directory gone'), { code: 'TMUX_DIR_MISSING' });
  let writes = 0;
  const adapter = new SessionAdapter({ dependencies: { revalidateSessionTarget: async () => { throw error; } } });
  const connection = { command: async () => { writes++; }, commandBatch: async () => { writes++; }, cleanupBuffer: async () => {} };
  const target = { paneId: '%1' };
  for (const action of [() => adapter.captureScreen({ target, connection }),
    () => adapter.sendKeys({ target, connection, keys: ['Enter'] }),
    () => adapter.sendText({ target, connection, text: 'test' })]) {
    await assert.rejects(action(), e => e === error);
  }
  assert.equal(writes, 0);
});

test('directory loss during group listing cannot be classified as no server', async t => {
  const root = directory(t), active = path.join(root, 'active');
  fs.mkdirSync(active, { mode: 0o700 });
  environment(t, active);
  await assert.rejects(listGroupTmuxSessions({ exec: async () => {
    fs.renameSync(active, path.join(root, 'moved'));
    throw Object.assign(Error('no server running on fixture'), { code: 1, status: 1, stderr: 'no server running on fixture' });
  } }), { code: 'TMUX_DIR_MISSING' });
});
