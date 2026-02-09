import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set up an isolated temp ZYLOS_DIR BEFORE importing c4-db.js so that
// c4-config.js (evaluated once at first import) picks up our temp path.
const ORIG_ZYLOS_DIR = process.env.ZYLOS_DIR;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-db-test-'));
process.env.ZYLOS_DIR = TMP_DIR;

// Dynamic import so the env var is set before c4-config.js evaluates.
const mod = await import(new URL('../c4-db.js', import.meta.url));
const db = mod.getDb();

// Restore env after module load (tests use the already-open db handle).
if (ORIG_ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
else process.env.ZYLOS_DIR = ORIG_ZYLOS_DIR;

/**
 * Wipe all rows from control_queue and conversations before each test
 * so every test starts with a clean slate and predictable autoincrement IDs.
 */
function resetTables() {
  db.exec('DELETE FROM control_queue');
  db.exec('DELETE FROM conversations');
  // Reset autoincrement counters
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('control_queue', 'conversations')");
}

// Cleanup temp dir when process exits
process.on('exit', () => {
  try { mod.close(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// insertControl
// ---------------------------------------------------------------------------
describe('insertControl', () => {
  beforeEach(() => resetTables());

  it('inserts a basic control record with defaults', () => {
    const rec = mod.insertControl('do something');
    assert.ok(typeof rec.id === 'number' && rec.id > 0);
    assert.equal(rec.content, 'do something');
    assert.equal(rec.priority, 0);
    assert.equal(rec.require_idle, 0);
    assert.equal(rec.bypass_state, 0);
    assert.equal(rec.ack_deadline_at, null);
    assert.equal(rec.status, 'pending');
    assert.equal(rec.retry_count, 0);
    assert.equal(rec.available_at, null);
    assert.ok(typeof rec.created_at === 'number');
    assert.ok(typeof rec.updated_at === 'number');
  });

  it('replaces __CONTROL_ID__ placeholder with the actual id', () => {
    const rec = mod.insertControl('ack __CONTROL_ID__ please');
    assert.equal(rec.content, `ack ${rec.id} please`);
    // verify persisted value matches
    const row = mod.getControlById(rec.id);
    assert.equal(row.content, `ack ${rec.id} please`);
  });

  it('populates all options when provided', () => {
    const rec = mod.insertControl('full opts', {
      priority: 5,
      requireIdle: true,
      bypassState: true,
      ackDeadlineAt: 9999999,
      availableAt: 8888888,
    });
    assert.equal(rec.priority, 5);
    assert.equal(rec.require_idle, 1);
    assert.equal(rec.bypass_state, 1);
    assert.equal(rec.ack_deadline_at, 9999999);
    assert.equal(rec.available_at, 8888888);
  });

  it('assigns sequential ids', () => {
    const a = mod.insertControl('a');
    const b = mod.insertControl('b');
    assert.equal(b.id, a.id + 1);
  });
});

// ---------------------------------------------------------------------------
// getControlById
// ---------------------------------------------------------------------------
describe('getControlById', () => {
  beforeEach(() => resetTables());

  it('returns the record when found', () => {
    const rec = mod.insertControl('findme');
    const row = mod.getControlById(rec.id);
    assert.ok(row);
    assert.equal(row.id, rec.id);
    assert.equal(row.content, 'findme');
  });

  it('returns null when not found', () => {
    const row = mod.getControlById(999999);
    assert.equal(row, null);
  });
});

// ---------------------------------------------------------------------------
// getNextPendingControl
// ---------------------------------------------------------------------------
describe('getNextPendingControl', () => {
  beforeEach(() => resetTables());

  it('returns lower priority number first', () => {
    const low = mod.insertControl('low prio', { priority: 1 });
    const high = mod.insertControl('high prio', { priority: 0 });
    const next = mod.getNextPendingControl();
    assert.equal(next.id, high.id);
  });

  it('returns FIFO within same priority', () => {
    const first = mod.insertControl('first');
    const second = mod.insertControl('second');
    const next = mod.getNextPendingControl();
    assert.equal(next.id, first.id);
  });

  it('respects available_at filter', () => {
    const now = Math.floor(Date.now() / 1000);
    mod.insertControl('future', { availableAt: now + 3600 });
    const ready = mod.insertControl('ready');
    const next = mod.getNextPendingControl(now);
    assert.equal(next.id, ready.id);
  });

  it('skips non-pending records', () => {
    const first = mod.insertControl('first');
    mod.claimControl(first.id); // pending -> running
    const second = mod.insertControl('second');
    const next = mod.getNextPendingControl();
    assert.equal(next.id, second.id);
  });

  it('returns null when no pending records exist', () => {
    const next = mod.getNextPendingControl();
    assert.equal(next, null);
  });
});

// ---------------------------------------------------------------------------
// claimControl
// ---------------------------------------------------------------------------
describe('claimControl', () => {
  beforeEach(() => resetTables());

  it('transitions pending to running and returns true', () => {
    const rec = mod.insertControl('claim me');
    const ok = mod.claimControl(rec.id);
    assert.equal(ok, true);
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'running');
  });

  it('returns false for non-pending record', () => {
    const rec = mod.insertControl('claim me');
    mod.claimControl(rec.id); // now running
    const ok = mod.claimControl(rec.id); // already running
    assert.equal(ok, false);
  });

  it('concurrent claims: only one succeeds', () => {
    const rec = mod.insertControl('race');
    const r1 = mod.claimControl(rec.id);
    const r2 = mod.claimControl(rec.id);
    assert.equal(r1, true);
    assert.equal(r2, false);
  });
});

// ---------------------------------------------------------------------------
// requeueControl
// ---------------------------------------------------------------------------
describe('requeueControl', () => {
  beforeEach(() => resetTables());

  it('transitions running back to pending', () => {
    const rec = mod.insertControl('requeue me');
    mod.claimControl(rec.id);
    mod.requeueControl(rec.id);
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'pending');
  });

  it('stores lastError when provided', () => {
    const rec = mod.insertControl('fail then requeue');
    mod.claimControl(rec.id);
    mod.requeueControl(rec.id, 'something broke');
    const row = mod.getControlById(rec.id);
    assert.equal(row.last_error, 'something broke');
  });
});

// ---------------------------------------------------------------------------
// ackControl
// ---------------------------------------------------------------------------
describe('ackControl', () => {
  beforeEach(() => resetTables());

  it('transitions pending to done', () => {
    const rec = mod.insertControl('ack pending');
    const result = mod.ackControl(rec.id);
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, false);
    assert.equal(result.status, 'done');
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'done');
  });

  it('transitions running to done', () => {
    const rec = mod.insertControl('ack running');
    mod.claimControl(rec.id);
    const result = mod.ackControl(rec.id);
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, false);
    assert.equal(result.status, 'done');
  });

  it('is idempotent on done (alreadyFinal=true)', () => {
    const rec = mod.insertControl('idempotent');
    mod.ackControl(rec.id); // done
    const result = mod.ackControl(rec.id); // again
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, true);
    assert.equal(result.status, 'done');
  });

  it('detects timeout when ack_deadline_at is exceeded', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const rec = mod.insertControl('overdue ack', { ackDeadlineAt: past });
    const result = mod.ackControl(rec.id);
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, true);
    assert.equal(result.status, 'timeout');
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'timeout');
  });

  it('returns found=false for nonexistent id', () => {
    const result = mod.ackControl(999999);
    assert.equal(result.found, false);
  });
});

// ---------------------------------------------------------------------------
// retryOrFailControl
// ---------------------------------------------------------------------------
describe('retryOrFailControl', () => {
  beforeEach(() => resetTables());

  it('increments retry_count and requeues to pending', () => {
    const rec = mod.insertControl('retry me');
    const result = mod.retryOrFailControl(rec.id, 'err1', 3);
    assert.equal(result.status, 'pending');
    assert.equal(result.retry_count, 1);
    const row = mod.getControlById(rec.id);
    assert.equal(row.retry_count, 1);
    assert.equal(row.last_error, 'err1');
  });

  it('marks as failed when max retries exceeded', () => {
    const rec = mod.insertControl('fail me');
    mod.retryOrFailControl(rec.id, 'err1', 3); // retry_count=1
    mod.retryOrFailControl(rec.id, 'err2', 3); // retry_count=2
    const result = mod.retryOrFailControl(rec.id, 'err3', 3); // retry_count=3 >= 3
    assert.equal(result.status, 'failed');
    assert.equal(result.retry_count, 3);
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error, 'err3');
  });

  it('returns null for nonexistent id', () => {
    const result = mod.retryOrFailControl(999999, 'nope', 3);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// expireTimedOutControls
// ---------------------------------------------------------------------------
describe('expireTimedOutControls', () => {
  beforeEach(() => resetTables());

  it('expires overdue pending and running records', () => {
    const now = Math.floor(Date.now() / 1000);
    const pastDeadline = now - 100;

    // pending with past deadline
    mod.insertControl('pending overdue', { ackDeadlineAt: pastDeadline });
    // running with past deadline
    const running = mod.insertControl('running overdue', { ackDeadlineAt: pastDeadline });
    mod.claimControl(running.id);

    const count = mod.expireTimedOutControls(now);
    assert.equal(count, 2);
  });

  it('ignores done and failed records', () => {
    const now = Math.floor(Date.now() / 1000);
    const pastDeadline = now - 100;

    // done record with past deadline
    const done = mod.insertControl('done item', { ackDeadlineAt: pastDeadline });
    mod.ackControl(done.id);
    // failed record with past deadline
    const failed = mod.insertControl('failed item', { ackDeadlineAt: pastDeadline });
    mod.retryOrFailControl(failed.id, 'e', 1);

    const count = mod.expireTimedOutControls(now);
    assert.equal(count, 0);
  });

  it('ignores records with no deadline', () => {
    const now = Math.floor(Date.now() / 1000);
    mod.insertControl('no deadline');
    const count = mod.expireTimedOutControls(now);
    assert.equal(count, 0);
  });
});

// ---------------------------------------------------------------------------
// cleanupControlQueue
// ---------------------------------------------------------------------------
describe('cleanupControlQueue', () => {
  beforeEach(() => resetTables());

  it('deletes old terminal records before cutoff', () => {
    const now = Math.floor(Date.now() / 1000);
    const old = now - 86400 * 30; // 30 days ago

    // Insert an old done record via raw SQL so we control updated_at
    db.prepare(`
      INSERT INTO control_queue (content, priority, require_idle, bypass_state, status, retry_count, created_at, updated_at)
      VALUES ('old done', 0, 0, 0, 'done', 0, ?, ?)
    `).run(old, old);

    const cutoff = now - 86400 * 7; // 7 days
    const deleted = mod.cleanupControlQueue(cutoff);
    assert.equal(deleted, 1);
  });

  it('preserves recent terminal records', () => {
    const now = Math.floor(Date.now() / 1000);
    const rec = mod.insertControl('recent done');
    mod.ackControl(rec.id);

    const cutoff = now - 86400 * 7;
    const deleted = mod.cleanupControlQueue(cutoff);
    assert.equal(deleted, 0);
  });

  it('preserves non-terminal records regardless of age', () => {
    const now = Math.floor(Date.now() / 1000);
    const old = now - 86400 * 30;

    // Old pending record
    db.prepare(`
      INSERT INTO control_queue (content, priority, require_idle, bypass_state, status, retry_count, created_at, updated_at)
      VALUES ('old pending', 0, 0, 0, 'pending', 0, ?, ?)
    `).run(old, old);

    const cutoff = now - 86400 * 7;
    const deleted = mod.cleanupControlQueue(cutoff);
    assert.equal(deleted, 0);
  });
});

// ---------------------------------------------------------------------------
// claimConversation / requeueConversation
// ---------------------------------------------------------------------------
describe('claimConversation', () => {
  beforeEach(() => resetTables());

  it('transitions pending incoming conversation to running', () => {
    const conv = mod.insertConversation('in', 'telegram', '123', 'hello');
    assert.equal(conv.status, 'pending');
    const ok = mod.claimConversation(conv.id);
    assert.equal(ok, true);
  });

  it('returns false for non-pending conversation', () => {
    const conv = mod.insertConversation('in', 'telegram', '123', 'hello');
    mod.claimConversation(conv.id); // now running
    const ok = mod.claimConversation(conv.id);
    assert.equal(ok, false);
  });
});

describe('requeueConversation', () => {
  beforeEach(() => resetTables());

  it('transitions running conversation back to pending', () => {
    const conv = mod.insertConversation('in', 'telegram', '123', 'hello');
    mod.claimConversation(conv.id);
    mod.requeueConversation(conv.id);
    // Verify by claiming again (only works from pending)
    const ok = mod.claimConversation(conv.id);
    assert.equal(ok, true);
  });
});

// ---------------------------------------------------------------------------
// insertConversation
// ---------------------------------------------------------------------------
describe('insertConversation', () => {
  beforeEach(() => resetTables());

  it('defaults incoming status to pending', () => {
    const conv = mod.insertConversation('in', 'telegram', '123', 'hello');
    assert.equal(conv.status, 'pending');
    assert.equal(conv.direction, 'in');
  });

  it('defaults outgoing status to delivered', () => {
    const conv = mod.insertConversation('out', 'telegram', '123', 'reply');
    assert.equal(conv.status, 'delivered');
  });

  it('respects explicit status override', () => {
    const conv = mod.insertConversation('in', 'system', null, 'msg', 'delivered');
    assert.equal(conv.status, 'delivered');
  });

  it('sets requireIdle flag', () => {
    const conv = mod.insertConversation('in', 'scheduler', null, 'task', null, 3, true);
    assert.equal(conv.require_idle, 1);
  });
});
