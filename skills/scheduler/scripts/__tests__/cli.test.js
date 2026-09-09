import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

function cli(args, env = {}) {
  return execFileSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
    encoding: 'utf8'
  });
}

/** Run CLI and return { stdout, stderr, status } without throwing */
function cliRaw(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cli-'));
  const dbPath = path.join(tmpDir, 'scheduler', 'scheduler.db');
  const env = { ZYLOS_DIR: tmpDir, TZ: 'UTC' };
  try {
    return fn({ tmpDir, dbPath, env });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('cli add', () => {
  it('creates a cron task with correct timezone column', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'test cron task', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT * FROM tasks LIMIT 1').get();
        assert.equal(task.type, 'recurring');
        assert.equal(task.timezone, 'UTC');
        assert.equal(task.cron_expression, '0 9 * * *');
        assert.equal(task.status, 'pending');
        assert.equal(task.priority, 3);
      } finally {
        db.close();
      }
    });
  });

  it('creates a one-time task with --in', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'remind me', '--in', '30 minutes'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT * FROM tasks LIMIT 1').get();
        assert.equal(task.type, 'one-time');
        assert.ok(task.next_run_at > Math.floor(Date.now() / 1000));
      } finally {
        db.close();
      }
    });
  });

  it('creates a one-time task with --at', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'send report', '--at', 'tomorrow 9am'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT * FROM tasks LIMIT 1').get();
        assert.equal(task.type, 'one-time');
      } finally {
        db.close();
      }
    });
  });

  it('creates an interval task with --every', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'check updates', '--every', '2 hours'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT * FROM tasks LIMIT 1').get();
        assert.equal(task.type, 'interval');
        assert.ok(task.interval_seconds >= 7190 && task.interval_seconds <= 7210);
      } finally {
        db.close();
      }
    });
  });

  it('sets priority correctly', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'urgent task', '--cron', '0 9 * * *', '--priority', '1'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT priority FROM tasks LIMIT 1').get();
        assert.equal(task.priority, 1);
      } finally {
        db.close();
      }
    });
  });

  it('sets require_idle and reply fields via --block-queue-until-idle', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'idle task', '--cron', '0 2 * * *', '--block-queue-until-idle',
           '--reply-channel', 'telegram', '--reply-endpoint', '12345'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT * FROM tasks LIMIT 1').get();
        assert.equal(task.require_idle, 1);
        assert.equal(task.reply_channel, 'telegram');
        assert.equal(task.reply_endpoint, '12345');
      } finally {
        db.close();
      }
    });
  });

  it('still accepts legacy --require-idle', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'legacy idle task', '--cron', '0 2 * * *', '--require-idle'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT require_idle FROM tasks LIMIT 1').get();
        assert.equal(task.require_idle, 1);
      } finally {
        db.close();
      }
    });
  });

  it('sets custom miss_threshold', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'backup', '--cron', '0 2 * * *', '--miss-threshold', '86400'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT miss_threshold FROM tasks LIMIT 1').get();
        assert.equal(task.miss_threshold, 86400);
      } finally {
        db.close();
      }
    });
  });

  it('sets custom name', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'the actual prompt', '--cron', '0 9 * * *', '--name', 'my-task'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT name, prompt FROM tasks LIMIT 1').get();
        assert.equal(task.name, 'my-task');
        assert.equal(task.prompt, 'the actual prompt');
      } finally {
        db.close();
      }
    });
  });

  it('reports error without timing option', () => {
    withTmpDir(({ env }) => {
      const { stderr } = cliRaw(['add', 'no timing'], env);
      assert.ok(stderr.includes('Error') || stderr.includes('Must specify'));
    });
  });

  it('reports error without prompt', () => {
    withTmpDir(({ env }) => {
      const { stderr } = cliRaw(['add', '--cron', '0 9 * * *'], env);
      assert.ok(stderr.includes('Error') || stderr.includes('Prompt'));
    });
  });
});

describe('cli list', () => {
  it('shows empty list message', () => {
    withTmpDir(({ env }) => {
      const output = cli(['list'], env);
      assert.ok(output.includes('No tasks'));
    });
  });

  it('shows tasks with TZ header', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'task one', '--cron', '0 9 * * *'], env);
      const output = cli(['list'], env);
      assert.ok(output.includes('TZ: UTC'));
      assert.ok(output.includes('task one'));
    });
  });

  it('--json outputs full task rows as a JSON array', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'json task', '--in', '30 minutes', '--reply-channel', 'multica', '--reply-endpoint', 'task-abc-123'], env);
      const db = new Database(dbPath);
      let expectedId;
      try {
        expectedId = db.prepare('SELECT id FROM tasks LIMIT 1').get().id;
      } finally {
        db.close();
      }
      const output = cli(['list', '--json'], env);
      const rows = JSON.parse(output);
      assert.equal(rows.length, 1);
      const row = rows[0];
      // Full untruncated id plus every field the machine contract requires
      assert.match(expectedId, /^task-/);
      assert.equal(row.id, expectedId);
      assert.equal(row.type, 'one-time');
      assert.equal(row.status, 'pending');
      assert.equal(row.reply_channel, 'multica');
      assert.equal(row.reply_endpoint, 'task-abc-123');
      assert.equal(typeof row.next_run_at, 'number');
      assert.ok('last_error' in row);
    });
  });

  it('--json outputs [] when no tasks match', () => {
    withTmpDir(({ env }) => {
      const rows = JSON.parse(cli(['list', '--json'], env));
      assert.deepEqual(rows, []);
    });
  });

  it('--reply-channel filters rows in both output modes', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'multica task', '--in', '30 minutes', '--reply-channel', 'multica', '--reply-endpoint', 'task-1'], env);
      cli(['add', 'telegram task', '--in', '30 minutes', '--reply-channel', 'telegram', '--reply-endpoint', '123'], env);
      cli(['add', 'no channel task', '--in', '30 minutes'], env);

      const rows = JSON.parse(cli(['list', '--json', '--reply-channel', 'multica'], env));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reply_channel, 'multica');

      const human = cli(['list', '--reply-channel', 'multica'], env);
      assert.ok(human.includes('multica task'));
      assert.ok(!human.includes('telegram task'));
      assert.ok(!human.includes('no channel task'));
    });
  });

  it('--json still includes failed one-time tasks', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'will fail', '--in', '30 minutes', '--reply-channel', 'multica', '--reply-endpoint', 'task-9'], env);
      const db = new Database(dbPath);
      try {
        db.prepare(`UPDATE tasks SET status = 'failed', last_error = 'Missed execution window'`).run();
      } finally {
        db.close();
      }
      const rows = JSON.parse(cli(['list', '--json', '--reply-channel', 'multica'], env));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'failed');
      assert.equal(rows[0].last_error, 'Missed execution window');
    });
  });
});

describe('cli done', () => {
  it('rejects completion without a run ID and leaves the active run unchanged', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'identity required', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        const currentTime = Math.floor(Date.now() / 1000);
        db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?")
          .run(currentTime, task.id);
        const run = db.prepare(`
          INSERT INTO task_history (task_id, executed_at, status)
          VALUES (?, ?, 'started')
        `).run(task.id, currentTime);
        const before = {
          task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id),
          history: db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY id').all(task.id)
        };

        const result = cliRaw(['done', task.id], env);

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /run ID/i);
        assert.deepEqual(
          {
            task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id),
            history: db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY id').all(task.id)
          },
          before
        );
        assert.equal(before.history[0].id, run.lastInsertRowid);
      } finally {
        db.close();
      }
    });
  });

  it('completes the exact active run and clears its failure outcome', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'complete me', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        const currentTime = Math.floor(Date.now() / 1000);
        db.prepare(`
          UPDATE tasks
          SET status = 'running', failed_at = ?, last_error = 'prior timeout', updated_at = ?
          WHERE id = ?
        `).run(currentTime - 60, currentTime, task.id);
        const run = db.prepare(`
          INSERT INTO task_history (task_id, executed_at, status)
          VALUES (?, ?, 'started')
        `).run(task.id, currentTime);

        cli(['done', task.id, '--run-id', String(run.lastInsertRowid)], env);

        const updated = db.prepare('SELECT status, failed_at, last_error FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.status, 'completed');
        assert.equal(updated.failed_at, null);
        assert.equal(updated.last_error, null);
        assert.equal(db.prepare('SELECT status FROM task_history WHERE id = ?').get(run.lastInsertRowid).status, 'success');

        const snapshot = {
          task: db.prepare('SELECT status, failed_at, last_error, last_run_at FROM tasks WHERE id = ?').get(task.id),
          history: db.prepare('SELECT status, completed_at, duration_ms FROM task_history WHERE id = ?').get(run.lastInsertRowid)
        };
        const duplicate = cliRaw(['done', task.id, '--run-id', String(run.lastInsertRowid)], env);
        assert.notEqual(duplicate.status, 0);
        assert.deepEqual(
          {
            task: db.prepare('SELECT status, failed_at, last_error, last_run_at FROM tasks WHERE id = ?').get(task.id),
            history: db.prepare('SELECT status, completed_at, duration_ms FROM task_history WHERE id = ?').get(run.lastInsertRowid)
          },
          snapshot
        );
      } finally {
        db.close();
      }
    });
  });

  it('rejects an older timed-out run while a newer run is active', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'generation safe', '--every', '1 hour'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        const currentTime = Math.floor(Date.now() / 1000);
        const oldRun = db.prepare(`
          INSERT INTO task_history (task_id, executed_at, completed_at, status, error)
          VALUES (?, ?, ?, 'timeout', 'Task timed out')
        `).run(task.id, currentTime - 7200, currentTime - 3600);
        const activeRun = db.prepare(`
          INSERT INTO task_history (task_id, executed_at, status)
          VALUES (?, ?, 'started')
        `).run(task.id, currentTime);
        db.prepare(`
          UPDATE tasks
          SET status = 'running', failed_at = ?, last_error = 'Task timed out', updated_at = ?
          WHERE id = ?
        `).run(currentTime - 3600, currentTime, task.id);

        const late = cliRaw(['done', task.id, '--run-id', String(oldRun.lastInsertRowid)], env);

        assert.notEqual(late.status, 0);
        assert.deepEqual(
          db.prepare('SELECT status, failed_at, last_error FROM tasks WHERE id = ?').get(task.id),
          { status: 'running', failed_at: currentTime - 3600, last_error: 'Task timed out' }
        );
        assert.equal(db.prepare('SELECT status FROM task_history WHERE id = ?').get(oldRun.lastInsertRowid).status, 'timeout');
        assert.equal(db.prepare('SELECT status FROM task_history WHERE id = ?').get(activeRun.lastInsertRowid).status, 'started');

        cli(['done', task.id, '--run-id', String(activeRun.lastInsertRowid)], env);
        assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'completed');
      } finally {
        db.close();
      }
    });
  });

  it('reports error for non-existent task', () => {
    withTmpDir(({ env }) => {
      const { stderr } = cliRaw(['done', 'nonexistent-id'], env);
      assert.ok(stderr.includes('not found'));
    });
  });
});

describe('cli pause and resume', () => {
  it('pauses a pending task', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'pause me', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['pause', task.id], env);
        const paused = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id);
        assert.equal(paused.status, 'paused');

        cli(['resume', task.id], env);
        const resumed = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id);
        assert.equal(resumed.status, 'pending');
      } finally {
        db.close();
      }
    });
  });
});

describe('cli remove', () => {
  it('removes a task', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'remove me', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['remove', task.id], env);
        const remaining = db.prepare('SELECT COUNT(*) as count FROM tasks').get();
        assert.equal(remaining.count, 0);
      } finally {
        db.close();
      }
    });
  });

  it('reports error for non-existent task', () => {
    withTmpDir(({ env }) => {
      const { stderr } = cliRaw(['remove', 'nonexistent-id'], env);
      assert.ok(stderr.includes('not found'));
    });
  });
});

describe('cli update', () => {
  it('updates task name', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'original', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['update', task.id, '--name', 'new-name'], env);
        const updated = db.prepare('SELECT name FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.name, 'new-name');
      } finally {
        db.close();
      }
    });
  });

  it('updates priority', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'prio task', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['update', task.id, '--priority', '1'], env);
        const updated = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.priority, 1);
      } finally {
        db.close();
      }
    });
  });

  it('clears reply configuration', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'reply task', '--cron', '0 9 * * *',
           '--reply-channel', 'telegram', '--reply-endpoint', '123'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['update', task.id, '--clear-reply'], env);
        const updated = db.prepare('SELECT reply_channel, reply_endpoint FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.reply_channel, null);
        assert.equal(updated.reply_endpoint, null);
      } finally {
        db.close();
      }
    });
  });

  it('switches schedule type from cron to interval', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'switch type', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['update', task.id, '--every', '2 hours'], env);
        const updated = db.prepare('SELECT type, interval_seconds, cron_expression FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.type, 'interval');
        assert.ok(updated.interval_seconds >= 7190 && updated.interval_seconds <= 7210);
        assert.equal(updated.cron_expression, null);
      } finally {
        db.close();
      }
    });
  });

  it('disables require_idle via --no-block-queue-until-idle', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'idle task', '--cron', '0 9 * * *', '--block-queue-until-idle'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['update', task.id, '--no-block-queue-until-idle'], env);
        const updated = db.prepare('SELECT require_idle FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.require_idle, 0);
      } finally {
        db.close();
      }
    });
  });

  it('still accepts legacy --no-require-idle', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'idle task', '--cron', '0 9 * * *', '--require-idle'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['update', task.id, '--no-require-idle'], env);
        const updated = db.prepare('SELECT require_idle FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.require_idle, 0);
      } finally {
        db.close();
      }
    });
  });

  it('reports error with no update options', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'no update', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        const { stderr } = cliRaw(['update', task.id], env);
        assert.ok(stderr.includes('No updates'));
      } finally {
        db.close();
      }
    });
  });
});

describe('cli history', () => {
  it('shows empty history', () => {
    withTmpDir(({ env }) => {
      const output = cli(['history'], env);
      assert.ok(output.includes('No execution history'));
    });
  });
});

describe('cli next', () => {
  it('shows upcoming tasks', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'upcoming task', '--cron', '0 9 * * *'], env);
      const output = cli(['next'], env);
      assert.ok(output.includes('Upcoming'));
    });
  });

  it('shows empty message when no pending tasks', () => {
    withTmpDir(({ env }) => {
      const output = cli(['next'], env);
      assert.ok(output.includes('No pending'));
    });
  });
});

describe('cli running', () => {
  it('shows safe to compact when no running tasks', () => {
    withTmpDir(({ env }) => {
      const output = cli(['running'], env);
      assert.ok(output.includes('No running') || output.includes('Safe to compact'));
    });
  });

  it('shows the exact completion command for each active run', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'running task', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      let task;
      let run;
      try {
        task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        const currentTime = Math.floor(Date.now() / 1000);
        db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?")
          .run(currentTime, task.id);
        run = db.prepare(`
          INSERT INTO task_history (task_id, executed_at, status)
          VALUES (?, ?, 'started')
        `).run(task.id, currentTime);
      } finally {
        db.close();
      }

      const output = cli(['running'], env);

      assert.match(output, new RegExp(`done ${task.id} --run-id ${run.lastInsertRowid}`));
    });
  });
});

describe('cli help', () => {
  it('shows help with --help flag', () => {
    withTmpDir(({ env }) => {
      const output = cli(['--help'], env);
      assert.ok(output.includes('Usage'));
      assert.ok(output.includes('Commands'));
    });
  });

  it('shows help with help command', () => {
    withTmpDir(({ env }) => {
      const output = cli(['help'], env);
      assert.ok(output.includes('Usage'));
    });
  });

  it('shows help and error for unknown command', () => {
    withTmpDir(({ env }) => {
      const { stderr, stdout } = cliRaw(['unknown-command'], env);
      const output = stderr + stdout;
      assert.ok(output.includes('Unknown command') || output.includes('Usage'));
    });
  });
});

describe('cli partial ID match', () => {
  it('supports partial task ID for done command', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'partial id test', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        const currentTime = Math.floor(Date.now() / 1000);
        db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?")
          .run(currentTime, task.id);
        const run = db.prepare(`
          INSERT INTO task_history (task_id, executed_at, status)
          VALUES (?, ?, 'started')
        `).run(task.id, currentTime);
        const prefix = task.id.substring(0, 10);
        cli(['done', prefix, '--run-id', String(run.lastInsertRowid)], env);
        const updated = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.status, 'completed');
      } finally {
        db.close();
      }
    });
  });
});
