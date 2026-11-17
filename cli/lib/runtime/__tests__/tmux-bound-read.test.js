import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import { openTmuxConnection } from '../tmux-connection.js';
import { parseTmuxEnvironment, tmuxReadCommands, parseReadResponse } from '../tmux-protocol.js';

test('read envelope checks both identity lines while preserving payload boundaries', () => {
  const target = { serverGeneration: '123:456', tmuxSessionId: '$1', paneId: '%2' };
  const identity = '123:456\t$1\t%2';
  const payload = '\nZYLOS_OK\nZYLOS_STALE 999:1\n123:456\t$1\t%2\n';
  const commands = [['capture-pane', '-p', '-t', '%2']];
  assert.deepEqual(tmuxReadCommands(commands, target), [
    'display-message', '-p', '-t', '%2', '#{pid}:#{start_time}\t#{session_id}\t#{pane_id}',
    ';', ...commands[0], ';',
    'display-message', '-p', '-t', '%2', '#{pid}:#{start_time}\t#{session_id}\t#{pane_id}',
  ]);
  assert.equal(parseReadResponse(`${identity}\n${payload}\n${identity}`, null, target), payload);
  for (const changed of ['999:456\t$1\t%2', '123:456\t$3\t%2', '123:456\t$1\t%4']) {
    for (const output of [`${changed}\n${payload}\n${identity}`, `${identity}\n${payload}\n${changed}`]) {
      assert.throws(() => parseReadResponse(output, null, target), { code: 'TARGET_GONE' });
    }
  }
  assert.equal(parseReadResponse(`${identity}\npayload\n123:456\t$1\t%4`, null, target, 'session'), 'payload');
});

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

test('bound read commands preserve marker-looking payload and shell environment values', async t => {
  const f = await fixture(t);
  const connection = await f.connect();
  const payload = 'ZYLOS_OK ZYLOS_STALE 999:1 quotes " \\ $HOME #{unknown_format} end';
  // display-message expands tmux formats, so compare the real direct command.
  const argv = ['display-message', '-p', '-t', f.target.paneId, payload];
  const expected = f.tmux(...argv);
  assert.equal(await connection.command(argv), expected);
  assert.equal(await connection.commandBatch([argv, argv]), `${expected}\n${expected}`);
  const value = 'line one\nZYLOS_STALE 999:1\\$HOME\tlast';
  f.tmux('set-environment', '-t', f.target.tmuxSessionId, 'READ_VALUE', value);
  const text = await connection.command(['show-environment', '-s', '-t', f.target.tmuxSessionId], { kind: 'session' });
  assert.equal(parseTmuxEnvironment(text).READ_VALUE, value);
  assert.equal((await connection.command(['capture-pane', '-p', '-t', f.target.paneId])).trim(),
    f.tmux('capture-pane', '-p', '-t', f.target.paneId));
});

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

test('same-socket server replacement discards reused-ID reads and rejects stale writes', async t => {
  const f = await fixture(t);
  const connection = await f.connect();
  f.tmux('kill-server');
  await f.waitForServerExit();
  f.start();
  f.tmux('set-environment', '-t', '=fixture', 'READ_VALUE', 'replacement');
  assert.equal(f.tmux('display-message', '-p', '-t', '=fixture:', '#{pane_id}'), f.target.paneId);
  assert.equal(f.tmux('display-message', '-p', '-t', '=fixture:', '#{session_id}'), f.target.tmuxSessionId);
  assert.notEqual(f.tmux('display-message', '-p', '#{pid}:#{start_time}'), f.target.serverGeneration);
  for (const kind of ['pane', 'session']) {
    await assert.rejects(connection.command(['show-environment', '-s', '-t', f.target.tmuxSessionId], { kind }),
      { code: 'TARGET_GONE' });
    await assert.rejects(connection.command(['display-message', '-p', '-t', f.target.paneId, 'replacement'], { kind }),
      { code: 'TARGET_GONE' });
  }
  await assert.rejects(connection.command(['set-environment', '-t', f.target.tmuxSessionId, 'READ_VALUE', 'stale-write']),
    { code: 'GENERATION_CHANGED' });
  assert.equal(f.tmux('show-environment', '-t', '=fixture', 'READ_VALUE'), 'READ_VALUE=replacement');
  f.tmux('set-environment', '-t', '=fixture', 'READ_VALUE', 'direct-control');
  assert.equal(f.tmux('show-environment', '-t', '=fixture', 'READ_VALUE'), 'READ_VALUE=direct-control');
});
