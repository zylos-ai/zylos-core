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
    encoding: 'utf8',
    timeout: 10000
  });
}

/** Run CLI and return { stdout, stderr, status } without throwing */
function cliRaw(args, env = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// Boundary: actual CLI plus private SQLite. Run for command/output/timing changes;
// unrelated UI changes may skip. Every child has private env paths logged before
// launch and a 10-second bound; finally removes fixtures, with no live services.
function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-cli-'));
  const dbPath = path.join(tmpDir, 'instance', 'scheduler', 'scheduler.db');
  const env = { ZYLOS_DIR: path.join(tmpDir, 'instance'), TZ: 'UTC' };
  for (const [key, name] of Object.entries({ HOME: 'home', PM2_HOME: 'pm2', CODEX_HOME: 'codex', TMPDIR: 'tmp', TMUX_TMPDIR: 'tmux' })) {
    env[key] = path.join(tmpDir, name); fs.mkdirSync(env[key]);
  }
  fs.mkdirSync(env.ZYLOS_DIR);
  console.log('CLI legacy isolation:', JSON.stringify({ ...env, dbPath: path.join(env.ZYLOS_DIR, 'scheduler', 'scheduler.db'), pm2: 'not launched', tmux: 'not launched' }));
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

  it('--name matches the exact name only', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'digest', '--cron', '0 8 * * *', '--name', 'lark-group-digest'], env);
      cli(['add', 'morning digest', '--cron', '0 8 * * *', '--name', 'lark-group-digest-morning'], env);
      cli(['add', 'other', '--cron', '0 8 * * *', '--name', 'Lark-Group-Digest'], env);

      const rows = JSON.parse(cli(['list', '--json', '--name', 'lark-group-digest'], env));
      assert.deepEqual(rows.map(r => r.name), ['lark-group-digest']);

      const human = cli(['list', '--name', 'lark-group-digest'], env);
      assert.ok(human.includes('lark-group-digest'));
      assert.ok(!human.includes('lark-group-digest-morning'));
      assert.ok(!human.includes('Lark-Group-Digest'));
    });
  });

  it('--name treats "*" as a wildcard', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'morning', '--cron', '0 8 * * *', '--name', 'lark-group-digest-morning-1'], env);
      cli(['add', 'morning', '--cron', '0 9 * * *', '--name', 'lark-group-digest-morning-2'], env);
      cli(['add', 'evening', '--cron', '0 20 * * *', '--name', 'lark-group-digest-evening-1'], env);

      const rows = JSON.parse(cli(['list', '--json', '--name', 'lark-group-digest-morning-*'], env));
      assert.deepEqual(rows.map(r => r.name).sort(), [
        'lark-group-digest-morning-1',
        'lark-group-digest-morning-2'
      ]);

      const all = JSON.parse(cli(['list', '--json', '--name', '*-1'], env));
      assert.deepEqual(all.map(r => r.name).sort(), [
        'lark-group-digest-evening-1',
        'lark-group-digest-morning-1'
      ]);
    });
  });

  it('--name matches "?", "[", "%" and "_" literally', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'a', '--in', '30 minutes', '--name', 'job?'], env);
      cli(['add', 'b', '--in', '30 minutes', '--name', 'jobX'], env);
      cli(['add', 'c', '--in', '30 minutes', '--name', '[a]job'], env);
      cli(['add', 'd', '--in', '30 minutes', '--name', 'ajob'], env);
      cli(['add', 'e', '--in', '30 minutes', '--name', '100%_done'], env);
      cli(['add', 'f', '--in', '30 minutes', '--name', '100xxdone'], env);

      const names = (pattern) =>
        JSON.parse(cli(['list', '--json', '--name', pattern], env)).map(r => r.name);
      assert.deepEqual(names('job?'), ['job?']);
      assert.deepEqual(names('[a]job'), ['[a]job']);
      assert.deepEqual(names('100%_done'), ['100%_done']);
    });
  });

  it('--name combines with --reply-channel', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'a', '--in', '30 minutes', '--name', 'digest-1',
        '--reply-channel', 'lark', '--reply-endpoint', 'chat-1'], env);
      cli(['add', 'b', '--in', '30 minutes', '--name', 'digest-2',
        '--reply-channel', 'telegram', '--reply-endpoint', '42'], env);

      const rows = JSON.parse(cli(['list', '--json', '--name', 'digest-*', '--reply-channel', 'lark'], env));
      assert.deepEqual(rows.map(r => r.name), ['digest-1']);
    });
  });

  it('--name with no matches outputs [] under --json', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'a', '--in', '30 minutes', '--name', 'digest-1'], env);
      assert.deepEqual(JSON.parse(cli(['list', '--json', '--name', 'missing'], env)), []);
    });
  });

  it('--name with an empty pattern fails instead of listing every task', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'a', '--in', '30 minutes', '--name', 'digest-1'], env);
      for (const args of [['list', '--json', '--name', ''], ['list', '--json', '--name']]) {
        const { stdout, stderr, status } = cliRaw(args, env);
        assert.equal(status, 1);
        assert.equal(stdout, '');
        assert.ok(stderr.includes('--name requires a non-empty pattern'));
      }
    });
  });
});

describe('cli info', () => {
  function onlyTaskId(dbPath) {
    const db = new Database(dbPath);
    try {
      return db.prepare('SELECT id FROM tasks LIMIT 1').get().id;
    } finally {
      db.close();
    }
  }

  it('--json outputs the full task row as an object', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'json info task', '--cron', '0 8 * * *', '--name', 'digest',
        '--reply-channel', 'lark', '--reply-endpoint', 'chat-1'], env);
      const id = onlyTaskId(dbPath);

      const task = JSON.parse(cli(['info', id, '--json'], env));
      assert.equal(task.id, id);
      assert.equal(task.name, 'digest');
      assert.equal(task.prompt, 'json info task');
      assert.equal(task.type, 'recurring');
      assert.equal(task.cron_expression, '0 8 * * *');
      assert.equal(task.status, 'pending');
      assert.equal(task.reply_channel, 'lark');
      assert.equal(task.reply_endpoint, 'chat-1');
      assert.equal(typeof task.next_run_at, 'number');
      assert.ok('last_error' in task);
    });
  });

  it('accepts an ID prefix and the get alias', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'prefix task', '--in', '30 minutes'], env);
      const id = onlyTaskId(dbPath);
      assert.equal(JSON.parse(cli(['info', id.substring(0, 10), '--json'], env)).id, id);
      assert.equal(JSON.parse(cli(['get', id, '--json'], env)).id, id);
    });
  });

  it('shows completed one-time tasks that list hides', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'finished task', '--in', '30 minutes'], env);
      const id = onlyTaskId(dbPath);
      cli(['done', id], env);

      assert.deepEqual(JSON.parse(cli(['list', '--json'], env)), []);
      assert.equal(JSON.parse(cli(['info', id, '--json'], env)).status, 'completed');
      assert.ok(cli(['info', id], env).includes('Next run:       done'));
    });
  });

  it('prints a readable summary with the full id and prompt', () => {
    withTmpDir(({ dbPath, env }) => {
      const prompt = 'line one of a prompt that is longer than the eighty characters list shows\nline two';
      cli(['add', prompt, '--every', '2 hours', '--name', 'two-line',
        '--reply-channel', 'telegram', '--reply-endpoint', '42', '--block-queue-until-idle'], env);
      const id = onlyTaskId(dbPath);

      const output = cli(['info', id], env);
      assert.ok(output.includes(`Task ${id} (TZ: UTC)`));
      assert.ok(output.includes('Name:           two-line'));
      assert.ok(output.includes('Type:           interval'));
      assert.ok(output.includes('Schedule:       every 7200s'));
      assert.ok(output.includes('Block queue:    until idle'));
      assert.ok(output.includes('Reply:          telegram 42'));
      assert.ok(output.includes('Last run:       never'));
      assert.ok(output.includes('    line one of a prompt that is longer than the eighty characters list shows\n    line two'));
      assert.ok(!output.includes('Last error'));
    });
  });

  it('shows the cron schedule and the last error of a failed task', () => {
    withTmpDir(({ dbPath, env }) => {
      cli(['add', 'morning report', '--cron', '0 8 * * *'], env);
      const id = onlyTaskId(dbPath);
      const db = new Database(dbPath);
      try {
        db.prepare(`UPDATE tasks SET status = 'failed', last_error = 'Missed execution window', failed_at = 1767258000`).run();
      } finally {
        db.close();
      }

      const output = cli(['info', id], env);
      assert.ok(output.includes('Schedule:       Every day at 8:00 AM (cron 0 8 * * *)'));
      assert.ok(output.includes('Status:         failed'));
      assert.ok(output.includes('Last error:     Missed execution window (Jan 1, 2026, 09:00)'));
    });
  });

  it('exits 1 for a missing task, an ambiguous prefix and a missing id', () => {
    withTmpDir(({ env }) => {
      cli(['add', 'first', '--in', '30 minutes'], env);
      cli(['add', 'second', '--in', '30 minutes'], env);

      const missing = cliRaw(['info', 'task-does-not-exist', '--json'], env);
      assert.equal(missing.status, 1);
      assert.equal(missing.stdout, '');
      assert.ok(missing.stderr.includes('Task not found: task-does-not-exist'));

      const ambiguous = cliRaw(['info', 'task-', '--json'], env);
      assert.equal(ambiguous.status, 1);
      assert.equal(ambiguous.stdout, '');
      assert.ok(ambiguous.stderr.includes('Ambiguous task ID prefix'));

      const noId = cliRaw(['info'], env);
      assert.equal(noId.status, 1);
      assert.ok(noId.stderr.includes('Task ID is required'));
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
