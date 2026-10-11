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

  it('migrates legacy run outcomes once without rewriting history', async () => {
    const originalZylosDir = process.env.ZYLOS_DIR;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-migration-'));
    const dbPath = path.join(tmpDir, 'scheduler', 'scheduler.db');
    try {
      process.env.ZYLOS_DIR = tmpDir;
      const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const setup = await import(new URL(`../database.js?setup-${cacheBuster}`, import.meta.url));
      setup.getDb().close();

      const seed = new Database(dbPath);
      const currentTime = Math.floor(Date.now() / 1000);
      const addTask = (id, status, lastError, updatedAt = currentTime, failedAt = null) => {
        seed.prepare(`
          INSERT INTO tasks (
            id, name, prompt, type, next_run_at, status,
            created_at, updated_at, last_error, failed_at
          ) VALUES (?, ?, 'test', 'recurring', ?, ?, ?, ?, ?, ?)
        `).run(id, id, currentTime + 3600, status, currentTime, updatedAt, lastError, failedAt);
      };
      addTask('task-recovered', 'pending', 'stale error');
      addTask('task-timeout', 'pending', 'Task timed out');
      addTask('task-failed-no-history', 'failed', 'dispatch failed', currentTime - 20);
      addTask('task-failed-after-success', 'failed', 'Invalid cron expression', currentTime - 15);
      addTask('task-failed-without-error', 'failed', null, currentTime - 10);
      addTask('task-unknown-error', 'pending', 'legacy uncertain', currentTime - 10);
      addTask('task-clock-rollback', 'pending', null);
      addTask('task-newer-task-failure', 'failed', 'Missed execution window', currentTime - 200);
      addTask('task-retrying-after-failure', 'running', 'newer unproven error', currentTime);
      addTask('task-retrying-after-success', 'running', 'stale recovered error', currentTime);
      addTask('task-pending-started-after-success', 'pending', 'unproven current error', currentTime - 10);
      addTask(
        'task-existing-failure-timestamp',
        'pending',
        'legacy uncertain',
        currentTime,
        currentTime - 500
      );
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status)
        VALUES ('task-recovered', ?, ?, 'success')
      `).run(currentTime - 200, currentTime - 190);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status, error)
        VALUES ('task-timeout', ?, ?, 'timeout', 'Task timed out')
      `).run(currentTime - 100, currentTime - 90);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status)
        VALUES ('task-failed-after-success', ?, ?, 'success')
      `).run(currentTime - 30, currentTime - 20);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status)
        VALUES ('task-clock-rollback', ?, ?, 'success')
      `).run(currentTime - 100, currentTime - 90);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status, error)
        VALUES ('task-clock-rollback', ?, ?, 'failed', 'failed after clock rollback')
      `).run(currentTime - 200, currentTime - 190);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status, error)
        VALUES ('task-newer-task-failure', ?, ?, 'failed', 'Failed to dispatch message')
      `).run(currentTime - 110, currentTime - 100);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status, error)
        VALUES ('task-retrying-after-failure', ?, ?, 'timeout', 'Task timed out')
      `).run(currentTime - 110, currentTime - 100);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES ('task-retrying-after-failure', ?, 'started')
      `).run(currentTime);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status, error)
        VALUES ('task-retrying-after-success', ?, ?, 'failed', 'old failure')
      `).run(currentTime - 310, currentTime - 300);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status)
        VALUES ('task-retrying-after-success', ?, ?, 'success')
      `).run(currentTime - 210, currentTime - 200);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES ('task-retrying-after-success', ?, 'started')
      `).run(currentTime);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, completed_at, status)
        VALUES ('task-pending-started-after-success', ?, ?, 'success')
      `).run(currentTime - 210, currentTime - 200);
      seed.prepare(`
        INSERT INTO task_history (task_id, executed_at, status)
        VALUES ('task-pending-started-after-success', ?, 'started')
      `).run(currentTime - 5);
      seed.prepare("DELETE FROM system_state WHERE key = 'scheduler_run_outcome_v1'").run();
      const historyBefore = seed.prepare(`
        SELECT id, task_id, executed_at, completed_at, status, duration_ms, error
        FROM task_history ORDER BY id
      `).all();
      seed.close();

      const migrated = await import(new URL(`../database.js?migrate-${cacheBuster}`, import.meta.url));
      const db = migrated.getDb();
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-recovered'),
        { failed_at: null, last_error: null }
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-timeout'),
        { failed_at: currentTime - 90, last_error: 'Task timed out' }
      );
      assert.equal(
        db.prepare('SELECT failed_at FROM tasks WHERE id = ?').get('task-failed-no-history').failed_at,
        currentTime - 20
      );
      assert.equal(
        db.prepare('SELECT failed_at FROM tasks WHERE id = ?').get('task-unknown-error').failed_at,
        currentTime - 10
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-failed-after-success'),
        { failed_at: currentTime - 15, last_error: 'Invalid cron expression' }
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-failed-without-error'),
        { failed_at: currentTime - 10, last_error: 'Task failed' }
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-clock-rollback'),
        { failed_at: currentTime - 190, last_error: 'failed after clock rollback' }
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-newer-task-failure'),
        { failed_at: currentTime - 200, last_error: 'Missed execution window' }
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-retrying-after-failure'),
        { failed_at: currentTime, last_error: 'newer unproven error' }
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-retrying-after-success'),
        { failed_at: currentTime, last_error: 'stale recovered error' }
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-pending-started-after-success'),
        { failed_at: currentTime - 10, last_error: 'unproven current error' }
      );
      assert.deepEqual(
        db.prepare('SELECT failed_at, last_error FROM tasks WHERE id = ?').get('task-existing-failure-timestamp'),
        { failed_at: currentTime - 500, last_error: 'legacy uncertain' }
      );
      assert.deepEqual(
        db.prepare(`
          SELECT id, task_id, executed_at, completed_at, status, duration_ms, error
          FROM task_history ORDER BY id
        `).all(),
        historyBefore
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM system_state WHERE key = 'scheduler_run_outcome_v1'").get().count,
        1
      );
      const snapshot = db.prepare(`
        SELECT id, failed_at, last_error FROM tasks ORDER BY id
      `).all();
      db.close();

      const second = await import(new URL(`../database.js?second-${cacheBuster}`, import.meta.url));
      const reopened = second.getDb();
      assert.deepEqual(
        reopened.prepare('SELECT id, failed_at, last_error FROM tasks ORDER BY id').all(),
        snapshot
      );
      reopened.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
      else process.env.ZYLOS_DIR = originalZylosDir;
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
