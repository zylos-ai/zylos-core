import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../schema.js';
import { processCompletedTasks } from '../daemon-tasks.js';

const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

// Boundary: actual CLI children and unchanged completion/cadence code against a
// private SQLite database. Run for CLI writes, result envelopes, route or timing
// changes; UI-only changes may skip. No daemon, PM2, tmux or network is launched.
// Before any child launch every instance/env/database/socket path is checked and
// logged. Children are synchronous and bounded; t.after closes DB and removes root.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scj-')));
  const env = { PATH: process.env.PATH, TZ: 'UTC', LANG: 'C.UTF-8' };
  for (const [key, name] of Object.entries({ HOME: 'h', ZYLOS_DIR: 'z', PM2_HOME: 'p', CODEX_HOME: 'c', TMPDIR: 't', TMUX_TMPDIR: 'm' })) {
    env[key] = path.join(root, name); fs.mkdirSync(env[key]);
  }
  fs.mkdirSync(path.join(env.ZYLOS_DIR, 'scheduler'));
  const dbPath = path.join(env.ZYLOS_DIR, 'scheduler', 'scheduler.db');
  for (const target of [...Object.values(env).filter(value => value.startsWith(root)), dbPath]) assert.ok(target.startsWith(root + path.sep));
  const db = new Database(dbPath); guardDatabase(db, schema); db.pragma('journal_mode=WAL');
  const configure = timezone => fs.writeFileSync(path.join(env.ZYLOS_DIR, '.env'), `TZ=${timezone}\n`);
  configure('UTC');
  console.log('CLI isolation:', JSON.stringify({ ...env, PATH: undefined, dbPath, cliPath, tmux: 'not launched', pm2: 'not launched' }));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  const run = args => {
    const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
    return result;
  };
  const json = (args, expectedCode) => {
    const result = run([...args, '--json']);
    assert.equal(result.status, expectedCode ? 1 : 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 1, result.stdout);
    const body = JSON.parse(lines[0]); assert.equal(body.ok, !expectedCode);
    if (expectedCode) { assert.equal(body.error.code, expectedCode); assert.equal(typeof body.error.message, 'string'); }
    else assert.equal(typeof body.data, 'object');
    return body;
  };
  const add = (timing = ['--in', '1 hour'], extra = []) => json(['add', 'private task prompt', ...timing, ...extra]).data.task;
  const read = id => db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  const history = id => db.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id').all(id);
  return { root, env, db, configure, run, json, add, read, history };
}

test('JSON write commands return their persisted result and done still completes work', t => {
  const f = fixture(t), task = f.add();
  assert.deepEqual(f.read(task.id), task);
  assert.equal(f.json(['update', task.id, '--name', 'renamed']).data.task.name, 'renamed');
  assert.equal(f.json(['pause', task.id]).data.task.status, 'paused');
  assert.equal(f.json(['resume', task.id]).data.task.status, 'pending');
  f.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.id);
  const started = Math.floor(Date.now() / 1000) - 10;
  const oldId = f.db.prepare("INSERT INTO task_history(task_id,executed_at,status,error) VALUES(?,?,'failed','old failure')").run(task.id, started - 30).lastInsertRowid;
  const oldHistory = JSON.stringify(f.history(task.id)[0]);
  const currentId = Number(f.db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,?,'started')").run(task.id, started).lastInsertRowid);
  const done = f.json(['done', task.id]).data.task;
  assert.equal(done.status, 'completed'); assert.equal(f.read(task.id).status, 'completed');
  const completed = f.history(task.id).find(row => row.id === currentId);
  assert.equal(completed.status, 'success'); assert.ok(completed.completed_at >= started + 10);
  assert.equal(completed.duration_ms, (completed.completed_at - started) * 1000);
  assert.equal(JSON.stringify(f.history(task.id).find(row => row.id === Number(oldId))), oldHistory);
  assert.equal(f.json(['remove', task.id]).data.id, task.id); assert.equal(f.read(task.id), undefined);
  assert.equal(f.db.pragma('user_version', { simple: true }), 1);
  const columns = f.db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
  assert.equal(columns.includes('session_component'), false); assert.equal(columns.includes('session_group_name'), false);
});

for (const [type, timing, update] of [
  ['recurring', ['--cron', '0 9 * * *'], ['--at', '2035-01-01 12:00']],
  ['interval', ['--every', '2 hours'], ['--in', '3 hours']],
]) test(`${type} next-run override preserves saved cadence and timezone through real completion`, t => {
  const f = fixture(t), task = f.add(timing);
  f.db.prepare("UPDATE tasks SET timezone='Asia/Shanghai' WHERE id=?").run(task.id);
  const before = f.read(task.id); f.configure('America/New_York');
  const output = f.json(['update', task.id, ...update]).data;
  assert.equal(output.nextRunOnly, true);
  const after = f.read(task.id);
  for (const key of ['type', 'cron_expression', 'interval_seconds', 'timezone']) assert.equal(after[key], before[key], key);
  if (type === 'recurring') assert.equal(after.next_run_at, Date.parse('2035-01-01T17:00:00Z') / 1000);
  else assert.ok(after.next_run_at >= Math.floor(Date.now() / 1000) + 10790 && after.next_run_at <= Math.floor(Date.now() / 1000) + 10810);
  const text = f.run(['update', task.id, '--in', '4 hours']); assert.equal(text.status, 0);
  assert.ok(text.stdout.includes('Only the next run changed; recurring schedule and timezone unchanged'));
  f.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.id);
  f.db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,?,'started')").run(task.id, Math.floor(Date.now() / 1000));
  f.json(['done', task.id]); assert.equal(f.read(task.id).status, 'completed');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2035-01-01T17:00:00Z') });
  processCompletedTasks(f.db);
  const next = f.read(task.id); assert.equal(next.status, 'pending');
  assert.equal(next.next_run_at, Date.parse(type === 'recurring' ? '2035-01-02T01:00:00Z' : '2035-01-01T19:00:00Z') / 1000);
  assert.equal(next.timezone, 'Asia/Shanghai');
});

test('one-time overrides and explicit replacement schedules retain their own timezone behavior', t => {
  const f = fixture(t), task = f.add(); f.configure('America/New_York');
  const update = f.json(['update', task.id, '--at', '2035-01-01 12:00']).data;
  assert.notEqual(update.nextRunOnly, true); assert.equal(update.task.type, 'one-time');
  assert.equal(update.task.timezone, 'America/New_York'); assert.equal(update.task.next_run_at, Date.parse('2035-01-01T17:00:00Z') / 1000);
  const recurring = f.json(['update', task.id, '--cron', '0 10 * * *']).data.task;
  assert.equal(recurring.type, 'recurring'); assert.equal(recurring.timezone, 'America/New_York'); assert.equal(recurring.cron_expression, '0 10 * * *');
  f.configure('UTC'); const interval = f.json(['update', task.id, '--every', '2 hours']).data.task;
  assert.equal(interval.type, 'interval'); assert.equal(interval.interval_seconds, 7200); assert.equal(interval.cron_expression, null); assert.equal(interval.timezone, 'UTC');
});

for (const timing of [['--in', '2 hours'], ['--at', '2035-01-01 12:00'], ['--cron', '0 8 * * *'], ['--every', '1 hour']])
test(`failed one-time task is re-enabled by ${timing[0]} with cleared failure details`, t => {
  const f = fixture(t), task = f.add(); f.db.prepare("UPDATE tasks SET status='failed',last_error='old failure',failed_at=1 WHERE id=?").run(task.id);
  const updated = f.json(['update', task.id, ...timing]).data.task;
  assert.equal(updated.status, 'pending'); assert.equal(updated.last_error, null); assert.equal(updated.failed_at, null);
  assert.ok(updated.next_run_at > Math.floor(Date.now() / 1000)); assert.deepEqual(f.read(task.id), updated);
});

test('failed-task updates without timing keep failure and nonfuture rescheduling writes nothing', t => {
  const f = fixture(t), task = f.add(); f.db.prepare("UPDATE tasks SET status='failed',last_error='retained failure',failed_at=1 WHERE id=?").run(task.id);
  f.json(['update', task.id, '--name', 'still failed']); const before = f.read(task.id);
  assert.equal(before.status, 'failed'); assert.equal(before.last_error, 'retained failure'); assert.equal(before.failed_at, 1);
  f.json(['update', task.id, '--at', '2000-01-01 12:00', '--name', 'must not apply'], 'RESCHEDULE_NOT_FUTURE');
  assert.deepEqual(f.read(task.id), before);
});

for (const command of ['update', 'done', 'remove', 'pause', 'resume'])
test(`${command} JSON errors distinguish missing ID, missing task and ambiguous prefix`, t => {
  const f = fixture(t);
  f.json([command], 'INVALID_ARGS'); f.json([command, 'not-present'], 'TASK_NOT_FOUND');
  f.add(); f.add();
  if (command === 'resume') f.db.prepare("UPDATE tasks SET status='paused'").run();
  f.json([command, 'task-'], 'TASK_AMBIGUOUS');
});

for (const [command, states] of [['pause', ['paused', 'running', 'completed', 'failed']], ['resume', ['pending', 'running', 'completed', 'failed']]])
test(`${command} reports current status without changing an ineligible task`, t => {
  const f = fixture(t), task = f.add();
  for (const status of states) {
    f.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, task.id); const before = f.read(task.id);
    assert.equal(f.json([command, task.id], 'TASK_WRONG_STATUS').error.status, status); assert.deepEqual(f.read(task.id), before);
  }
});

test('invalid arguments and absent update fields have structured errors without writes', t => {
  const f = fixture(t), task = f.add(), before = f.read(task.id);
  for (const args of [['add'], ['add', 'missing timing'], ['add', 'bad', '--cron', 'bogus'], ['add', 'bad', '--in', 'not a duration'], ['update', task.id, '--priority', '9']]) f.json(args, 'INVALID_ARGS');
  f.json(['update', task.id], 'NO_UPDATES'); assert.deepEqual(f.read(task.id), before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 1);
});

for (const route of [
  ['--reply-channel', 'telegram'], ['--reply-endpoint', '123'],
  ['--reply-channel', '', '--reply-endpoint', '123'], ['--reply-channel', 'telegram', '--reply-endpoint', ''],
  ['--reply-channel', '  ', '--reply-endpoint', '123'], ['--reply-channel', 'telegram', '--reply-endpoint', '\t '],
]) test(`incomplete or empty add reply fields are rejected: ${JSON.stringify(route)}`, t => {
  const f = fixture(t); f.json(['add', 'bad route', '--in', '1 hour', ...route], 'INVALID_ARGS');
  assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 0);
});

test('update validates merged reply values, rejects empty inputs atomically and supports clear', t => {
  const f = fixture(t), task = f.add(), before = f.read(task.id);
  f.json(['update', task.id, '--reply-channel', 'telegram', '--name', 'not saved'], 'INVALID_ARGS'); assert.deepEqual(f.read(task.id), before);
  f.json(['update', task.id, '--reply-endpoint', '123', '--name', 'not saved'], 'INVALID_ARGS'); assert.deepEqual(f.read(task.id), before);
  f.json(['update', task.id, '--reply-channel', 'telegram', '--reply-endpoint', '123']);
  assert.equal(f.json(['update', task.id, '--reply-endpoint', '456']).data.task.reply_channel, 'telegram');
  assert.equal(f.json(['update', task.id, '--reply-channel', 'lark']).data.task.reply_endpoint, '456');
  for (const option of ['--reply-channel', '--reply-endpoint']) for (const value of ['', '  ', '\t']) {
    const saved = f.read(task.id); f.json(['update', task.id, option, value, '--name', 'not saved'], 'INVALID_ARGS'); assert.deepEqual(f.read(task.id), saved);
  }
  const cleared = f.json(['update', task.id, '--clear-reply']).data.task;
  assert.equal(cleared.reply_channel, null); assert.equal(cleared.reply_endpoint, null);
});

test('history JSON limits rows, omits prompts and reports ambiguity without rejecting matching rows', t => {
  const f = fixture(t), first = f.add(), second = f.add();
  const insert = f.db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,?,'success')");
  for (let index = 0; index < 25; index++) insert.run(index % 2 ? first.id : second.id, 1000 + index);
  const all = f.json(['history']).data; assert.equal(all.rows.length, 20);
  for (const row of all.rows) assert.equal(Object.hasOwn(row, 'prompt'), false);
  const one = f.json(['history', '--limit', '1']).data; assert.equal(one.rows.length, 1); assert.equal(one.rows[0].executed_at, 1024);
  assert.equal(f.json(['history', '--limit', '1000']).data.rows.length, 25);
  const ambiguous = f.json(['history', 'task-', '--limit', '3']).data;
  assert.deepEqual([...ambiguous.ambiguousPrefix].sort(), [first.id, second.id].sort()); assert.equal(ambiguous.rows.length, 3);
  assert.deepEqual(f.json(['history', first.id]).data.ambiguousPrefix, []);
  assert.deepEqual(all.ambiguousPrefix, []);
  const olderTie = Number(insert.run(first.id, 2000).lastInsertRowid);
  const newerTie = Number(insert.run(second.id, 2000).lastInsertRowid);
  assert.deepEqual(f.json(['history', '--limit', '2']).data.rows.map(row => row.id), [newerTie, olderTie]);
  for (const limit of ['0', '1001', '1.5', 'nope', '']) f.json(['history', '--limit', limit], 'INVALID_ARGS');
});

for (const command of ['add', 'update', 'done', 'remove', 'pause', 'resume'])
test(`${command} reports database write failure and leaves its task/history unchanged`, t => {
  const f = fixture(t), task = f.add();
  if (command === 'resume') f.db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(task.id);
  if (command === 'done') {
    f.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(task.id);
    f.db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,1,'started')").run(task.id);
  }
  const before = f.read(task.id), history = JSON.stringify(f.history(task.id));
  if (command === 'done') f.db.exec("CREATE TRIGGER refuse_write BEFORE UPDATE ON task_history BEGIN SELECT RAISE(ABORT,'private write blocked'); END");
  else f.db.exec(`CREATE TRIGGER refuse_write BEFORE ${command === 'add' ? 'INSERT' : command === 'remove' ? 'DELETE' : 'UPDATE'} ON tasks BEGIN SELECT RAISE(ABORT,'private write blocked'); END`);
  const args = command === 'add' ? ['add', 'blocked', '--in', '1 hour'] : command === 'update' ? ['update', task.id, '--name', 'blocked'] : [command, task.id];
  f.json(args, 'DB_WRITE_FAILED'); assert.deepEqual(f.read(task.id), before); assert.equal(JSON.stringify(f.history(task.id)), history);
  assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 1);
});

test('legacy text errors keep their output and exit status while JSON timezone errors are structured', t => {
  const f = fixture(t), task = f.add();
  const help = f.run(['--help']).stdout;
  for (const [args, stderr, stdout] of [
    [['add'], 'Error: Prompt is required\n', 'Usage: cli.js add "<prompt>" [options]\n'],
    [['add', 'no timing'], 'Error: Must specify timing (--in, --at, --cron, or --every)\n', help],
    [['done', 'missing'], 'Error: Task not found: missing\n', ''],
    [['update', task.id], 'Error: No updates provided\n', 'Use --help to see available options\n'],
  ]) {
    const result = f.run(args); assert.equal(result.status, 0);
    assert.equal(result.stderr, stderr); assert.equal(result.stdout, stdout);
  }
  f.configure('Mars/Olympus');
  f.json(['add', 'timezone failure', '--in', '1 hour'], 'INVALID_TZ');
  const text = f.run(['add', 'timezone failure', '--in', '1 hour']); assert.equal(text.status, 1); assert.match(text.stderr, /INVALID_TZ/);
});


test('text values beginning with option markers keep established parsing behavior', t => {
  const f = fixture(t);
  const created = f.run(['add', 'hello', '--name', '--weird', '--in', '1 hour']);
  assert.equal(created.status, 0); assert.equal(created.stderr, '');
  const task = f.db.prepare('SELECT * FROM tasks').get(); assert.equal(task.name, '--weird');
  const updated = f.run(['update', task.id, '--prompt', '--flag text']);
  assert.equal(updated.status, 0); assert.equal(updated.stderr, '');
  assert.equal(f.read(task.id).prompt, '--flag text');
  const before = f.db.prepare('SELECT count(*) n FROM tasks').get().n;
  const invalid = f.run(['add', 'hello', '--in', '--at', '2030-06-01 10:00']);
  assert.equal(invalid.status, 0); assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'Error: Invalid duration "--at"\n');
  assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, before);
});

test('unsupported JSON modes retain plain next, running and unknown-command results', t => {
  const f = fixture(t);
  for (const command of ['next', 'running', 'bogus']) {
    const plain = f.run([command]), flagged = f.run([command, '--json']);
    assert.equal(plain.status, 0); assert.equal(flagged.status, plain.status);
    assert.equal(flagged.stdout, plain.stdout); assert.equal(flagged.stderr, plain.stderr);
  }
});

test('JSON mode keeps established option precedence and permissive integer parsing', t => {
  const f = fixture(t);
  const created = f.json(['add', 'literal', '--in', '1 hour', '--cron', 'bogus', '--priority', '2junk', '--unused-option', 'ignored']).data.task;
  assert.equal(created.type, 'one-time'); assert.equal(created.priority, 2);
  assert.ok(created.next_run_at > Math.floor(Date.now() / 1000));
  const updated = f.json(['update', created.id, '--priority', '1.5', '--miss-threshold', '30seconds', 'ignored positional']).data.task;
  assert.equal(updated.priority, 1); assert.equal(updated.miss_threshold, 30);
});

for (const command of ['pause', 'resume'])
test(`${command} filters a mixed-status prefix before checking JSON ambiguity`, t => {
  const f = fixture(t), first = f.add(), second = f.add();
  f.db.prepare("UPDATE tasks SET id='task-mixed-pending',status='pending' WHERE id=?").run(first.id);
  f.db.prepare("UPDATE tasks SET id='task-mixed-paused',status='paused' WHERE id=?").run(second.id);
  const target = command === 'pause' ? 'task-mixed-pending' : 'task-mixed-paused';
  const other = command === 'pause' ? 'task-mixed-paused' : 'task-mixed-pending';
  const before = JSON.stringify(f.read(other));
  assert.equal(f.json([command, 'task-mixed-']).data.task.id, target);
  assert.equal(JSON.stringify(f.read(other)), before);
});

test('text pause and resume keep status-filtered missing-task wording', t => {
  const f = fixture(t), task = f.add();
  f.db.prepare("UPDATE tasks SET status='paused' WHERE id=?").run(task.id);
  const paused = f.run(['pause', task.id]); assert.equal(paused.status, 0);
  assert.equal(paused.stdout, ''); assert.equal(paused.stderr, `Error: Pending task not found: ${task.id}\n`);
  f.db.prepare("UPDATE tasks SET status='pending' WHERE id=?").run(task.id);
  const pending = f.run(['resume', task.id]); assert.equal(pending.status, 0);
  assert.equal(pending.stdout, ''); assert.equal(pending.stderr, `Error: Paused task not found: ${task.id}\n`);
});

test('new reply-pair and nonfuture-reschedule rejections exit one in text mode without writes', t => {
  const f = fixture(t), task = f.add();
  const before = f.read(task.id);
  const add = f.run(['add', 'bad route', '--in', '1 hour', '--reply-channel', 'telegram']);
  assert.equal(add.status, 1); assert.match(add.stderr, /reply-channel/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n, 1);
  const update = f.run(['update', task.id, '--reply-endpoint', '123', '--name', 'not saved']);
  assert.equal(update.status, 1); assert.match(update.stderr, /reply-channel/); assert.deepEqual(f.read(task.id), before);
  f.db.prepare("UPDATE tasks SET status='failed',last_error='failure',failed_at=1 WHERE id=?").run(task.id);
  const failed = f.read(task.id);
  const reschedule = f.run(['update', task.id, '--at', '2000-01-01 12:00', '--name', 'not saved']);
  assert.equal(reschedule.status, 1); assert.match(reschedule.stderr, /future/i); assert.deepEqual(f.read(task.id), failed);
});

for (const [type, timing] of [['recurring', ['--cron', '0 9 * * *']], ['interval', ['--every', '1 hour']]])
test(`failed ${type} timing updates do not re-enable it or clear its failure details`, t => {
  const f = fixture(t), task = f.add(timing);
  f.db.prepare("UPDATE tasks SET status='failed',last_error='rescheduling failed',failed_at=1 WHERE id=?").run(task.id);
  for (const update of [['--in', '2 hours'], ['--cron', '0 8 * * *'], ['--every', '3 hours']]) {
    const updated = f.json(['update', task.id, ...update]).data.task;
    assert.equal(updated.status, 'failed'); assert.equal(updated.last_error, 'rescheduling failed'); assert.equal(updated.failed_at, 1);
  }
});
