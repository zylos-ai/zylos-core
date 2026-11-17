import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedTmux } from './isolated-tmux.js';
import { openTmuxConnection } from '../../cli/lib/runtime/tmux-connection.js';
import { createSessionReader } from '../../cli/lib/session-state-reader-async.js';

export function batchFixture(t) {
  const previous = process.env.ZYLOS_DIR;
  const f = isolatedTmux(t, { parentDir: os.tmpdir(), prefix: 'batch-', tmuxArgs: ['-f', '/dev/null'] });
  const root = path.join(f.dir, 'zylos');
  fs.mkdirSync(root);
  process.env.ZYLOS_DIR = root;
  t.after(() => { process.env.ZYLOS_DIR = previous; });
  const realHome = fs.realpathSync(os.userInfo().homedir);
  for (const [key, value] of Object.entries({ HOME:process.env.HOME, PM2_HOME:process.env.PM2_HOME,
    TMPDIR:process.env.TMPDIR, ZYLOS_DIR:root, socketDir:f.dir })) {
    assert(value && path.isAbsolute(value), `${key} must be runner-isolated`);
    const resolved = fs.existsSync(value) ? fs.realpathSync(value) : path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
    const relative = path.relative(realHome, resolved);
    assert(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), `${key} must be outside the real home`);
  }
  assert(f.socketPath.startsWith(f.dir + path.sep));
  assert(Buffer.byteLength(f.socketPath) < 90);
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socketPath: f.socketPath, binary: f.binary }));
  const connectionOptions = { socketPath: f.socketPath, binary: f.binary };
  const commands = [];
  let beforeCommand, afterCommand;
  const open = async options => {
    const connection = await openTmuxConnection(options);
    const command = connection.command.bind(connection);
    connection.command = async (argv, opts) => {
      commands.push(argv);
      await beforeCommand?.(argv);
      const output = await command(argv, opts);
      return afterCommand ? afterCommand(argv, output) : output;
    };
    return connection;
  };
  const reader = createSessionReader({ open, connectionOptions, env: process.env });
  function write(group, name, value) {
    const dir = path.join(root, 'activity-monitor', 'session-groups', group);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  }
  function ready(group, runId = `run-${group}`) {
    write(group, 'current-session.json', { runId, sessionId: `sid-${group}`, ts: Date.now(), startupControlIds: [] });
    write(group, 'agent-status.json', { runId, sessionId: `sid-${group}`, state: 'idle' });
    write(group, 'statusline.json', { session_id: `sid-${group}`, zylos: { v: 1, runId, capturedAt: Date.now() },
      model: { id: 'test-model' }, context_window: { used_percentage: 17 }, rate_limits: { five_hour: { used_percentage: 23 } } });
  }
  function add(group, { paneOnly = false, runId = `run-${group}`, model = 'test-model' } = {}) {
    f.tmux('new-session', '-d', '-s', `zylos-group-${group}`, '-e', `ZYLOS_RUN_ID=${runId}`,
      '-e', `ZYLOS_SESSION_GROUP=${group}`, '-e', `ZYLOS_MODEL_CONFIG=${JSON.stringify({ runtime: 'claude', mode: 'override', model })}`, 'sleep', '600');
    if (!paneOnly) ready(group, runId);
  }
  return { ...f, root, reader, commands, write, ready, add, connectionOptions,
    setBeforeCommand(fn) { beforeCommand = fn; },
    setAfterCommand(fn) { afterCommand = fn; } };
}
