import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { C4Reader } from '../src/lib/c4-reader.js';

function makeFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-reader-test-'));
  const commDir = path.join(tmpDir, 'comm-bridge');
  fs.mkdirSync(commDir, { recursive: true });
  const dbPath = path.join(commDir, 'c4.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      direction TEXT NOT NULL,
      channel TEXT NOT NULL,
      endpoint_id TEXT,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 3,
      require_idle INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0
    );
  `);
  return { tmpDir, db, reader: new C4Reader(tmpDir) };
}

function cleanup(fixture) {
  fixture.reader.close();
  fixture.db.close();
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
}

// The current usage reader owns daily inbound/outbound counts. The retired
// per-channel summary, queue-age and response-latency endpoints have no consumers.
test('calendar message reads count inbound and outbound messages on exact UTC boundaries', () => {
  const f = makeFixture();
  const since = '2026-11-01T00:00:00.000Z', until = '2026-11-01T23:59:59.999Z';
  try {
    const put = f.db.prepare("INSERT INTO conversations(timestamp,direction,channel,content,status) VALUES (?,?,?,'x','delivered')");
    put.run('2026-10-31T23:59:59.999Z', 'in', 'telegram');
    put.run(since, 'in', 'telegram');
    put.run('2026-11-01T00:00:00.562Z', 'in', 'telegram');
    put.run('2026-11-01T12:00:00.000Z', 'in', 'lark');
    put.run(until, 'out', 'telegram');
    put.run('2026-11-02T00:00:00.000Z', 'out', 'telegram');
    const result = f.reader.getMessageSeries({ since, until, intervals: [{ at: since, since, until }] });
    assert.equal(result.reason, null);
    assert.deepEqual(result.total, { in: 3, out: 1 });
    assert.deepEqual(result.points, [{ at: since, in: 3, out: 1 }]);
  } finally { cleanup(f); }
});

// Calendar message read boundary: owned private SQLite only, no live C4. Run
// for interval availability changes; cleanup closes readers and the fixture DB.
test('calendar message reads distinguish missing and failed databases from an empty history', () => {
  const f = makeFixture(), missing = new C4Reader(path.join(f.tmpDir, 'missing'));
  const since = '2026-11-01T00:00:00.000Z', until = '2026-11-02T00:00:00.000Z';
  const options = { since, until, intervals: [{ at: since, since, until }] };
  const unreadable = result => {
    assert.equal(result.reason, 'messages_unreadable');
    assert.equal(Number.isFinite(Date.parse(result.sampledAt)), true);
    assert.deepEqual(result.total, { in: null, out: null });
    assert.deepEqual(result.points, [{ at: since, in: null, out: null }]);
  };
  try {
    unreadable(missing.getMessageSeries(options));
    assert.deepEqual(missing.getMessageSeries({ since, until }), { points: [], total: { in: 0, out: 0 } });
    const empty = f.reader.getMessageSeries(options);
    assert.equal(empty.reason, null);
    assert.deepEqual(empty.total, { in: 0, out: 0 });
    assert.deepEqual(empty.points, [{ at: since, in: 0, out: 0 }]);
    f.db.exec('DROP TABLE conversations');
    unreadable(f.reader.getMessageSeries(options));
    assert.deepEqual(f.reader.getMessageSeries({ since, until }), { points: [], total: { in: 0, out: 0 } });
    f.db.exec('CREATE TABLE conversations(timestamp TEXT, direction TEXT)');
    f.db.prepare('INSERT INTO conversations VALUES(?,?)').run(since, 'in');
    const recovered = f.reader.getMessageSeries(options);
    assert.equal(recovered.reason, null);
    assert.deepEqual(recovered.total, { in: 1, out: 0 });
    assert.deepEqual(recovered.points, [{ at: since, in: 1, out: 0 }]);
  } finally { missing.close(); cleanup(f); }
});
