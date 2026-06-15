import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const WC_DATA_DIR = path.join(ZYLOS_DIR, 'web-console');
const DB_PATH = path.join(WC_DATA_DIR, 'web-console.db');

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 30 * 60 * 1000;

function openDb(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      session_token TEXT,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      size_label TEXT,
      mime TEXT,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

export class SessionStore {
  constructor(db, { maxAgeMs = SESSION_MAX_AGE_MS } = {}) {
    this.db = db;
    this.maxAgeMs = maxAgeMs;
    this._stmts = {
      has: db.prepare('SELECT 1 FROM sessions WHERE token = ? AND last_seen_at >= ?'),
      add: db.prepare('INSERT OR REPLACE INTO sessions (token, created_at, last_seen_at) VALUES (?, ?, ?)'),
      del: db.prepare('DELETE FROM sessions WHERE token = ?'),
      delStale: db.prepare('DELETE FROM sessions WHERE token = ? AND last_seen_at < ?'),
      touch: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?'),
      cleanup: db.prepare('DELETE FROM sessions WHERE last_seen_at < ?'),
    };
    this.cleanup();
  }

  has(token) {
    const cutoff = Date.now() - this.maxAgeMs;
    if (this._stmts.has.get(token, cutoff)) return true;
    this._stmts.delStale.run(token, cutoff);
    return false;
  }

  add(token) {
    const now = Date.now();
    this._stmts.add.run(token, now, now);
  }

  create() {
    const token = crypto.randomBytes(32).toString('hex');
    this.add(token);
    return token;
  }

  delete(token) {
    this._stmts.del.run(token);
  }

  touch(token) {
    this._stmts.touch.run(Date.now(), token);
  }

  cleanup() {
    this._stmts.cleanup.run(Date.now() - this.maxAgeMs);
  }

  get maxAgeSec() {
    return Math.floor(this.maxAgeMs / 1000);
  }
}

export class PersistentUploadRegistry {
  constructor(db, { ttlMs = UPLOAD_TTL_MS } = {}) {
    this.db = db;
    this.ttlMs = ttlMs;
    this._stmts = {
      add: db.prepare(`INSERT INTO uploads (id, session_token, path, name, size, size_label, mime, kind, created_at, consumed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
      get: db.prepare('SELECT * FROM uploads WHERE id = ? AND consumed = 0'),
      consume: db.prepare('UPDATE uploads SET consumed = 1 WHERE id = ? AND consumed = 0'),
      restore: db.prepare('UPDATE uploads SET consumed = 0 WHERE id = ?'),
      cleanup: db.prepare('DELETE FROM uploads WHERE consumed = 0 AND created_at < ?'),
    };
  }

  add(entry) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this._stmts.add.run(
      id, entry.sessionId || null, entry.path, entry.name,
      entry.size, entry.sizeLabel || null, entry.mime || null,
      entry.kind, now
    );
    return { ...entry, id };
  }

  cleanup() {
    this._stmts.cleanup.run(Date.now() - this.ttlMs);
  }

  getMany(ids, sessionId) {
    this.cleanup();
    if (!Array.isArray(ids)) return [];
    if (new Set(ids).size !== ids.length) return [];
    const results = [];
    for (const id of ids) {
      const row = this._stmts.get.get(id);
      if (!row || row.session_token !== sessionId) return [];
      results.push({
        id: row.id,
        sessionId: row.session_token,
        path: row.path,
        name: row.name,
        size: row.size,
        sizeLabel: row.size_label,
        mime: row.mime,
        kind: row.kind,
      });
    }
    return results;
  }

  consumeMany(ids, sessionId) {
    const entries = this.getMany(ids, sessionId);
    if (entries.length !== ids.length) return null;
    for (const id of ids) {
      this._stmts.consume.run(id);
    }
    return entries;
  }

  restoreMany(entries) {
    for (const entry of entries || []) {
      if (entry?.id) this._stmts.restore.run(entry.id);
    }
  }
}

export { openDb, DB_PATH, SESSION_MAX_AGE_MS, UPLOAD_TTL_MS };
