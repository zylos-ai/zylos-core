import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolatedTmux } from './isolated-tmux.js';
import { openTmuxConnection } from '../../cli/lib/runtime/tmux-connection.js';
import { createSessionReader } from '../../cli/lib/session-state-reader-async.js';

export function batchFixture(t) {
  const previous = process.env.ZYLOS_DIR;
  const f = isolatedTmux(t, { parentDir: '/tmp', prefix: 'batch-', tmuxArgs: ['-f', '/dev/null'] });
  const root = path.join(f.dir, 'zylos');
  fs.mkdirSync(root);
  process.env.ZYLOS_DIR = root;
  t.after(() => { process.env.ZYLOS_DIR = previous; });
  for (const key of ['HOME', 'PM2_HOME', 'TMPDIR']) {
    assert(process.env[key]?.startsWith('/tmp/'), `${key} must be runner-isolated`);
  }
  assert(f.socketPath.startsWith(f.dir + path.sep));
  assert(Buffer.byteLength(f.socketPath) < 90);
  t.diagnostic(JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, socketPath: f.socketPath, binary: f.binary }));
  const connectionOptions = { socketPath: f.socketPath, binary: f.binary };
  const commands = [];
  let beforeCommand;
  const open = async options => {
    const connection = await openTmuxConnection(options);
    const command = connection.command.bind(connection);
    connection.command = async (argv, opts) => {
      commands.push(argv);
      await beforeCommand?.(argv);
      return command(argv, opts);
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
    setBeforeCommand(fn) { beforeCommand = fn; } };
}
