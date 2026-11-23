import { launchSession } from '../launch-flow.js';
import { createSessionOps } from '../session-ops.js';
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
import { checkMainProcess } from '../../../../skills/activity-monitor/scripts/main-process-check.js';
import { targetArgs, outerArgs } from '../../../../skills/dashboard/src/lib/observer-tmux-state.js';

import { settleLaunch } from '../launch-flow.js';
import { attachCommand } from '../../../commands/attach.js';
import { collectDiagnostics } from '../../../commands/doctor.js';
import { selfUninstall } from '../../../commands/self-uninstall.js';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

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
  fs.chmodSync(socketDirectory, 0o770);
  assert.deepEqual(tmuxClientArgs({}, env), ['-u', '-S', path.join(socketDirectory, 'default')]);
  fs.chmodSync(socketDirectory, 0o755);
  assert.throws(() => tmuxClientArgs({}, env), { code: 'TMUX_DIR_UNSAFE' });
});

test('unset directory preserves socket selection; invalid directory is never silently ignored', t => {
  const root = directory(t);
  assert.deepEqual(tmuxClientArgs({}, {}), ['-u']);
  assert.deepEqual(tmuxClientArgs({ utf8: false }, {}), []);
  assert.deepEqual(tmuxClientArgs({ socketPath: '/explicit/socket', utf8: false }, {}), ['-S', '/explicit/socket']);
  assert.deepEqual(tmuxClientArgs({ socketName: 'test' }, {}), ['-u', '-L', 'test']);
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: 'relative' }), { code: 'TMUX_DIR_UNSAFE' });
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: path.join(root, 'missing') }), { code: 'TMUX_DIR_MISSING' });
  const file = path.join(root, 'file'); fs.writeFileSync(file, 'not a directory');
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: file }), { code: 'TMUX_DIR_UNSAFE' });
});

test('symlink root resolves to the canonical socket directory', t => {
  const root = directory(t);
  const link = path.join(root, 'link'); fs.symlinkSync(root, link);
  assert.deepEqual(tmuxClientArgs({}, { TMUX_TMPDIR: link }),
    ['-u', '-S', path.join(root, `tmux-${process.getuid()}`, 'default')]);
});

test('system temporary root accepts shared permissions without touching system sockets', t => {
  const root = directory(t), child = path.join(root, 'socket-directory');
  const systemChild = path.join(fs.realpathSync('/tmp'), `tmux-${process.getuid()}`);
  const mkdir = fs.mkdirSync, lstat = fs.lstatSync;
  // Read the real /tmp root, but redirect all child access into the fixture.
  t.mock.method(fs, 'mkdirSync', (target, options) => {
    assert.equal(target, systemChild);
    return mkdir(child, options);
  });
  t.mock.method(fs, 'lstatSync', target => {
    assert.equal(target, systemChild);
    return lstat(child);
  });
  assert.deepEqual(tmuxClientArgs({}, { TMUX_TMPDIR: '/tmp' }),
    ['-u', '-S', path.join(systemChild, 'default')]);
});

test('empty directory preserves unset socket selection without filesystem access', t => {
  const methods = ['realpathSync', 'statSync', 'lstatSync', 'mkdirSync'];
  for (const method of methods) {
    t.mock.method(fs, method, () => assert.fail('empty directory must use the unset path'));
  }
  for (const options of [{}, { utf8: false }, { socketName: 'test' }, { socketPath: '/explicit/socket' }]) {
    assert.deepEqual(tmuxClientArgs(options, { TMUX_TMPDIR: '' }), tmuxClientArgs(options, {}));
  }
  for (const method of methods) assert.equal(fs[method].mock.callCount(), 0, method);
});

test('socket directory owned by another user is rejected', t => {
  const root = directory(t), child = path.join(root, `tmux-${process.getuid()}`);
  fs.mkdirSync(child, { mode: 0o700 });
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', target => {
    assert.equal(target, child);
    const stat = lstat(target); stat.uid = process.getuid() + 1; return stat;
  });
  assert.throws(() => tmuxClientArgs({}, { TMUX_TMPDIR: root }), { code: 'TMUX_DIR_UNSAFE' });
});

test('missing directory rejects every shared client before executing any binary', async t => {
  const root = directory(t);
  const code = 'TMUX_DIR_MISSING';
  environment(t, path.join(root, 'missing'));
  let calls = 0;
  const exec = () => { calls++; throw Error('must not execute'); };
  const sender = createTmuxSender({ exec });
  const sync = [
    () => helpers.tmuxCapturePaneText('test'),
    () => sender.getCapability(), () => sender.sendKeys('test', ['Enter']),
    () => isManagedClaudeProcess(123, { run: exec }),
    () => targetArgs({}, 'list-sessions'), () => outerArgs({ outerSocket: '/unused' }, 'kill-server'),
  ];
  for (const action of sync) assert.throws(action, { code });
  await assert.rejects(checkMainProcess({ env: { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX_PANE: '%1' },
    readTrigger: () => null, exec }), { code });
  await assert.rejects(async () => runTmuxCommand(['list-sessions'], { binary: '/must-not-execute' }), { code });
  await assert.rejects(listGroupTmuxSessions({ exec }), { code });
  const adapterOptions = {
    root,
    env: { HOME: root, PATH: '/nonexistent' },
    tmux: { binary: '/must-not-execute' },
  };
  const adapter = createSessionOps(adapterOptions);
  await assert.rejects(adapter.isRunning({ tmuxName: 'test' }), { code });
  await assert.rejects(adapter.stop({ tmuxName: 'test' }), { code });
  await assert.rejects(launchSession({ runtime: 'claude', sessionGroup: 'origin' }, adapterOptions), { code });
  let cleaned = false;
  await assert.rejects(settleLaunch({ tmuxName: 'test', runId: 'test', launchConfig: {}, sessionGroup: null,
    root: '/unused', script: { file: '/unused', cleanup() { cleaned = true; } } }), { code });
  assert.equal(cleaned, true);
  await assert.rejects(attachCommand({ exec, resolve: async () => ({ sessionGroup: 'origin', runtime: 'claude', live: { tmuxName: 'test' } }) }), { code });
  assert.equal(calls, 0);
});

test('main process diagnostic selects the guarded socket and preserves ordinary tmux errors', async t => {
  const root = directory(t);
  const env = { TMUX_TMPDIR: root, TMUX_PANE: '%1' };
  let calls = 0;
  const report = await checkMainProcess({ env, readTrigger: () => null, exec: (binary, args) => {
    calls++;
    assert.equal(binary, 'tmux');
    assert.deepEqual(args, [...tmuxClientArgs({}, env), 'display-message', '-p', '-t', '%1', '#{pane_pid}']);
    return '123\n';
  }, readInfo: () => null });
  assert.equal(report.basis.tmuxPanePid, 123);
  assert.equal(calls, 1);
  const failed = await checkMainProcess({ env, readTrigger: () => null,
    exec: () => { throw Object.assign(Error('client failed'), { code: 'ENOENT' }); } });
  assert.equal(failed.basis.tmuxError, 'ENOENT');
});

test('missing directory survives read, guard and group-absence classification', () => {
  const code = 'TMUX_DIR_MISSING';
  const error = Object.assign(Error('directory unavailable'), { code, status: 1,
    stderr: 'error connecting to /missing (No such file or directory)' });
  assert.equal(groupListNoServer(error), false);
  assert.throws(() => parseReadResponse('', error, {}), e => e === error);
  assert.throws(() => parseGuardResponse('', error, '1:2'), e => e === error);
});

test('failed client rechecks directory loss before classifying no server', async t => {
  const root = directory(t), active = path.join(root, 'active');
  fs.mkdirSync(active, { mode: 0o700 });
  environment(t, active);
  const binary = path.join(root, 'tmux.mjs');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';
fs.renameSync(process.env.TMUX_TMPDIR, process.env.TMUX_TMPDIR + '-moved');
process.stderr.write('no server running on fixture'); process.exit(1);\n`, { mode: 0o700 });
  await assert.rejects(runTmuxCommand(['list-sessions'], { binary }), { code: 'TMUX_DIR_MISSING' });
});

test('doctor and uninstall propagate missing directory before service actions', async t => {
  const root = directory(t);
  environment(t, path.join(root, 'missing'));
  const code = 'TMUX_DIR_MISSING';
  // All subprocesses are blocked even if an error-propagation regression occurs.
  let calls = 0;
  const forbidden = () => { calls++; throw Error('unexpected subprocess'); };
  t.mock.method(childProcess, 'execFileSync', forbidden);
  t.mock.method(childProcess, 'spawnSync', forbidden);
  t.mock.method(console, 'log', () => {});
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(collectDiagnostics(new Map(), {
    resolve: async () => ({ runtime: 'unknown', live: { tmuxName: 'fixture' } }),
    tmuxCheck: () => ({ installed: true }), pm2Check: () => ({ installed: false }),
    psCheck: () => ({ installed: true }),
  }), { code });
  await assert.rejects(selfUninstall(['--force']), { code });
  assert.equal(calls, 0);
});

test('adapter capture and delivery preserve directory failures without writing', async () => {
  const error = Object.assign(Error('directory gone'), { code: 'TMUX_DIR_MISSING' });
  let writes = 0;
  const adapter = createSessionOps({ dependencies: { revalidateSessionTarget: async () => { throw error; } } });
  const connection = { command: async () => { writes++; }, commandBatch: async () => { writes++; }, cleanupBuffer: async () => {} };
  const target = { paneId: '%1' };
  for (const action of [() => adapter.captureScreen({ target, connection }),
    () => adapter.sendKeys({ target, connection, keys: ['Enter'] }),
    () => adapter.sendText({ runtime: 'claude', target, connection, text: 'test' })]) {
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
