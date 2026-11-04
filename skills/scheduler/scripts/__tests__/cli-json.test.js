import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

// These cases cover the real CLI/store boundary, including private-file failures.
// Run for scheduler CLI/schema/routing changes; unrelated UI changes may skip them.
// Children never call tmux/PM2; introducing those calls requires a private tmux socket.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-json-'));
  const home = path.join(root, 'home');
  const zylos = path.join(home, 'zylos');
  const tmp = path.join(root, 'tmp');
  const dbPath = path.join(zylos, 'scheduler/scheduler.db');
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, TZ: 'UTC', ZYLOS_SESSION_GROUP: 'origin' };
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const dir of [tmp, path.join(zylos, 'scheduler'), path.join(zylos, '.claude/skills/telegram')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(zylos, '.env'), 'TZ=UTC\n');
  for (const target of [home, zylos, env.PM2_HOME, tmp, dbPath]) assert.ok(target.startsWith(root + path.sep));
  console.log(JSON.stringify({ schedulerJsonFixture: root, HOME: home, ZYLOS_DIR: zylos,
    PM2_HOME: env.PM2_HOME, TMPDIR: tmp, TMUX_TMPDIR: tmp, database: dbPath }));
  let db;
  t.after(() => {
    fs.chmodSync(path.dirname(dbPath), 0o700);
    if (fs.existsSync(dbPath)) fs.chmodSync(dbPath, 0o600);
    if (db?.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = args => {
    const result = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    return result;
  };
  const json = args => {
    const result = run([...args, '--json']);
    assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
    return { ...result, value: JSON.parse(result.stdout) };
  };
  assert.equal(run(['list']).status, 0);
  db = new Database(dbPath);
  const row = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const history = id => db.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id').all(id);
  const success = args => {
    const result = json(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.value.ok, true);
    assert.deepEqual(Object.keys(result.value).sort(), ['data', 'ok']);
    return result.value.data;
  };
  const add = (name, options = []) => success(['add', name, '--in', '2 hours', ...options]).task;
  const fail = (args, code, text) => {
    const result = json(args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, code, result.stdout);
    assert.equal(typeof result.value.error.message, 'string');
    assert.equal('data' in result.value, false);
    if (text) {
      const human = run(args);
      assert.equal(human.status, 1);
      assert.match(human.stderr, text);
      assert.doesNotMatch(human.stdout, /"ok":/);
    }
    return result.value.error;
  };
  const failed = (name, source) => {
    const task = add(name);
    db.prepare('UPDATE tasks SET status=?,last_error=?,failed_at=? WHERE id=?').run(
      'failed', source === 'missed' ? 'Missed execution window' : 'DISPATCH_REJECTED', source === 'missed' ? null : 123, task.id);
    const insert = db.prepare('INSERT INTO task_history(task_id,executed_at,completed_at,status,duration_ms,error) VALUES(?,?,?,?,?,?)');
    insert.run(task.id, 100, 105, 'success', 5000, null);
    insert.run(task.id, 110, 111, 'failed', 1000, 'retained error');
    return row(task.id);
  };
  return { root, home, zylos, dbPath, env, db, run, json, success, add, fail, failed, row, history };
}

test('scheduler write commands return one structured result and their persisted rows', t => {
  const f = fixture(t);
  const task = f.add('structured task');
  assert.deepEqual(task, f.row(task.id));
  const updated = f.success(['update', task.id, '--name', 'renamed', '--priority', '2']);
  assert.deepEqual(updated.task, f.row(task.id));
  assert.equal(updated.task.name, 'renamed');
  assert.equal(updated.task.priority, 2);
  assert.ok(updated.updatedFields.includes('name'));
  assert.ok(updated.updatedFields.includes('priority'));
  assert.equal(updated.reenabled, false);
  const paused = f.success(['pause', task.id]);
  assert.deepEqual(paused, { task: f.row(task.id) });
  assert.equal(paused.task.status, 'paused');
  const resumed = f.success(['resume', task.id]);
  assert.deepEqual(resumed, { task: f.row(task.id) });
  assert.equal(resumed.task.status, 'pending');
  const done = f.success(['done', task.id]);
  assert.deepEqual(done, { task: f.row(task.id) });
  assert.equal(done.task.status, 'completed');
  assert.deepEqual(JSON.parse(f.run(['list', '--json']).stdout), []);
  assert.deepEqual(f.success(['remove', task.id]), { id: task.id });
  assert.equal(f.row(task.id), undefined);
});

test('failed one-time tasks from both failure sources are rescheduled without changing history', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.zylos, '.env'), 'TZ=Asia/Tokyo\n');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Tokyo',
    year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date()).map(part => [part.type, part.value]));
  // Tokyo has no daylight-saving transition; local 09:00 is UTC midnight.
  const tomorrow = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1) / 1000;
  for (const source of ['missed', 'dispatch']) {
    const task = f.failed(`${source} task`, source);
    const history = f.history(task.id);
    const result = f.success(['update', task.id, '--at', 'tomorrow 9am']);
    assert.equal(result.reenabled, true);
    assert.equal(result.task.status, 'pending');
    assert.equal(result.task.next_run_at, tomorrow);
    assert.equal(result.task.timezone, 'Asia/Tokyo');
    assert.equal(result.task.failed_at, null);
    assert.equal(result.task.last_error, null);
    assert.deepEqual(result.task, f.row(task.id));
    assert.deepEqual(f.history(task.id), history);
  }
});

test('future duration and recurring schedules reenable the original failed one-time task', t => {
  const f = fixture(t);
  for (const [flag, schedule, type] of [['--in', '2 hours', 'one-time'], ['--cron', '0 9 * * *', 'recurring'], ['--every', '2 hours', 'interval']]) {
    const task = f.failed(`retry ${type}`, 'missed');
    const previousHistory = f.history(task.id);
    const result = f.success(['update', task.id, flag, schedule]);
    assert.equal(result.reenabled, true);
    assert.equal(result.task.type, type);
    assert.equal(result.task.status, 'pending');
    assert.ok(result.task.next_run_at > Math.floor(Date.now() / 1000));
    assert.equal(result.task.failed_at, null);
    assert.equal(result.task.last_error, null);
    assert.deepEqual(f.history(task.id), previousHistory);
  }
  const textTask = f.failed('text retry', 'dispatch');
  const result = f.run(['update', textTask.id, '--in', '2 hours']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Task updated:/);
  assert.match(result.stdout, /  Re-enabled: pending/);
});

test('past rescheduling rejects without writes and non-schedule edits preserve failed status', t => {
  const f = fixture(t);
  const task = f.failed('failed task', 'dispatch');
  const history = f.history(task.id);
  const before = JSON.stringify(f.row(task.id));
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const error = f.fail(['update', task.id, '--at', past], 'RESCHEDULE_NOT_FUTURE', /Error:/);
  assert.ok(error.nextRunAt < Math.floor(Date.now() / 1000));
  assert.equal(JSON.stringify(f.row(task.id)), before);
  assert.deepEqual(f.history(task.id), history);
  const rename = f.success(['update', task.id, '--name', 'still failed']);
  assert.equal(rename.reenabled, false);
  assert.equal(rename.task.status, 'failed');
  assert.equal(rename.task.failed_at, task.failed_at);
  assert.equal(rename.task.last_error, task.last_error);
  f.db.prepare('UPDATE tasks SET type=?,cron_expression=? WHERE id=?').run('recurring', '0 8 * * *', task.id);
  const recurring = f.success(['update', task.id, '--cron', '0 9 * * *']);
  assert.equal(recurring.reenabled, false);
  assert.equal(recurring.task.status, 'failed');
  assert.deepEqual(f.history(task.id), history);
});

test('session target clearing preserves reply address and rejects conflicting target flags without writes', t => {
  const f = fixture(t);
  const task = f.add('routing task');
  const target = f.success(['update', task.id, '--reply-channel', 'telegram', '--reply-endpoint', '1001', '--reply-session-group', 'dm-1001']).task;
  assert.equal(target.session_component, 'telegram');
  assert.equal(target.session_group_name, 'dm-1001');
  assert.deepEqual(f.row(task.id), target);
  for (const flags of [
    ['--reply-channel', 'telegram', '--reply-endpoint', '1001'],
    ['--reply-channel', 'telegram'], ['--reply-endpoint', '1001'], ['--reply-session-group', 'dm-1001'],
  ]) {
    const before = JSON.stringify(f.row(task.id));
    f.fail(['update', task.id, '--clear-session-group', ...flags], 'INVALID_ARGS', /Error:/);
    assert.equal(JSON.stringify(f.row(task.id)), before);
  }
  const cleared = f.success(['update', task.id, '--clear-session-group']).task;
  assert.equal(cleared.session_component, null);
  assert.equal(cleared.session_group_name, null);
  assert.equal(cleared.reply_channel, 'telegram');
  assert.equal(cleared.reply_endpoint, '1001');
  const resetTarget = f.success(['update', task.id, '--reply-channel', 'telegram', '--reply-endpoint', '1001', '--reply-session-group', 'dm-1001']).task;
  const clearReply = f.success(['update', task.id, '--clear-reply']).task;
  assert.equal(clearReply.reply_channel, null);
  assert.equal(clearReply.reply_endpoint, null);
  assert.equal(clearReply.session_component, resetTarget.session_component);
  assert.equal(clearReply.session_group_name, resetTarget.session_group_name);
  f.fail(['update', task.id, '--reply-channel', 'telegram', '--reply-endpoint', '1001', '--reply-session-group', 'bad group'], 'SESSION_GROUP_INVALID');
});

test('write validation failures have stable codes and nonzero exits in JSON and legacy text', t => {
  const f = fixture(t);
  const task = f.add('validation task');
  const cases = [
    [['add', 'missing schedule'], 'INVALID_ARGS', /Error: Must specify timing/],
    [['add', '--in', '2 hours'], 'INVALID_ARGS', /Error: Prompt is required/],
    [['add', 'invalid priority', '--in', '2 hours', '--priority', '9'], 'INVALID_ARGS', /Error: Priority must be 1-3/],
    [['add', 'invalid cron', '--cron', 'not a cron'], 'INVALID_ARGS', /Error: Invalid cron expression/],
    [['add', 'invalid duration', '--in', 'nonsense'], 'INVALID_ARGS', /Error: Invalid duration/],
    [['add', 'invalid interval', '--every', 'nonsense'], 'INVALID_ARGS', /Error: Invalid interval/],
    [['add', 'invalid threshold', '--in', '2 hours', '--miss-threshold', '-1'], 'INVALID_ARGS', /Error: miss-threshold must be a positive integer/],
    [['update', task.id], 'NO_UPDATES', /Error: No updates provided/],
    [['update', task.id, '--priority', '9'], 'INVALID_ARGS', /Error: Priority must be 1-3/],
    [['update', task.id, '--miss-threshold', '-1'], 'INVALID_ARGS', /Error: miss-threshold must be a positive integer/],
    [['update', task.id, '--cron', 'not a cron'], 'INVALID_ARGS', /Error: Invalid cron expression/],
    [['update', task.id, '--in', 'nonsense'], 'INVALID_ARGS', /Error: Invalid duration/],
    [['update', task.id, '--every', 'nonsense'], 'INVALID_ARGS', /Error: Invalid interval/],
    [['update', task.id, '--at', 'nonsense'], 'INVALID_ARGS', /Error: Could not parse time/],
    [['update', 'absent', '--name', 'x'], 'TASK_NOT_FOUND', /Error: Task not found: absent/],
    [['remove', 'absent'], 'TASK_NOT_FOUND', /Error: Task not found: absent/],
    [['done', 'absent'], 'TASK_NOT_FOUND', /Error: Task not found: absent/],
  ];
  for (const [args, code, text] of cases) f.fail(args, code, text);
  for (const command of ['update', 'remove', 'done', 'pause', 'resume']) f.fail([command], 'INVALID_ARGS', /Error: Task ID is required/);
  for (const command of ['pause', 'resume']) f.fail([command, 'absent'], 'TASK_NOT_FOUND', /Error: (?:Pending|Paused) task not found: absent/);
  f.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('running', task.id);
  const pause = f.fail(['pause', task.id], 'TASK_WRONG_STATUS', /Error: Pending task not found:/);
  assert.equal(pause.status, 'running');
  const resume = f.fail(['resume', task.id], 'TASK_WRONG_STATUS', /Error: Paused task not found:/);
  assert.equal(resume.status, 'running');
  const other = f.add('second task');
  for (const command of ['update', 'remove', 'done']) {
    const args = command === 'update' ? [command, 'task-', '--name', 'x'] : [command, 'task-'];
    const error = f.fail(args, 'TASK_AMBIGUOUS', /Error: Ambiguous task ID prefix 'task-'/);
    assert.deepEqual(error.matches.sort(), [task.id, other.id].sort());
  }
});

test('history JSON is bounded, ordered deterministically and excludes prompt text', t => {
  const f = fixture(t);
  const task = f.add('private prompt');
  const other = f.add('another private prompt');
  const empty = f.success(['history']);
  assert.deepEqual(empty, { rows: [], ambiguousPrefix: [] });
  const insert = f.db.prepare('INSERT INTO task_history(task_id,executed_at,completed_at,status,duration_ms,error) VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < 25; i++) insert.run(task.id, 100 + Math.floor(i / 2), 200 + i, 'success', i * 1000, i === 2 ? 'retained error' : null);
  const expected = f.db.prepare(`SELECT h.id,h.task_id,t.name,h.executed_at,h.completed_at,h.status,h.duration_ms,h.error
    FROM task_history h JOIN tasks t ON t.id=h.task_id ORDER BY h.executed_at DESC,h.id DESC`).all();
  const result = f.success(['history']);
  assert.deepEqual(result.rows, expected.slice(0, 20));
  assert.deepEqual(result.ambiguousPrefix, []);
  const all = f.success(['history', task.id, '--limit', '1000']);
  assert.deepEqual(all.rows, expected);
  assert.equal(all.rows.length, 25);
  assert.ok(all.rows.every(row => !Object.hasOwn(row, 'prompt')));
  const ambiguous = f.success(['history', 'task-', '--limit', '1000']);
  assert.deepEqual(ambiguous.ambiguousPrefix.sort(), [task.id, other.id].sort());
  assert.deepEqual(ambiguous.rows, expected);
  for (const limit of ['0', '1001', '1.5', 'nonsense']) f.fail(['history', '--limit', limit], 'INVALID_ARGS', /Error:/);
  const text = f.run(['history', task.id, '--limit', '1']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.split('\n').filter(line => /\| success\s*\|/.test(line)).length, 1);
});

test('timezone and SQLite write failures use the structured error envelope', t => {
  const f = fixture(t);
  const task = f.add('write failure task');
  fs.writeFileSync(path.join(f.zylos, '.env'), 'TZ=Not/A_Timezone\n');
  f.fail(['update', task.id, '--name', 'x'], 'INVALID_TZ', /Error \[INVALID_TZ\]:/);
  fs.writeFileSync(path.join(f.zylos, '.env'), 'TZ=UTC\n');
  f.db.pragma('wal_checkpoint(TRUNCATE)');
  f.db.close();
  fs.chmodSync(f.dbPath, 0o400);
  fs.chmodSync(path.dirname(f.dbPath), 0o500);
  try {
    const result = f.json(['update', task.id, '--name', 'x']);
    assert.equal(result.status, 1);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, 'DB_WRITE_FAILED');
    assert.equal('data' in result.value, false);
  } finally {
    fs.chmodSync(path.dirname(f.dbPath), 0o700);
    fs.chmodSync(f.dbPath, 0o600);
  }
  const db = new Database(f.dbPath, { readonly: true });
  try { assert.equal(db.prepare('SELECT name FROM tasks WHERE id=?').get(task.id).name, task.name); }
  finally { db.close(); }
});
