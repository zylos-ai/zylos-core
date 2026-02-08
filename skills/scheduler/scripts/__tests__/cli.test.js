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

  it('sets require_idle and reply fields', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'idle task', '--cron', '0 2 * * *', '--require-idle',
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
});

describe('cli done', () => {
  it('completes a task and updates history', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'complete me', '--cron', '0 9 * * *'], env);
      const db = new Database(dbPath);
      try {
        const task = db.prepare('SELECT id FROM tasks LIMIT 1').get();
        cli(['done', task.id], env);
        const updated = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.status, 'completed');
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
        const prefix = task.id.substring(0, 10);
        cli(['done', prefix], env);
        const updated = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id);
        assert.equal(updated.status, 'completed');
      } finally {
        db.close();
      }
    });
  });
});
