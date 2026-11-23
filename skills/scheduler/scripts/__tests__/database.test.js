import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

});
