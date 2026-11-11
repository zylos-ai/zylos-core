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
      possibly_stuck_since: null,
      last_progress_cursor: 42,
      last_message: null,
      last_prompt: null,
      last_progress_at: now
    });

    const snapshot = store.latestSnapshot('claude', 'test-session');
    assert.ok(snapshot, 'snapshot should exist');
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
      possibly_stuck_since: null,
      last_progress_cursor: 0,
      last_message: null,
      last_prompt: null,
      last_progress_at: null
    });

    const snapshot = store.latestSnapshot('claude', null);
    assert.ok(snapshot, 'snapshot should exist');
    assert.equal(snapshot.last_progress_at, null);
  } finally {
    cleanup();
  }
});
