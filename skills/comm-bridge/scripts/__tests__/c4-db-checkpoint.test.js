import assert from 'node:assert/strict';
import { describe, it, beforeEach, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIG_ZYLOS_DIR = process.env.ZYLOS_DIR;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-db-cp-test-'));
process.env.ZYLOS_DIR = TMP_DIR;
fs.mkdirSync(path.join(TMP_DIR, '.claude', 'skills', 'telegram'), { recursive: true });

const mod = await import(new URL('../c4-db.js', import.meta.url));
const db = mod.getDb();

if (ORIG_ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
else process.env.ZYLOS_DIR = ORIG_ZYLOS_DIR;

after(() => { db.close(); fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

function insertDelivered(direction, channel, endpoint, content) {
  const row = mod.insertConversation(direction, channel, endpoint, content);
  if (direction === 'in') {
    assert.equal(mod.claimConversation(row.id), true);
    assert.equal(mod.markDelivered(row.id), true);
  }
  return row;
}

function seedCheckpointHead() {
  resetTables();
  for (let i = 0; i < 30; i++) insertDelivered('out', 'system', null, `seed${i}`);
}

function resetTables() {
  db.exec('DELETE FROM group_heads');
  db.exec('DELETE FROM channel_namespaces');
  db.exec('DELETE FROM checkpoints');
  db.exec('DELETE FROM conversations');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('checkpoints', 'conversations')");
}

// -- createCheckpoint --

describe('createCheckpoint', () => {
  beforeEach(seedCheckpointHead);

  it('auto-computes start from previous checkpoint', () => {
    mod.createCheckpoint('*', 10, 'First');
    const cp = mod.createCheckpoint('*', 25, 'Second');
    assert.equal(cp.start_conversation_id, 11);
    assert.equal(cp.end_conversation_id, 25);
  });

  it('requires summary unless explicitly creating a no-content coverage checkpoint', () => {
    assert.throws(() => mod.createCheckpoint('*', 5), { code: 'SUMMARY_INVALID' });
    const cp = mod.createCheckpoint('*', 5, null, { noContent: true });
    assert.equal(cp.no_content, 1);
    assert.equal(mod.getGlobalCoverageEnd(), 5);
    assert.equal(mod.getLatestContentCheckpoint('*'), null);
    assert.equal(cp.end_conversation_id, 5);
    assert.ok(cp.timestamp);
  });
});

// -- getLatestContentCheckpoint --

describe('getLatestContentCheckpoint', () => {
  beforeEach(resetTables);

  it('returns the most recent content checkpoint', () => {
    seedCheckpointHead();
    mod.createCheckpoint('*', 10, 'First');
    mod.createCheckpoint('*', 20, 'Second');
    mod.createCheckpoint('*', 25, null, { noContent: true });
    assert.equal(mod.getGlobalCoverageEnd(), 25);
    const cp = mod.getLatestContentCheckpoint('*');
    assert.equal(cp.summary, 'Second');
    assert.equal(cp.end_conversation_id, 20);
  });
});

// -- getCheckpoints --

// -- getUnsummarizedRange --

describe('getUnsummarizedRange', () => {
  beforeEach(resetTables);

  it('returns only conversations after last checkpoint', () => {
    insertDelivered('in', 'telegram', '123', 'msg1');
    insertDelivered('in', 'telegram', '123', 'msg2');
    mod.createCheckpoint('*', 1, 'Synced 1');
    insertDelivered('in', 'telegram', '123', 'msg3');
    const range = mod.getGlobalUnsummarizedRange();
    assert.equal(range.count, 2);
    assert.equal(range.firstConversationId, 2);
    assert.equal(range.lastConversationId, 3);
  });
});

// -- getUnsummarizedConversations --

// -- getConversationsByRange --

describe('getConversationsByRange', () => {
  beforeEach(resetTables);

  it('returns conversations in the inclusive range', () => {
    for (let i = 1; i <= 5; i++) {
      insertDelivered('in', 'telegram', '123', `msg${i}`);
    }
    const rows = mod.getConversationsByRange(2, 4);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].content, 'msg2');
    assert.equal(rows[2].content, 'msg4');
  });

});

// -- formatConversations --

describe('formatConversationsForAgent', () => {
  it('adds reply routing for IN conversation with endpoint', () => {
    const result = mod.formatConversationsForAgent([{
      timestamp: '2025-01-15 10:00:00',
      direction: 'in',
      channel: 'telegram',
      endpoint_id: '123',
      content: 'hello'
    }]);

    assert.ok(result.includes('hello ---- reply via: node'));
    assert.ok(result.includes('"telegram" "123"'));
  });

});
