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
for (const component of ['telegram', 'scheduler']) fs.mkdirSync(path.join(TMP_DIR, '.claude', 'skills', component), { recursive: true });

// Dynamic import so the env var is set before c4-config.js evaluates.
const mod = await import(new URL('../c4-db.js', import.meta.url));
const db = mod.getDb();

// New controls explicitly address Origin. Acknowledged group controls carry a
// deadline; this helper only supplies fixture identity, never legacy API support.
const CONTROL_GROUP = 'origin';
const CONTROL_DEADLINE = Math.floor(Date.now() / 1000) + 86400;
function enqueueTargeted(content, options = {}) {
  return mod.insertControl(content, { sessionGroup: CONTROL_GROUP, ackDeadlineAt: CONTROL_DEADLINE, ...options });
}
function nextTargeted(current = Math.floor(Date.now() / 1000)) {
  return mod.getNextPendingControl(current, { sessionGroups: [CONTROL_GROUP] });
}

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
  db.exec('DELETE FROM group_heads');
  db.exec('DELETE FROM channel_namespaces');
  db.exec('DELETE FROM drain_fences');
  db.exec('DELETE FROM mode_transitions');
  db.exec('DELETE FROM status_notice_cooldowns');
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

  it('inserts a targeted control with delivery defaults and required deadline', () => {
    const rec = enqueueTargeted('do something');
    assert.ok(typeof rec.id === 'number' && rec.id > 0);
    assert.equal(rec.raw_content, 'do something');
    assert.ok(rec.content.startsWith('do something'));
    assert.ok(rec.content.includes('---- ack via:'));
    assert.equal(rec.priority, 3);
    assert.equal(rec.require_idle, 0);
    assert.equal(rec.bypass_state, 0);
    assert.equal(rec.ack_deadline_at, CONTROL_DEADLINE);
    assert.equal(rec.session_group, CONTROL_GROUP);
    assert.equal(rec.status, 'pending');
    assert.equal(rec.retry_count, 0);
    assert.equal(rec.available_at, null);
    assert.ok(typeof rec.created_at === 'number');
    assert.ok(typeof rec.updated_at === 'number');
  });

  it('auto-appends ack suffix with the actual id', () => {
    const rec = enqueueTargeted('Do something.');
    assert.ok(rec.content.includes('---- ack via:'));
    assert.ok(rec.content.includes(`ack --id ${rec.id}`));
    // verify persisted value matches
    const row = mod.getControlById(rec.id);
    assert.ok(row.content.includes(`ack --id ${rec.id}`));
  });

});

// ---------------------------------------------------------------------------
// getControlById
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getNextPendingControl
// ---------------------------------------------------------------------------
describe('getNextPendingControl', () => {
  beforeEach(() => resetTables());

  it('returns lower priority number first', () => {
    const low = enqueueTargeted('low prio', { priority: 1 });
    const high = enqueueTargeted('high prio', { priority: 0 });
    const next = nextTargeted();
    assert.equal(next.id, high.id);
  });

  it('returns FIFO within same priority', () => {
    const first = enqueueTargeted('first');
    const second = enqueueTargeted('second');
    const next = nextTargeted();
    assert.equal(next.id, first.id);
  });

  it('respects available_at filter', () => {
    const now = Math.floor(Date.now() / 1000);
    enqueueTargeted('future', { availableAt: now + 3600 });
    const ready = enqueueTargeted('ready');
    const next = nextTargeted(now);
    assert.equal(next.id, ready.id);
  });

});

// ---------------------------------------------------------------------------
// claimControl
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// requeueControl
// ---------------------------------------------------------------------------
describe('requeueControl', () => {
  beforeEach(() => resetTables());

  it('transitions running back to pending', () => {
    const rec = enqueueTargeted('requeue me');
    mod.claimControl(rec.id);
    mod.requeueControl(rec.id);
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'pending');
  });

});

// ---------------------------------------------------------------------------
// ackControl
// ---------------------------------------------------------------------------
describe('ackControl', () => {
  beforeEach(() => resetTables());

  it('transitions running to done', () => {
    const rec = enqueueTargeted('ack running');
    mod.claimControl(rec.id);
    const result = mod.ackControl(rec.id);
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, false);
    assert.equal(result.status, 'done');
  });

  it('detects timeout when ack_deadline_at is exceeded', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const rec = enqueueTargeted('overdue ack', { ackDeadlineAt: past });
    const result = mod.ackControl(rec.id);
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, true);
    assert.equal(result.status, 'timeout');
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'timeout');
  });

});

// ---------------------------------------------------------------------------
// retryOrFailControl
// ---------------------------------------------------------------------------
describe('retryOrFailControl', () => {
  beforeEach(() => resetTables());

  it('marks as failed when max retries exceeded', () => {
    const rec = enqueueTargeted('fail me');
    mod.claimControl(rec.id);
    mod.retryOrFailControl(rec.id, 'err1', 3); // retry_count=1
    mod.claimControl(rec.id);
    mod.retryOrFailControl(rec.id, 'err2', 3); // retry_count=2
    mod.claimControl(rec.id);
    const result = mod.retryOrFailControl(rec.id, 'err3', 3); // retry_count=3 >= 3
    assert.equal(result.status, 'failed');
    assert.equal(result.retry_count, 3);
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error, 'err3');
  });

  it('does not resurrect a control timed out while delivery was in flight', () => {
    const rec = enqueueTargeted('in flight');
    assert.equal(mod.claimControl(rec.id), true);
    mod.expireTimedOutControls(CONTROL_DEADLINE + 1);
    const before = mod.getControlById(rec.id);
    assert.equal(before.status, 'timeout');
    assert.equal(mod.retryOrFailControl(rec.id, 'late paste failure', 3), null);
    assert.deepEqual(mod.getControlById(rec.id), before);
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
    enqueueTargeted('pending overdue', { ackDeadlineAt: pastDeadline });
    // running with past deadline
    const running = enqueueTargeted('running overdue', { ackDeadlineAt: pastDeadline });
    mod.claimControl(running.id);

    const count = mod.expireTimedOutControls(now);
    assert.equal(count, 2);
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
      INSERT INTO control_queue (raw_content, content, priority, require_idle, bypass_state, status, retry_count, created_at, updated_at)
      VALUES ('old done', 'old done', 0, 0, 0, 'done', 0, ?, ?)
    `).run(old, old);

    db.prepare(`
      INSERT INTO control_queue (raw_content, content, priority, require_idle, bypass_state, status, retry_count, created_at, updated_at)
      VALUES ('old superseded', 'old superseded', 0, 0, 0, 'superseded', 0, ?, ?)
    `).run(old, old);

    const cutoff = now - 86400 * 7; // 7 days
    const deleted = mod.cleanupControlQueue(cutoff);
    assert.equal(deleted, 2);
  });

  it('preserves non-terminal records regardless of age', () => {
    const now = Math.floor(Date.now() / 1000);
    const old = now - 86400 * 30;

    // Old pending record
    db.prepare(`
      INSERT INTO control_queue (raw_content, content, priority, require_idle, bypass_state, status, retry_count, created_at, updated_at)
      VALUES ('old pending', 'old pending', 0, 0, 0, 'pending', 0, ?, ?)
    `).run(old, old);

    const cutoff = now - 86400 * 7;
    const deleted = mod.cleanupControlQueue(cutoff);
    assert.equal(deleted, 0);
  });
});

// ---------------------------------------------------------------------------
// claimConversation / requeueConversation
// ---------------------------------------------------------------------------

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

  it('records delivered incoming status through claim and actual completion', () => {
    const conv = mod.insertConversation('in', 'system', null, 'msg');
    assert.equal(mod.claimConversation(conv.id), true);
    assert.equal(mod.markDelivered(conv.id, { sessionId: 'fixture-session' }), true);
    const stored = db.prepare('SELECT status,session_id FROM conversations WHERE id=?').get(conv.id);
    assert.deepEqual(stored, { status: 'delivered', session_id: 'fixture-session' });
  });

});

// ---------------------------------------------------------------------------
// status notice cooldowns
// ---------------------------------------------------------------------------

describe('Origin demand and drain fence API', () => {
  beforeEach(() => resetTables());

  it('allows Origin TTL but rejects Origin eviction without writing a fence', () => {
    assert.throws(() => mod.setDrainFence('origin', { reason: 'evict', runId: 'origin-run' }), { code: 'FENCE_INVALID' });
    assert.equal(mod.getDrainFence('origin'), null);
    mod.setDrainFence('origin', { reason: 'ttl', runId: 'origin-run' });
    assert.deepEqual(mod.getDrainFence('origin'), {
      sessionGroup: 'origin', reason: 'ttl', runId: 'origin-run', createdAt: mod.getDrainFence('origin').createdAt,
    });
  });

});
