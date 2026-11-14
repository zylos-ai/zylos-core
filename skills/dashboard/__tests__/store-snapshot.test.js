import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/lib/store.js';

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
  const dbPath = path.join(dir, 'test.db');
  const store = new Store(dbPath);
  return { store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('Store saveSnapshot/latestSnapshot round-trip includes last_progress_at', () => {
  const { store, cleanup } = makeTempStore();
  try {
    const now = new Date().toISOString();
    store.saveSnapshot({
      runtime: 'claude',
      session_id: 'test-session',
      running_tool: JSON.stringify({ tools: {} }),
      open_turn: null,
      pending_permission: null,
      last_progress_cursor: 42,
      last_message: null,
      last_prompt: null,
      last_progress_at: now
    });

    const snapshot = store.latestSnapshot('claude', 'test-session');
    assert.ok(snapshot, 'snapshot should exist');
    assert.equal(Object.hasOwn(snapshot, 'possibly_stuck_since'), false);
    assert.equal(snapshot.last_progress_at, now);
    assert.equal(snapshot.last_progress_cursor, 42);
  } finally {
    cleanup();
  }
});

test('Store saveSnapshot works with null last_progress_at', () => {
  const { store, cleanup } = makeTempStore();
  try {
    store.saveSnapshot({
      runtime: 'claude',
      session_id: null,
      running_tool: null,
      open_turn: null,
      pending_permission: null,
      last_progress_cursor: 0,
      last_message: null,
      last_prompt: null,
      last_progress_at: null
    });

    const snapshot = store.latestSnapshot('claude', null);
    assert.ok(snapshot, 'snapshot should exist');
    assert.equal(Object.hasOwn(snapshot, 'possibly_stuck_since'), false);
    assert.equal(snapshot.last_progress_at, null);
  } finally {
    cleanup();
  }
});

// Retained-schema boundary: old rows may contain a timestamp, but current
// readers omit it and current writes leave the retired storage at its default.
test('snapshot storage tolerates retired values without exposing or copying them', () => {
  const { store, cleanup } = makeTempStore();
  try {
    store.db.prepare(`INSERT INTO state_snapshots
      (runtime, session_id, possibly_stuck_since, last_progress_cursor)
      VALUES (?, ?, ?, ?)`).run('claude', 'old-session', '2020-01-01T00:00:00.000Z', 1);
    const previous = store.latestSnapshot('claude', 'old-session');
    assert.equal(previous.last_progress_cursor, 1);
    assert.equal(Object.hasOwn(previous, 'possibly_stuck_since'), false);
    store.saveSnapshot({ runtime: 'claude', session_id: 'new-session',
      last_progress_cursor: 2, possibly_stuck_since: '2020-01-01T00:00:00.000Z' });
    const stored = store.db.prepare('SELECT possibly_stuck_since FROM state_snapshots WHERE session_id = ?').get('new-session');
    assert.equal(stored.possibly_stuck_since, null);
  } finally {
    store.close();
    cleanup();
  }
});
