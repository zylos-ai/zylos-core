import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { generateId, now } from '../database.js';

describe('generateId', () => {
  it('starts with task- prefix', () => {
    const id = generateId();
    assert.ok(id.startsWith('task-'), `expected task- prefix: ${id}`);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    assert.equal(ids.size, 100);
  });

  it('contains only alphanumeric and hyphens', () => {
    const id = generateId();
    assert.match(id, /^task-[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe('now', () => {
  it('returns current Unix timestamp in seconds', () => {
    const timestamp = now();
    const expected = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(timestamp - expected) <= 1, `expected ~${expected}, got ${timestamp}`);
  });

  it('returns an integer', () => {
    assert.equal(Number.isInteger(now()), true);
  });
});

describe('getDb', () => {
  it('creates data directory and initializes schema', async () => {
    const originalZylosDir = process.env.ZYLOS_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-db-'));
    const dbPath = path.join(tmpDir, 'scheduler', 'scheduler.db');
    try {
      process.env.ZYLOS_DIR = tmpDir;

      // Dynamic import to pick up new ZYLOS_DIR
      const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const { getDb } = await import(new URL(`../database.js?${cacheBuster}`, import.meta.url));
      const db = getDb();

      // Verify directory and file were created
      assert.ok(fs.existsSync(dbPath));

      // Verify schema: tasks table
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map(t => t.name);
      assert.ok(tables.includes('tasks'));
      assert.ok(tables.includes('task_history'));
      assert.ok(tables.includes('system_state'));

      // Verify tasks table has timezone column
      const cols = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
      assert.ok(cols.includes('timezone'));
      assert.ok(cols.includes('next_run_at'));
      assert.ok(cols.includes('priority'));
      assert.ok(cols.includes('reply_channel'));

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (originalZylosDir === undefined) {
        delete process.env.ZYLOS_DIR;
      } else {
        process.env.ZYLOS_DIR = originalZylosDir;
      }
    }
  });
});

describe('cleanupHistory', () => {
  it('removes entries older than retention period', async () => {
    const originalZylosDir = process.env.ZYLOS_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cleanup-'));
    try {
      process.env.ZYLOS_DIR = tmpDir;

      const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const mod = await import(new URL(`../database.js?${cacheBuster}`, import.meta.url));
      const db = mod.getDb();

      // Insert a task first (foreign key constraint)
      const taskId = 'task-cleanup-test';
      const currentTime = mod.now();
      db.prepare(`
        INSERT INTO tasks (id, name, prompt, type, next_run_at, created_at, updated_at)
        VALUES (?, 'cleanup test', 'test', 'one-time', ?, ?, ?)
      `).run(taskId, currentTime, currentTime, currentTime);

      // Insert old history entry (60 days ago)
      const oldTime = currentTime - (60 * 24 * 60 * 60);
      db.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES (?, ?, 'success')
      `).run(taskId, oldTime);

      // Insert recent history entry
      db.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES (?, ?, 'success')
      `).run(taskId, currentTime);

      const deleted = mod.cleanupHistory();
      assert.equal(deleted, 1);

      const remaining = db.prepare('SELECT COUNT(*) as count FROM task_history').get();
      assert.equal(remaining.count, 1);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (originalZylosDir === undefined) {
        delete process.env.ZYLOS_DIR;
      } else {
        process.env.ZYLOS_DIR = originalZylosDir;
      }
    }
  });

  it('returns 0 when nothing to clean', async () => {
    const originalZylosDir = process.env.ZYLOS_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cleanup-empty-'));
    try {
      process.env.ZYLOS_DIR = tmpDir;

      const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const mod = await import(new URL(`../database.js?${cacheBuster}`, import.meta.url));
      const db = mod.getDb();

      const deleted = mod.cleanupHistory();
      assert.equal(deleted, 0);

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (originalZylosDir === undefined) {
        delete process.env.ZYLOS_DIR;
      } else {
        process.env.ZYLOS_DIR = originalZylosDir;
      }
    }
  });
});
