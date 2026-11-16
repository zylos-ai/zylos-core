import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import { C4Reader } from '../c4-reader.js';

// Private metadata-only SQLite fixture. Run when channel send-state queries change;
// no component, live C4, runtime or PM2 access is needed.
test('channel failures are isolated from inbound traffic and reset on successful sends', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-state-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  const db = new Database(path.join(root, 'comm-bridge', 'c4.db'));
  const reader = new C4Reader(root);
  t.after(() => { reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, direction TEXT, channel TEXT, status TEXT)');
  const put = db.prepare('INSERT INTO conversations(direction,channel,status) VALUES(?,?,?)');
  assert.deepEqual(reader.getChannelSendState('one'), { lastSendFailed: false, consecutiveFailures: 0 });
  put.run('out', 'one', 'failed');
  put.run('in', 'one', 'delivered');
  put.run('out', 'two', 'delivered');
  put.run('out', 'one', 'failed');
  assert.deepEqual(reader.getChannelSendState('one'), { lastSendFailed: true, consecutiveFailures: 2 });
  assert.deepEqual(reader.getChannelSendState('two'), { lastSendFailed: false, consecutiveFailures: 0 });
  put.run('out', 'one', 'delivered');
  assert.deepEqual(reader.getChannelSendState('one'), { lastSendFailed: false, consecutiveFailures: 0 });
  put.run('out', 'one', 'failed');
  assert.deepEqual(reader.getChannelSendState('one'), { lastSendFailed: true, consecutiveFailures: 1 });
  db.exec('DROP TABLE conversations');
  assert.equal(reader.getChannelSendState('one'), null);
  const missing = new C4Reader(path.join(root, 'missing'));
  t.after(() => missing.close());
  assert.equal(missing.getChannelSendState('one'), null);
});
