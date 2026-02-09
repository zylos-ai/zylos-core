import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIG_ZYLOS_DIR = process.env.ZYLOS_DIR;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-db-cp-test-'));
process.env.ZYLOS_DIR = TMP_DIR;

const mod = await import(new URL('../c4-db.js', import.meta.url));
const db = mod.getDb();

if (ORIG_ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
else process.env.ZYLOS_DIR = ORIG_ZYLOS_DIR;

function resetTables() {
  db.exec('DELETE FROM checkpoints');
  db.exec('DELETE FROM conversations');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('checkpoints', 'conversations')");
}

// -- createCheckpoint --

describe('createCheckpoint', () => {
  beforeEach(resetTables);

  it('creates first checkpoint with start_conversation_id=1', () => {
    const cp = mod.createCheckpoint(10, 'First batch');
    assert.equal(cp.start_conversation_id, 1);
    assert.equal(cp.end_conversation_id, 10);
    assert.ok(cp.id > 0);
  });

  it('auto-computes start from previous checkpoint', () => {
    mod.createCheckpoint(10, 'First');
    const cp = mod.createCheckpoint(25, 'Second');
    assert.equal(cp.start_conversation_id, 11);
    assert.equal(cp.end_conversation_id, 25);
  });

  it('works without summary', () => {
    const cp = mod.createCheckpoint(5);
    assert.equal(cp.end_conversation_id, 5);
    assert.ok(cp.timestamp);
  });
});

// -- getLastCheckpoint --

describe('getLastCheckpoint', () => {
  beforeEach(resetTables);

  it('returns null when no checkpoints exist', () => {
    const cp = mod.getLastCheckpoint();
    assert.equal(cp, null);
  });

  it('returns the most recent checkpoint', () => {
    mod.createCheckpoint(10, 'First');
    mod.createCheckpoint(20, 'Second');
    const cp = mod.getLastCheckpoint();
    assert.equal(cp.summary, 'Second');
    assert.equal(cp.end_conversation_id, 20);
  });
});

// -- getCheckpoints --

describe('getCheckpoints', () => {
  beforeEach(resetTables);

  it('returns empty array when none exist', () => {
    const rows = mod.getCheckpoints();
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 0);
  });

  it('returns all checkpoints in reverse chronological order', () => {
    mod.createCheckpoint(10, 'First');
    mod.createCheckpoint(20, 'Second');
    mod.createCheckpoint(30, 'Third');
    const rows = mod.getCheckpoints();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].summary, 'Third');
    assert.equal(rows[2].summary, 'First');
  });
});

// -- getUnsummarizedRange --

describe('getUnsummarizedRange', () => {
  beforeEach(resetTables);

  it('returns count 0 when no conversations exist', () => {
    const range = mod.getUnsummarizedRange();
    assert.equal(range.count, 0);
  });

  it('returns all conversations when no checkpoint exists', () => {
    mod.insertConversation('in', 'telegram', '123', 'msg1');
    mod.insertConversation('in', 'telegram', '123', 'msg2');
    const range = mod.getUnsummarizedRange();
    assert.equal(range.count, 2);
    assert.equal(range.begin_id, 1);
    assert.equal(range.end_id, 2);
  });

  it('returns only conversations after last checkpoint', () => {
    mod.insertConversation('in', 'telegram', '123', 'msg1');
    mod.insertConversation('in', 'telegram', '123', 'msg2');
    mod.createCheckpoint(1, 'Synced 1');
    mod.insertConversation('in', 'telegram', '123', 'msg3');
    const range = mod.getUnsummarizedRange();
    assert.equal(range.count, 2);
    assert.equal(range.begin_id, 2);
    assert.equal(range.end_id, 3);
  });
});

// -- getUnsummarizedConversations --

describe('getUnsummarizedConversations', () => {
  beforeEach(resetTables);

  it('returns all unsummarized conversations', () => {
    mod.insertConversation('in', 'telegram', '123', 'msg1');
    mod.insertConversation('out', 'telegram', '123', 'reply1');
    const rows = mod.getUnsummarizedConversations();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].content, 'msg1');
  });

  it('respects limit parameter', () => {
    for (let i = 1; i <= 5; i++) {
      mod.insertConversation('in', 'telegram', '123', `msg${i}`);
    }
    const rows = mod.getUnsummarizedConversations(2);
    assert.equal(rows.length, 2);
    // Should return the most recent 2, in chronological order
    assert.equal(rows[0].content, 'msg4');
    assert.equal(rows[1].content, 'msg5');
  });

  it('excludes conversations before checkpoint', () => {
    mod.insertConversation('in', 'telegram', '123', 'old');
    mod.createCheckpoint(1, 'Synced');
    mod.insertConversation('in', 'telegram', '123', 'new');
    const rows = mod.getUnsummarizedConversations();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, 'new');
  });
});

// -- getConversationsByRange --

describe('getConversationsByRange', () => {
  beforeEach(resetTables);

  it('returns conversations in the inclusive range', () => {
    for (let i = 1; i <= 5; i++) {
      mod.insertConversation('in', 'telegram', '123', `msg${i}`);
    }
    const rows = mod.getConversationsByRange(2, 4);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].content, 'msg2');
    assert.equal(rows[2].content, 'msg4');
  });

  it('returns empty array for out-of-range query', () => {
    mod.insertConversation('in', 'telegram', '123', 'msg1');
    const rows = mod.getConversationsByRange(100, 200);
    assert.equal(rows.length, 0);
  });
});

// -- formatConversations --

describe('formatConversations', () => {
  it('returns empty string for empty array', () => {
    assert.equal(mod.formatConversations([]), '');
  });

  it('returns empty string for null', () => {
    assert.equal(mod.formatConversations(null), '');
  });

  it('formats IN conversation with endpoint', () => {
    const result = mod.formatConversations([{
      timestamp: '2025-01-15 10:00:00',
      direction: 'in',
      channel: 'telegram',
      endpoint_id: '123',
      content: 'hello'
    }]);
    assert.ok(result.includes('IN'));
    assert.ok(result.includes('telegram:123'));
    assert.ok(result.includes('hello'));
  });

  it('formats OUT conversation without endpoint', () => {
    const result = mod.formatConversations([{
      timestamp: '2025-01-15 10:00:00',
      direction: 'out',
      channel: 'telegram',
      endpoint_id: null,
      content: 'reply'
    }]);
    assert.ok(result.includes('OUT'));
    assert.ok(result.includes('(telegram)'));
    assert.ok(result.includes('reply'));
  });
});
