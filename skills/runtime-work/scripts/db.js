import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INIT_SQL_PATH = path.join(__dirname, '..', 'init-db.sql');

let db = null;
let activeDbPath = null;

function resolveDbPath() {
  if (process.env.RUNTIME_WORK_DB_PATH) {
    return process.env.RUNTIME_WORK_DB_PATH;
  }

  const zylosDir = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return path.join(zylosDir, 'runtime-work', 'runtime-work.db');
}

function ensureDbDir(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function initSchema(database) {
  const sql = fs.readFileSync(INIT_SQL_PATH, 'utf8');
  database.exec(sql);
}

export function getDbPath() {
  return resolveDbPath();
}

export function getDb() {
  const dbPath = resolveDbPath();

  if (db && activeDbPath === dbPath) {
    return db;
  }

  if (db && activeDbPath !== dbPath) {
    db.close();
    db = null;
    activeDbPath = null;
  }

  ensureDbDir(dbPath);
  db = new Database(dbPath);
  activeDbPath = dbPath;
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    activeDbPath = null;
  }
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function generateWorkId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `work-${ts}-${rand}`;
}
