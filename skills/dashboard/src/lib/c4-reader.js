import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import path from 'node:path';
import fs from 'node:fs';

export class C4Reader {
  constructor(zylosDir) {
    this._dbPath = path.join(zylosDir, 'comm-bridge', 'c4.db');
    this._db = null;
    this._fileIdentity = null;
    this._generation = 0;
  }

  _open() {
    if (this._db) {
      let identity = null;
      try { const stat = fs.statSync(this._dbPath); identity = `${stat.dev}:${stat.ino}`; } catch { /* missing */ }
      if (identity === this._fileIdentity) return this._db;
      this.close();
    }
    if (!fs.existsSync(this._dbPath)) return null;
    try {
      const before = fs.statSync(this._dbPath);
      this._db = new Database(this._dbPath, { readonly: true });
      this._db.pragma('busy_timeout = 3000');
      const stat = fs.statSync(this._dbPath);
      if (before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('Database replaced while opening');
      this._fileIdentity = `${stat.dev}:${stat.ino}`;
      this._generation++;
    } catch {
      try { this._db?.close(); } catch { /* failed open */ }
      this._db = null;
      this._fileIdentity = null;
    }
    return this._db;
  }

  // data_version observes commits made by other connections. File identity,
  // rather than mtime, prevents a replaced database from leaving a stale handle.
  readVersion() {
    try {
      const stat = fs.statSync(this._dbPath);
      const identity = `${stat.dev}:${stat.ino}`;
      if (this._db && identity !== this._fileIdentity) this.close();
      const db = this._open();
      if (!db) return null;
      const version = db.pragma('data_version', { simple: true });
      if (!Number.isSafeInteger(version)) return null;
      return { generation: this._generation, version };
    } catch {
      this.close();
      return null;
    }
  }

  listSlotOccupancy(now = Date.now()) {
    const failure = () => new Error('Pool occupancy unavailable');
    const db = this._open();
    if (!db) throw failure();
    try {
      return db.prepare(`SELECT session_group AS sessionGroup, run_id AS runId, state,
        held_until AS heldUntil, created_at AS createdAt FROM slot_occupancy
        WHERE state='running' OR held_until > ? ORDER BY session_group COLLATE BINARY`).all(Math.floor(now / 1000));
    } catch { throw failure(); }
  }

  getInboundTimes({ since, groups }) {
    if (!groups.length) return [];
    const failure = () => Object.assign(new Error('Inbound activity unavailable'), { code: 'READ_FAILED', reason: 'READ_FAILED', statusCode: 502 });
    const db = this._open();
    if (!db) throw failure();
    try {
      return db.prepare(`SELECT session_group, timestamp FROM conversations
        WHERE direction='in' AND channel<>'internal'
          AND timestamp >= ?
          AND session_group IN (${groups.map(() => '?').join(',')})
        ORDER BY timestamp, id`).all(new Date(since).toISOString().slice(0, 19).replace('T', ' '), ...groups).map(row => ({
          session_group: row.session_group,
          timestamp: Date.parse(row.timestamp.includes('T') ? row.timestamp : row.timestamp.replace(' ', 'T') + 'Z'),
        }));
    } catch { throw failure(); }
  }

  getGroupMessages(key, { since = 0, until = Date.now() } = {}) {
    const failure = () => Object.assign(new Error('Group messages unavailable'), { code: 'READ_FAILED', statusCode: 502 });
    const db = this._open();
    if (!db) throw failure();
    const bound = value => {
      const parsed = typeof value === 'number' ? value : Date.parse(value);
      if (!Number.isFinite(parsed)) throw Object.assign(new Error('Invalid message time range'), { code: 'INVALID_ARGUMENT', statusCode: 400 });
      return new Date(parsed).toISOString().slice(0, 19).replace('T', ' ');
    };
    const start = bound(since), end = bound(until);
    try {
      return db.prepare(`SELECT id, direction, channel, timestamp FROM conversations
        WHERE session_group IS ? AND channel <> 'internal' AND timestamp BETWEEN ? AND ?
        ORDER BY id`).all(key, start, end);
    } catch { throw failure(); }
  }

  getMessageSeries({ since, until, bucketSeconds = 3600, intervals } = {}) {
    const sampledAt = intervals ? new Date().toISOString() : null;
    const empty = () => intervals
      ? { points: intervals.map(({ at }) => ({ at, in: null, out: null })),
        total: { in: null, out: null }, reason: 'messages_unreadable', sampledAt }
      : { points: [], total: { in: 0, out: 0 } };
    const db = this._open();
    if (!db) return empty();
    try {
      if (intervals) {
        if (!intervals.length) return { points: [], total: { in: 0, out: 0 } };
        const parameters = { since, until };
        const branch = (first, last) => {
          if (first === last) return String(first);
          const middle = Math.floor((first + last + 1) / 2);
          parameters[`edge${middle}`] = intervals[middle].since;
          return `CASE WHEN stamp < julianday(@edge${middle}) THEN ${branch(first, middle - 1)} ELSE ${branch(middle, last)} END`;
        };
        // Convert the mixed C4 timestamp formats once per row, then assign the
        // precomputed calendar intervals in one query instead of scanning daily.
        const rows = db.prepare(`WITH messages AS MATERIALIZED (
          SELECT julianday(timestamp) AS stamp, direction FROM conversations
          WHERE julianday(timestamp) BETWEEN julianday(@since) AND julianday(@until)
        ) SELECT ${branch(0, intervals.length - 1)} AS slot,
          SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS msg_in,
          SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS msg_out
          FROM messages GROUP BY slot ORDER BY slot`).all(parameters);
        const points = intervals.map(({ at }) => ({ at, in: 0, out: 0 }));
        const total = { in: 0, out: 0 };
        for (const row of rows) {
          points[row.slot].in = row.msg_in;
          points[row.slot].out = row.msg_out;
          total.in += row.msg_in;
          total.out += row.msg_out;
        }
        return { points, total, reason: null, sampledAt };
      }
      const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);
      const untilEpoch = Math.floor(new Date(until).getTime() / 1000);

      const sql = `
        SELECT (CAST(CAST(strftime('%s', timestamp) AS INTEGER) / @bucket AS INTEGER) * @bucket) AS bucket_start,
               SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS msg_in,
               SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS msg_out
        FROM conversations
        WHERE CAST(strftime('%s', timestamp) AS INTEGER) >= @sinceEpoch
          AND CAST(strftime('%s', timestamp) AS INTEGER) <= @untilEpoch
        GROUP BY bucket_start ORDER BY bucket_start`;
      const points = db.prepare(sql).all({ sinceEpoch, untilEpoch, bucket: bucketSeconds });

      const totalSql = `
        SELECT SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS total_in,
               SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS total_out
        FROM conversations
        WHERE CAST(strftime('%s', timestamp) AS INTEGER) >= @sinceEpoch
          AND CAST(strftime('%s', timestamp) AS INTEGER) <= @untilEpoch`;
      const totRow = db.prepare(totalSql).get({ sinceEpoch, untilEpoch });

      return {
        points,
        total: { in: totRow?.total_in || 0, out: totRow?.total_out || 0 }
      };
    } catch {
      return empty();
    }
  }

  close() {
    this._db?.close();
    this._db = null;
    this._fileIdentity = null;
  }
}
