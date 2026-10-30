import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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

test('C4Reader — getPendingQueue age uses UTC (no timezone drift)', () => {
  const f = makeFixture();
  try {
    f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (datetime('now', '-7 minutes'), 'in', 'telegram', 'test msg', 'pending')
    `).run();

    const result = f.reader.getPendingQueue();
    assert.equal(result.depth, 1);
    assert.ok(result.oldest_age_s >= 400 && result.oldest_age_s <= 500,
      `expected ~420s, got ${result.oldest_age_s}s`);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getPendingQueue returns null age when no pending', () => {
  const f = makeFixture();
  try {
    f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (datetime('now'), 'in', 'telegram', 'delivered msg', 'delivered')
    `).run();

    const result = f.reader.getPendingQueue();
    assert.equal(result.depth, 0);
    assert.equal(result.oldest_age_s, null);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getLastOutbound returns ISO UTC timestamps', () => {
  const f = makeFixture();
  try {
    f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (datetime('now', '-3 minutes'), 'out', 'telegram', 'reply', 'delivered')
    `).run();

    const result = f.reader.getLastOutbound();
    assert.ok(result.telegram, 'expected telegram key');
    assert.ok(result.telegram.endsWith('Z'), `expected UTC suffix, got: ${result.telegram}`);
    assert.ok(result.telegram.includes('T'), `expected ISO format, got: ${result.telegram}`);

    const parsed = new Date(result.telegram);
    const ageMs = Date.now() - parsed.getTime();
    const ageSec = Math.floor(ageMs / 1000);
    assert.ok(ageSec >= 150 && ageSec <= 240,
      `expected ~180s age, got ${ageSec}s (parsed=${parsed.toISOString()})`);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getTodayStats counts by channel and direction', () => {
  const f = makeFixture();
  try {
    const ins = f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (datetime('now'), ?, ?, 'msg', 'delivered')
    `);
    ins.run('in', 'telegram');
    ins.run('in', 'telegram');
    ins.run('out', 'telegram');
    ins.run('in', 'lark');

    const result = f.reader.getTodayStats();
    assert.ok(result);
    assert.equal(result.channels.telegram.in, 2);
    assert.equal(result.channels.telegram.out, 1);
    assert.equal(result.channels.lark.in, 1);
    assert.equal(result.total_in, 3);
    assert.equal(result.total_out, 1);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getAvgResponseTime computes from in/out pairs', () => {
  const f = makeFixture();
  try {
    const ins = f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (?, ?, ?, 'msg', 'delivered')
    `);
    ins.run(new Date(Date.now() - 60000).toISOString().replace('T', ' ').slice(0, 19), 'in', 'telegram');
    ins.run(new Date(Date.now() - 50000).toISOString().replace('T', ' ').slice(0, 19), 'out', 'telegram');
    ins.run(new Date(Date.now() - 30000).toISOString().replace('T', ' ').slice(0, 19), 'in', 'telegram');
    ins.run(new Date(Date.now() - 10000).toISOString().replace('T', ' ').slice(0, 19), 'out', 'telegram');

    const result = f.reader.getAvgResponseTime();
    assert.ok(result != null, 'expected a numeric result');
    assert.ok(result >= 5 && result <= 25, `expected ~15s avg, got ${result}s`);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getAvgResponseTime excludes scheduler/system channels', () => {
  const f = makeFixture();
  try {
    const ins = f.db.prepare(`
      INSERT INTO conversations (timestamp, direction, channel, content, status)
      VALUES (?, ?, ?, 'msg', 'delivered')
    `);
    ins.run(new Date(Date.now() - 60000).toISOString().replace('T', ' ').slice(0, 19), 'in', 'scheduler');
    ins.run(new Date(Date.now() - 50000).toISOString().replace('T', ' ').slice(0, 19), 'out', 'scheduler');

    const result = f.reader.getAvgResponseTime();
    assert.equal(result, null, 'scheduler-only traffic should return null');
  } finally {
    cleanup(f);
  }
});

test('C4Reader — getAvgResponseTime returns null when no data', () => {
  const f = makeFixture();
  try {
    const result = f.reader.getAvgResponseTime();
    assert.equal(result, null);
  } finally {
    cleanup(f);
  }
});

test('C4Reader — missing db returns safe defaults', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-reader-nodir-'));
  const reader = new C4Reader(tmpDir);
  try {
    assert.equal(reader.getTodayStats(), null);
    assert.deepEqual(reader.getPendingQueue(), { depth: null, oldest_age_s: null, error: 'READ_FAILED' });
    assert.deepEqual(reader.getLastOutbound(), {});
    assert.equal(reader.getAvgResponseTime(), null);
  } finally {
    reader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('C4Reader — a readable database with an invalid queue schema reports a read failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-reader-schema-'));
  const commDir = path.join(tmpDir, 'comm-bridge');
  fs.mkdirSync(commDir, { recursive: true });
  new Database(path.join(commDir, 'c4.db')).close();
  const reader = new C4Reader(tmpDir);
  try {
    assert.deepEqual(reader.getPendingQueue(), { depth: null, oldest_age_s: null, error: 'READ_FAILED' });
  } finally {
    reader.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('average response matches the previous SQL on ties, channels and cutoff; caches for 60s', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-27T12:00:00Z') });
  const f = makeFixture();
  try {
    const put = f.db.prepare("INSERT INTO conversations(timestamp,direction,channel,content) VALUES (?,?,?,'x')");
    const entries = [
      ['00:00:00', 'in', 'telegram'], ['00:00:00', 'out', 'telegram'],
      ['00:00:04', 'in', 'telegram'], ['00:00:05', 'out', 'telegram'],
      ['00:00:05', 'out', 'telegram'], ['00:00:05', 'in', 'telegram'],
      ['00:00:07', 'out', 'telegram'], ['01:00:00', 'in', 'telegram'],
      ['01:10:00', 'out', 'telegram'], ['02:00:00', 'in', 'lark'],
      ['02:09:59', 'out', 'lark'], ['03:00:00', 'in', 'unanswered'],
      ['00:00:00', 'in', 'system'], ['00:00:01', 'out', 'system']
    ];
    for (const [time, direction, channel] of entries) put.run(`2026-10-27 ${time}`, direction, channel);
    put.run('2026-10-26 23:59:59', 'in', 'telegram');
    const legacy = () => {
      const { avg_s } = f.db.prepare(`SELECT AVG(response_delay_s) avg_s FROM (
        SELECT i.id, (julianday(MIN(o.timestamp))-julianday(i.timestamp))*86400 response_delay_s
        FROM conversations i JOIN conversations o ON o.channel=i.channel AND o.direction='out'
          AND o.timestamp>i.timestamp AND julianday(o.timestamp)-julianday(i.timestamp)<0.0069444
        WHERE i.direction='in' AND i.timestamp>='2026-10-27' AND i.channel NOT IN ('scheduler','system','control')
        GROUP BY i.id) WHERE response_delay_s>0`).get();
      return avg_s == null ? null : Math.round(avg_s);
    };
    const first = f.reader.getAvgResponseTime();
    assert.equal(first, legacy());
    put.run('2026-10-27 03:00:01', 'out', 'unanswered');
    assert.notEqual(legacy(), first);
    assert.equal(f.reader.getAvgResponseTime(), first);
    t.mock.timers.tick(60_000);
    assert.equal(f.reader.getAvgResponseTime(), legacy());
    t.mock.timers.setTime(new Date('2026-10-28T00:00:00Z').getTime());
    assert.equal(f.reader.getAvgResponseTime(), null);
  } finally { cleanup(f); }
});
