import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-runs-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  const cleanup = [];
  t.after(() => { for (const close of cleanup.reverse()) close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let seq = 0;
  const event = (runId, day, eventType, metadata = {}, runtime = 'claude', group = 'telegram:a') => {
    const id = `event-${++seq}`;
    const result = store.insertEvent({
      id, ingest_id: id, timestamp: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`,
      runtime, run_id: runId, session_group: group, event_type: eventType, category: 'lifecycle', metadata,
    });
    assert.equal(result.inserted, true, 'the fixture event must be stored');
    return result;
  };
  return { root, store, event, addCleanup: close => cleanup.push(close) };
}

// Integration boundary: imported-event SQLite aggregation and real Store only.
// Run for run grouping/pagination/end reasons; skip rendering-only edits. The
// official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; private DB only,
// no tmux/network/children. Teardown closes Store before removing owned files.

// Integration boundary: supervisor records imported by the real importer into a private Store, then aggregated.
// Run for run end-reason changes; skip rendering-only edits. No tmux/network/children.

// Integration boundary: supervisor records imported by the real importer into a private Store, then counted.
// Run for count changes; skip rendering-only edits. No tmux/network/children.

// Integration boundary: single-mode NULL attribution in the same real event
// store as group runs. Run when single/group routing changes; UI-only edits can
// skip. The official runner and fixture own all paths; no live processes/DBs.

// Integration boundary: a real read-only C4Reader over a private SQLite DB. Run
// for message projection or pagination; skip UI-only changes. The official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; no subprocess/tmux/network. Close
// reader and fixture writer before removing the owned root.
test('group messages expose direction and time without content or internal traffic', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'comm-bridge'));
  const db = new Database(path.join(f.root, 'comm-bridge/c4.db'));
  db.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, session_group TEXT, direction TEXT, channel TEXT, timestamp TEXT, content TEXT)');
  const put = db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)');
  put.run(1, 'telegram:a', 'in', 'telegram', '2026-10-01 12:00:00', 'private original body');
  put.run(2, 'telegram:a', 'out', 'telegram', '2026-10-02 12:00:00', 'private response body');
  put.run(3, 'telegram:a', 'in', 'internal', '2026-10-02 12:00:00', 'private internal');
  put.run(4, 'telegram:b', 'in', 'telegram', '2026-10-02 12:00:00', 'private other group');
  const reader = new C4Reader(f.root);
  f.addCleanup(() => { reader.close(); db.close(); });
  const rows = reader.getGroupMessagePage('telegram:a', new URLSearchParams()).items;
  assert.deepEqual(rows.map(row => row.id), [1, 2]);
  assert.deepEqual(Object.keys(rows[0]), ['id', 'direction', 'channel', 'timestamp']);
  assert.doesNotMatch(JSON.stringify(rows), /private|content/);
  const latest = reader.getGroupMessagePage('telegram:a', new URLSearchParams('limit=1'));
  assert.deepEqual(latest.items.map(row => row.id), [2]);
  assert.deepEqual(reader.getGroupMessagePage('telegram:a', new URLSearchParams({ cursor: latest.nextCursor })).items.map(row => row.id), [1]);
  assert.throws(() => reader._open().prepare('DELETE FROM conversations').run(), /readonly/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 4);
});

// Integration boundary: NULL message attribution in a private read-only C4 DB.
// Run when message scope SQL changes; rendering-only edits can skip.
// Teardown closes both connections before removing the isolated fixture root.

// Core's ranges from an in-memory answer, and a Sync marker file for every group, so each group asks for its status.
const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-backlog-marker-'));
fs.writeFileSync(path.join(markerDir, 'sync.lock'), '{}');
after(() => fs.rmSync(markerDir, { recursive: true, force: true }));
