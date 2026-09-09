import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dispatchTaskRun } from '../task-dispatch.js';
import { completeTaskRun } from '../task-runs.js';

async function withDb(fn) {
  const originalZylosDir = process.env.ZYLOS_DIR;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-dispatch-'));
  try {
    process.env.ZYLOS_DIR = tmpDir;
    const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { getDb, now } = await import(new URL(`../database.js?${cacheBuster}`, import.meta.url));
    const db = getDb();
    try {
      await fn(db, now());
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = originalZylosDir;
  }
}

function insertPendingTask(db, currentTime, overrides = {}) {
  const task = {
    id: 'task-dispatch',
    name: 'dispatch me',
    prompt: 'perform the scheduled work',
    type: 'recurring',
    next_run_at: currentTime,
    priority: 2,
    require_idle: 1,
    reply_channel: 'hxa-connect',
    reply_endpoint: 'org:hxa|mylos',
    ...overrides
  };
  db.prepare(`
    INSERT INTO tasks (
      id, name, prompt, type, next_run_at, priority, status, require_idle,
      reply_channel, reply_endpoint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(
    task.id, task.name, task.prompt, task.type, task.next_run_at, task.priority,
    task.require_idle, task.reply_channel, task.reply_endpoint, currentTime, currentTime
  );
  return task;
}

describe('dispatchTaskRun', () => {
  it('does not dispatch a task that was postponed after the daemon selected it', async () => {
    await withDb((db, currentTime) => {
      const staleTask = insertPendingTask(db, currentTime);
      db.prepare('UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(currentTime + 3600, currentTime + 1, staleTask.id);
      let sent = false;

      const result = dispatchTaskRun(db, staleTask, () => {
        sent = true;
        return true;
      }, { dispatchedAt: currentTime + 1 });

      assert.equal(result.success, false);
      assert.equal(sent, false);
      assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(staleTask.id).status, 'pending');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_history').get().count, 0);
    });
  });

  it('does not dispatch a task whose current missed-run window has expired', async () => {
    await withDb((db, currentTime) => {
      const staleTask = insertPendingTask(db, currentTime - 60);
      db.prepare('UPDATE tasks SET miss_threshold = 30, updated_at = ? WHERE id = ?')
        .run(currentTime, staleTask.id);
      let sent = false;

      const result = dispatchTaskRun(db, staleTask, () => {
        sent = true;
        return true;
      }, { dispatchedAt: currentTime });

      assert.equal(result.success, false);
      assert.equal(sent, false);
      assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(staleTask.id).status, 'pending');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_history').get().count, 0);
    });
  });

  it('treats a zero missed-run window as immediate expiry', async () => {
    await withDb((db, currentTime) => {
      const task = insertPendingTask(db, currentTime - 1);
      db.prepare('UPDATE tasks SET miss_threshold = 0 WHERE id = ?').run(task.id);
      let sent = false;

      const result = dispatchTaskRun(db, task, () => {
        sent = true;
        return true;
      }, { dispatchedAt: currentTime });

      assert.equal(result.success, false);
      assert.equal(sent, false);
    });
  });

  it('dispatches the current task content after a pending task was edited', async () => {
    await withDb((db, currentTime) => {
      const staleTask = insertPendingTask(db, currentTime);
      db.prepare(`
        UPDATE tasks
        SET prompt = 'current prompt', priority = 1, require_idle = 0,
            reply_channel = 'feishu', reply_endpoint = 'current-endpoint', updated_at = ?
        WHERE id = ?
      `).run(currentTime + 1, staleTask.id);
      let sent;

      const result = dispatchTaskRun(db, staleTask, (prompt, options) => {
        sent = { prompt, options };
        return true;
      }, { dispatchedAt: currentTime + 1 });

      assert.equal(result.success, true);
      assert.match(sent.prompt, /current prompt/);
      assert.doesNotMatch(sent.prompt, /perform the scheduled work/);
      assert.deepEqual(sent.options, {
        priority: 1,
        requireIdle: false,
        replyChannel: 'feishu',
        replyEndpoint: 'current-endpoint'
      });
    });
  });

  it('sends a completion instruction bound to the atomically created run ID', async () => {
    await withDb((db, currentTime) => {
      const task = insertPendingTask(db, currentTime);
      let sent;

      const result = dispatchTaskRun(db, task, (prompt, options) => {
        sent = { prompt, options };
        return true;
      }, { dispatchedAt: currentTime });

      assert.equal(result.success, true);
      assert.ok(Number.isSafeInteger(result.runId));
      assert.match(sent.prompt, new RegExp(`done ${task.id} --run-id ${result.runId}$`));
      assert.deepEqual(sent.options, {
        priority: 2,
        requireIdle: true,
        replyChannel: 'hxa-connect',
        replyEndpoint: 'org:hxa|mylos'
      });
      assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'running');
      assert.deepEqual(
        db.prepare('SELECT id, task_id, status FROM task_history').get(),
        { id: result.runId, task_id: task.id, status: 'started' }
      );
    });
  });

  it('keeps a failed dispatch visible until an exact later run succeeds', async () => {
    await withDb((db, currentTime) => {
      const task = insertPendingTask(db, currentTime);

      const failed = dispatchTaskRun(db, task, () => false, { dispatchedAt: currentTime });

      assert.equal(failed.success, false);
      assert.deepEqual(
        db.prepare('SELECT status, failed_at, last_error FROM tasks WHERE id = ?').get(task.id),
        { status: 'pending', failed_at: currentTime, last_error: 'Failed to dispatch message' }
      );
      assert.deepEqual(
        db.prepare('SELECT status, completed_at, error FROM task_history WHERE id = ?').get(failed.runId),
        { status: 'failed', completed_at: currentTime, error: 'Failed to dispatch message' }
      );

      const recovered = dispatchTaskRun(db, task, () => true, { dispatchedAt: currentTime + 1 });
      assert.equal(completeTaskRun(db, {
        taskId: task.id,
        runId: recovered.runId,
        completedAt: currentTime + 2
      }), true);
      assert.deepEqual(
        db.prepare('SELECT status, failed_at, last_error FROM tasks WHERE id = ?').get(task.id),
        { status: 'completed', failed_at: null, last_error: null }
      );
    });
  });

  it('records a thrown sender failure against the exact run', async () => {
    await withDb((db, currentTime) => {
      const task = insertPendingTask(db, currentTime);

      const result = dispatchTaskRun(db, task, () => {
        throw new Error('sender exploded');
      }, { dispatchedAt: currentTime });

      assert.equal(result.success, false);
      assert.equal(result.reason, 'send-failed');
      assert.deepEqual(
        db.prepare('SELECT status, failed_at, last_error FROM tasks WHERE id = ?').get(task.id),
        { status: 'pending', failed_at: currentTime, last_error: 'Failed to dispatch message' }
      );
      assert.deepEqual(
        db.prepare('SELECT status, completed_at, error FROM task_history WHERE id = ?').get(result.runId),
        { status: 'failed', completed_at: currentTime, error: 'Failed to dispatch message' }
      );
    });
  });
});
