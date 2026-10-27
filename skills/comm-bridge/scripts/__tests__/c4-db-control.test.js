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
function seedHistoricalMachineControl(content) {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`INSERT INTO control_queue(raw_content,content,status,created_at,updated_at)
    VALUES(?,?,'pending',?,?)`).run(content, content, now, now);
  return db.prepare('SELECT * FROM control_queue WHERE id=?').get(Number(result.lastInsertRowid));
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

  it('supports appendAckSuffix=false for clean slash controls', () => {
    const rec = enqueueTargeted('/clear', { appendAckSuffix: false });
    assert.equal(rec.raw_content, '/clear');
    assert.equal(rec.content, '/clear');
    const row = mod.getControlById(rec.id);
    assert.equal(row.content, '/clear');
  });

  it('populates all options when provided', () => {
    const rec = enqueueTargeted('full opts', {
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
    const a = enqueueTargeted('a');
    const b = enqueueTargeted('b');
    assert.equal(b.id, a.id + 1);
  });

  it('supersedes older equivalent pending controls', () => {
    const first = enqueueTargeted('repeat me');
    const second = enqueueTargeted('repeat me');

    const oldRow = mod.getControlById(first.id);
    const newRow = mod.getControlById(second.id);

    assert.equal(first.superseded_count, 0);
    assert.equal(second.superseded_count, 1);
    assert.equal(oldRow.status, 'superseded');
    assert.equal(newRow.status, 'pending');
  });

  it('supersedes older pending controls even when other delivery options differ', () => {
    const base = enqueueTargeted('same content', { priority: 2 });
    const replacement = enqueueTargeted('same content', { priority: 3, requireIdle: true, bypassState: true });

    assert.equal(replacement.superseded_count, 1);
    assert.equal(mod.getControlById(base.id).status, 'superseded');
    assert.equal(mod.getControlById(replacement.id).status, 'pending');
  });

  it('does not supersede running or final controls', () => {
    const running = enqueueTargeted('same content');
    mod.claimControl(running.id);

    const done = enqueueTargeted('same content');
    mod.ackControl(done.id);

    const replacement = enqueueTargeted('same content');

    assert.equal(mod.getControlById(running.id).status, 'running');
    assert.equal(mod.getControlById(done.id).status, 'done');
    assert.equal(replacement.superseded_count, 0);
    assert.equal(mod.getControlById(replacement.id).status, 'pending');
  });

  it('does not supersede failed or timeout controls', () => {
    const failed = enqueueTargeted('same content');
    mod.claimControl(failed.id);
    mod.claimControl(failed.id);
    mod.retryOrFailControl(failed.id, 'boom', 1);

    const timedOut = enqueueTargeted('same content', { ackDeadlineAt: Math.floor(Date.now() / 1000) - 5 });
    mod.expireTimedOutControls();

    const replacement = enqueueTargeted('same content');

    assert.equal(mod.getControlById(failed.id).status, 'failed');
    assert.equal(mod.getControlById(timedOut.id).status, 'timeout');
    assert.equal(replacement.superseded_count, 0);
    assert.equal(mod.getControlById(replacement.id).status, 'pending');
  });

  it('strips only a trailing ack suffix when backfilling raw_content', () => {
    assert.equal(
      mod.stripTrailingAckSuffix('literal ---- ack via: inside body ---- ack via: node /tmp/c4-control.js ack --id 7'),
      'literal ---- ack via: inside body'
    );
    assert.equal(
      mod.stripTrailingAckSuffix('literal ---- ack via: inside body'),
      'literal ---- ack via: inside body'
    );
  });
});

// ---------------------------------------------------------------------------
// getControlById
// ---------------------------------------------------------------------------
describe('getControlById', () => {
  beforeEach(() => resetTables());

  it('returns the record when found', () => {
    const rec = enqueueTargeted('findme');
    const row = mod.getControlById(rec.id);
    assert.ok(row);
    assert.equal(row.id, rec.id);
    assert.ok(row.content.startsWith('findme'));
    assert.equal(row.session_group, CONTROL_GROUP);
    assert.equal(row.target_binding, null);
  });

  it('preserves the persisted target identity when reading by id', () => {
    const targetBinding = { expectedRunId: 'run-1', tmuxTarget: { serverGeneration: 'generation-1', sessionId: '$1', paneId: '%2' } };
    const rec = enqueueTargeted('bound', { targetBinding });
    const row = mod.getControlById(rec.id);
    assert.equal(row.session_group, CONTROL_GROUP);
    assert.deepEqual(JSON.parse(row.target_binding), targetBinding);
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

  it('skips superseded records', () => {
    enqueueTargeted('dupe');
    const latest = enqueueTargeted('dupe');
    const next = nextTargeted();
    assert.equal(next.id, latest.id);
  });

  it('respects available_at filter', () => {
    const now = Math.floor(Date.now() / 1000);
    enqueueTargeted('future', { availableAt: now + 3600 });
    const ready = enqueueTargeted('ready');
    const next = nextTargeted(now);
    assert.equal(next.id, ready.id);
  });

  it('skips non-pending records', () => {
    const first = enqueueTargeted('first');
    mod.claimControl(first.id); // pending -> running
    const second = enqueueTargeted('second');
    const next = nextTargeted();
    assert.equal(next.id, second.id);
  });

  it('returns null when no pending records exist', () => {
    const next = nextTargeted();
    assert.equal(next, null);
  });

  it('no-options selector reads only historical machine controls', () => {
    enqueueTargeted('targeted');
    assert.equal(mod.getNextPendingControl(), null);
    const machine = seedHistoricalMachineControl('legacy machine');
    assert.equal(mod.getNextPendingControl().id, machine.id);
    assert.notEqual(nextTargeted().id, machine.id);
  });
});

// ---------------------------------------------------------------------------
// claimControl
// ---------------------------------------------------------------------------
describe('claimControl', () => {
  beforeEach(() => resetTables());

  it('transitions pending to running and returns true', () => {
    const rec = enqueueTargeted('claim me');
    const ok = mod.claimControl(rec.id);
    assert.equal(ok, true);
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'running');
  });

  it('returns false for non-pending record', () => {
    const rec = enqueueTargeted('claim me');
    mod.claimControl(rec.id); // now running
    const ok = mod.claimControl(rec.id); // already running
    assert.equal(ok, false);
  });

  it('repeated claims: only one succeeds', () => {
    const rec = enqueueTargeted('race');
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
    const rec = enqueueTargeted('requeue me');
    mod.claimControl(rec.id);
    mod.requeueControl(rec.id);
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'pending');
  });

  it('stores lastError when provided', () => {
    const rec = enqueueTargeted('fail then requeue');
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
    const rec = enqueueTargeted('ack pending');
    const result = mod.ackControl(rec.id);
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, false);
    assert.equal(result.status, 'done');
    const row = mod.getControlById(rec.id);
    assert.equal(row.status, 'done');
  });

  it('transitions running to done', () => {
    const rec = enqueueTargeted('ack running');
    mod.claimControl(rec.id);
    const result = mod.ackControl(rec.id);
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, false);
    assert.equal(result.status, 'done');
  });

  it('is idempotent on done (alreadyFinal=true)', () => {
    const rec = enqueueTargeted('idempotent');
    mod.ackControl(rec.id); // done
    const result = mod.ackControl(rec.id); // again
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, true);
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

  it('returns found=false for nonexistent id', () => {
    const result = mod.ackControl(999999);
    assert.equal(result.found, false);
  });

  it('treats superseded as an already-final state', () => {
    const first = enqueueTargeted('dupe');
    const second = enqueueTargeted('dupe');
    const result = mod.ackControl(first.id);

    assert.equal(second.status, 'pending');
    assert.equal(result.found, true);
    assert.equal(result.alreadyFinal, true);
    assert.equal(result.status, 'superseded');
  });
});

// ---------------------------------------------------------------------------
// retryOrFailControl
// ---------------------------------------------------------------------------
describe('retryOrFailControl', () => {
  beforeEach(() => resetTables());

  it('increments retry_count and requeues to pending', () => {
    const rec = enqueueTargeted('retry me');
    mod.claimControl(rec.id);
    const result = mod.retryOrFailControl(rec.id, 'err1', 3);
    assert.equal(result.status, 'pending');
    assert.equal(result.retry_count, 1);
    const row = mod.getControlById(rec.id);
    assert.equal(row.retry_count, 1);
    assert.equal(row.last_error, 'err1');
  });

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

  it('only retries a claimed running control', () => {
    for (const status of ['pending', 'done', 'failed', 'superseded']) {
      const rec = enqueueTargeted(`state ${status}`);
      db.prepare('UPDATE control_queue SET status=? WHERE id=?').run(status, rec.id);
      const before = mod.getControlById(rec.id);
      assert.equal(mod.retryOrFailControl(rec.id, 'late failure', 1), null);
      assert.deepEqual(mod.getControlById(rec.id), before);
    }
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
    enqueueTargeted('pending overdue', { ackDeadlineAt: pastDeadline });
    // running with past deadline
    const running = enqueueTargeted('running overdue', { ackDeadlineAt: pastDeadline });
    mod.claimControl(running.id);

    const count = mod.expireTimedOutControls(now);
    assert.equal(count, 2);
  });

  it('ignores done and failed records', () => {
    const now = Math.floor(Date.now() / 1000);
    const pastDeadline = now - 100;

    // done record with past deadline
    const done = enqueueTargeted('done item');
    mod.ackControl(done.id);
    db.prepare('UPDATE control_queue SET ack_deadline_at=? WHERE id=?').run(pastDeadline, done.id);
    assert.equal(mod.getControlById(done.id).status, 'done');
    // failed record with past deadline
    const failed = enqueueTargeted('failed item', { ackDeadlineAt: pastDeadline });
    mod.claimControl(failed.id);
    mod.retryOrFailControl(failed.id, 'e', 1);

    const count = mod.expireTimedOutControls(now);
    assert.equal(count, 0);
  });

  it('ignores superseded records', () => {
    const now = Math.floor(Date.now() / 1000);
    const pastDeadline = now - 100;
    enqueueTargeted('dupe', { ackDeadlineAt: pastDeadline });
    enqueueTargeted('dupe', { ackDeadlineAt: pastDeadline });

    const count = mod.expireTimedOutControls(now);
    assert.equal(count, 1);
  });

  it('ignores records with no deadline', () => {
    const now = Math.floor(Date.now() / 1000);
    const legacy = seedHistoricalMachineControl('no deadline');
    assert.equal(legacy.session_group, null);
    assert.equal(legacy.ack_deadline_at, null);
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

  it('preserves recent terminal records', () => {
    const now = Math.floor(Date.now() / 1000);
    const rec = enqueueTargeted('recent done');
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

  it('accepts explicit failed intake and rejects delivered intake', () => {
    const conv = mod.insertConversation('in', 'system', null, 'msg', { status: 'failed' });
    assert.equal(conv.status, 'failed');
    assert.throws(() => mod.insertConversation('in', 'system', null, 'msg', { status: 'delivered' }), { code: 'INVALID_ARGS' });
  });

  it('records delivered incoming status through claim and actual completion', () => {
    const conv = mod.insertConversation('in', 'system', null, 'msg');
    assert.equal(mod.claimConversation(conv.id), true);
    assert.equal(mod.markDelivered(conv.id, { sessionId: 'fixture-session' }), true);
    const stored = db.prepare('SELECT status,session_id FROM conversations WHERE id=?').get(conv.id);
    assert.deepEqual(stored, { status: 'delivered', session_id: 'fixture-session' });
  });

  it('sets requireIdle flag', () => {
    const conv = mod.insertConversation('in', 'scheduler', null, 'task', { requireIdle: true });
    assert.equal(conv.require_idle, 1);
  });

  it('records delivery action metadata', () => {
    const conv = mod.insertConversation('in', 'telegram', '123', 'msg', { status: 'failed', deliveryAction: 'suppressed' });
    assert.equal(conv.delivery_action, 'suppressed');

    const row = db.prepare('SELECT delivery_action FROM conversations WHERE id = ?').get(conv.id);
    assert.equal(row.delivery_action, 'suppressed');
  });
});

// ---------------------------------------------------------------------------
// status notice cooldowns
// ---------------------------------------------------------------------------
describe('status notice cooldowns', () => {
  beforeEach(() => resetTables());

  it('reserves the first cooldown and suppresses repeats', () => {
    const first = mod.reserveStatusNoticeCooldown({
      cooldownKey: 'telegram::123::unavailable::down',
      channel: 'telegram',
      endpoint: '123',
      statusType: 'unavailable',
      reason: 'down',
      ttl: 600,
      now: 1000
    });
    const second = mod.reserveStatusNoticeCooldown({
      cooldownKey: 'telegram::123::unavailable::down',
      channel: 'telegram',
      endpoint: '123',
      statusType: 'unavailable',
      reason: 'down',
      ttl: 600,
      now: 1001
    });

    assert.equal(first.suppressed, false);
    assert.equal(first.reservedAt, 1000);
    assert.equal(second.suppressed, true);
    assert.equal(second.previous.last_notified_at, 1000);
  });

  it('clears only the matching reservation timestamp', () => {
    const reserved = mod.reserveStatusNoticeCooldown({
      cooldownKey: 'telegram::123::unavailable::down',
      channel: 'telegram',
      endpoint: '123',
      statusType: 'unavailable',
      reason: 'down',
      ttl: 600,
      now: 1000
    });

    mod.clearStatusNoticeCooldownReservation(reserved.key, 999);
    assert.equal(mod.getStatusNoticeCooldowns().length, 1);

    mod.clearStatusNoticeCooldownReservation(reserved.key, 1000);
    assert.equal(mod.getStatusNoticeCooldowns().length, 0);
  });
});
