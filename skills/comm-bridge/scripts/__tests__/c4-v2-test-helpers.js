import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
export function fixture(t, dependencies = {}, file = false) {
  const dir = file ? mkdtempSync(path.join(tmpdir(), 'c4-v2-')) : null;
  const filename = dir ? path.join(dir, 'c4.db') : ':memory:';
  const db = new Database(filename);
  guardDatabase(db, owner);
  if (file) db.pragma('journal_mode=WAL');
  const deps = { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateModel: () => true, ...dependencies };
  const store = createStore(db, deps);
  t.after(() => { if (db.open) db.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  return { db, store, filename, dependencies: deps };
}
