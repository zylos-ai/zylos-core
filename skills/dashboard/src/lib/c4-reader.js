import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export class C4Reader {
  constructor(zylosDir) {
    this._dbPath = path.join(zylosDir, 'comm-bridge', 'c4.db');
    this._db = null;
  }

  _open() {
    if (this._db) return this._db;
    if (!fs.existsSync(this._dbPath)) return null;
    try {
      this._db = new Database(this._dbPath, { readonly: true });
      this._db.pragma('busy_timeout = 3000');
    } catch {
      this._db = null;
    }
    return this._db;
  }

  getTodayStats() {
    const db = this._open();
    if (!db) return null;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const rows = db.prepare(`
        SELECT channel, direction, COUNT(*) as count
        FROM conversations
        WHERE timestamp >= ?
        GROUP BY channel, direction
      `).all(today);

      const channels = {};
      for (const r of rows) {
        if (!channels[r.channel]) channels[r.channel] = { in: 0, out: 0 };
        channels[r.channel][r.direction === 'in' ? 'in' : 'out'] += r.count;
      }

      let totalIn = 0, totalOut = 0;
      for (const r of rows) {
        if (r.direction === 'in') totalIn += r.count;
        else totalOut += r.count;
      }

      return { channels, total_in: totalIn, total_out: totalOut };
    } catch {
      return null;
    }
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

  getPendingQueue() {
    const db = this._open();
    if (!db) return { depth: null, oldest_age_s: null, error: 'READ_FAILED' };
    try {
      const row = db.prepare(`
        SELECT COUNT(*) as depth,
               CAST(strftime('%s','now') - strftime('%s', MIN(timestamp)) AS INTEGER) as oldest_age_s
        FROM conversations
        WHERE direction = 'in' AND status IN ('pending', 'running')
      `).get();

      return {
        depth: row.depth || 0,
        oldest_age_s: row.oldest_age_s ?? null
      };
    } catch {
      return { depth: null, oldest_age_s: null, error: 'READ_FAILED' };
    }
  }

  getLastOutbound() {
    const db = this._open();
    if (!db) return {};
    try {
      const rows = db.prepare(`
        SELECT channel, MAX(timestamp) as last_ts
        FROM conversations
        WHERE direction = 'out'
        GROUP BY channel
      `).all();

      const result = {};
      for (const r of rows) {
        result[r.channel] = r.last_ts ? r.last_ts.replace(' ', 'T') + 'Z' : r.last_ts;
      }
      return result;
    } catch {
      return {};
    }
  }

  getAvgResponseTime() {
    const db = this._open();
    if (!db) return null;
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    if (this._responseTimeCache?.day === today && now - this._responseTimeCache.at < 60_000) {
      return this._responseTimeCache.value;
    }
    try {
      // Incoming rows precede outgoing rows at equal timestamps, preserving
      // the old join's strictly-later response rule. Keep SQLite's date math
      // and exact ten-minute cutoff to avoid changing boundary rounding.
      const rows = db.prepare(`
        SELECT channel, direction, timestamp, julianday(timestamp) AS day
        FROM conversations
        WHERE timestamp >= ? AND direction IN ('in', 'out')
          AND channel NOT IN ('scheduler', 'system', 'control')
        ORDER BY channel, timestamp DESC, direction ASC
      `).all(today);
      let channel = null, nextOutbound = null, total = 0, count = 0;
      for (const row of rows) {
        if (row.channel !== channel) { channel = row.channel; nextOutbound = null; }
        if (row.direction === 'out') { nextOutbound = row; continue; }
        if (!nextOutbound || row.day == null || nextOutbound.day == null) continue;
        const delta = nextOutbound.day - row.day;
        if (delta > 0 && delta < 0.0069444) { total += delta * 86400; count++; }
      }
      const value = count ? Math.round(total / count) : null;
      this._responseTimeCache = { day: today, at: Date.now(), value };
      return value;
    } catch {
      return null;
    }
  }

  getMessageSeries({ since, until, bucketSeconds = 3600, intervals } = {}) {
    const empty = () => ({ points: intervals?.map(({ at }) => ({ at, in: 0, out: 0 })) ?? [], total: { in: 0, out: 0 } });
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
        return { points, total };
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
    this._responseTimeCache = null;
  }
}
