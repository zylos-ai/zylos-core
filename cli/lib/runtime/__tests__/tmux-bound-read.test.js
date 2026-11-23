import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import { openTmuxConnection } from '../tmux-connection.js';

async function fixture(t) {
  const connections = [];
  const f = isolatedTmux(t, {
    prefix: 'bound-read-',
    beforeCleanup: () => { for (const connection of connections) connection.close(); },
  });
  const start = () => {
    f.tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keeper', 'sleep 120');
    f.tmux('new-session', '-d', '-s', 'fixture', 'sleep 120');
    f.tmux('set-environment', '-t', '=fixture', 'READ_VALUE', 'original');
  };
  start();
  const [serverGeneration, tmuxSessionId, paneId] = f.tmux('display-message', '-p', '-t', '=fixture:',
    '#{pid}:#{start_time}|#{session_id}|#{pane_id}').split('|');
  const target = { serverGeneration, tmuxSessionId, paneId, tmuxName: 'fixture' };
  const connect = async () => {
    const connection = await openTmuxConnection({ binary: f.binary, socketPath: f.socketPath });
    connections.push(connection);
    connection.bindTarget(target);
    return connection;
  };
  return { ...f, target, start, connect };
}

test('same-name session replacement discards reads and leaves guarded writes rejected', async t => {
  const f = await fixture(t);
  const connection = await f.connect();
  f.tmux('kill-session', '-t', '=fixture');
  f.tmux('new-session', '-d', '-s', 'fixture', 'sleep 120');
  f.tmux('set-environment', '-t', '=fixture', 'READ_VALUE', 'replacement');
  assert.notEqual(f.tmux('display-message', '-p', '-t', '=fixture:', '#{session_id}'), f.target.tmuxSessionId);
  for (const kind of ['pane', 'session']) {
    await assert.rejects(connection.command(['show-environment', '-s', '-t', '=fixture'], { kind }),
      { code: 'TARGET_GONE' });
  }
  await assert.rejects(connection.command(['set-environment', '-t', '=fixture', 'READ_VALUE', 'stale-write']),
    { code: 'TARGET_GONE' });
  assert.equal(f.tmux('show-environment', '-t', '=fixture', 'READ_VALUE'), 'READ_VALUE=replacement');
});
