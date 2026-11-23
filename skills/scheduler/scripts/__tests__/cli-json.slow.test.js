// covers: skills/comm-bridge/scripts/sqlite-driver.js skills/scheduler/scripts/daemon-dispatch.js skills/scheduler/scripts/cli.js skills/scheduler/scripts/database.js skills/scheduler/scripts/__tests__/helpers/scheduler-cli-clock.js skills/scheduler/scripts/__tests__/fixtures/claim-during-query.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { runSchedulerIteration } from '../daemon-dispatch.js';

const clockCliPath = fileURLToPath(new URL('./helpers/scheduler-cli-clock.js', import.meta.url));
const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

// Real CLI/private SQLite/daemon boundary. Run when update, delivery or done
// semantics change; skip unrelated UI. Outer runner + fixture isolate all env
// paths and DB; injected C4 query/send, no tmux/PM2/network. Child timeout15s;
// fixture finally closes DB and removes private files.
for (const [type, create] of [
  ['recurring', ['--cron', '0 9 * * *']], ['interval', ['--every', '30 minutes']],
]) for (const timing of [['--at', '2030-01-01 01:00'], ['--in', '1 hour']]) {
  test(`${type} ${timing[0]} override returns to its original cadence after delivery without done`, t => {
    const initial = Date.parse('2030-01-01T00:00:00Z');
    t.mock.timers.enable({ apis: ['Date'], now: initial });
    const f = fixture(t, { time: initial });
    const task = f.add('periodic delivery', create);
    f.db.prepare('UPDATE tasks SET timezone=? WHERE id=?').run('Asia/Shanghai', task.id);
    const before = f.row(task.id);
    const result = f.success(['update', task.id, ...timing, '--prompt', 'postponed delivery']);
    assert.equal(result.nextRunOnly, true); assert.equal('executionFinished' in result, false);
    for (const key of ['type', 'cron_expression', 'interval_seconds', 'timezone']) assert.equal(result.task[key], before[key]);
    assert.equal(result.task.next_run_at, initial / 1000 + 3600);
    assert.equal(result.task.status, 'pending'); assert.equal(result.updatedFields.includes('type'), false);
    const text = f.run(['update', task.id, ...timing]);assert.equal(text.status, 0);
    assert.match(text.stdout, /Only the next run changed; recurring schedule and timezone unchanged/);
    const target = result.task.next_run_at;let sends = 0;
    const deps = { getRecentConversations: () => [], sendViaC4: message => {
      sends++; assert.doesNotMatch(message, /After completing this task|cli\.js done/);
      t.mock.timers.tick(120000);return { category: 'success' };
    } };
    t.mock.timers.setTime(target * 1000 - 1000);runSchedulerIteration(f.db, deps);assert.equal(sends, 0);
    t.mock.timers.setTime(target * 1000);runSchedulerIteration(f.db, deps);assert.equal(sends, 1);
    const delivered = f.row(task.id), history = f.history(task.id);
    assert.equal(history.at(-1).status, 'success');assert.equal(history.at(-1).duration_ms, 120000);
    assert.equal(delivered.status, 'pending');
    for (const key of ['type', 'cron_expression', 'interval_seconds', 'timezone']) assert.equal(delivered[key], before[key]);
    assert.equal(delivered.next_run_at, type === 'recurring' ? initial / 1000 + 25 * 3600 : target + 120 + 1800);
    const done = f.success(['done', task.id]);assert.equal(done.alreadyCompleted, true);
    assert.deepEqual(f.row(task.id), delivered);assert.deepEqual(f.history(task.id), history);
  });
}

for (const [type, create] of [ ['one-time', []], ['recurring', ['--cron', '*/30 * * * *']], ['interval', ['--every', '30 minutes']] ]) {
  test(`legacy done never changes a ${type} task or history in any status`, t => {
    const f = fixture(t);const task = f.add('compatibility', create);
    for (const status of ['pending','running','completed','failed','paused']) {
      f.db.prepare('UPDATE tasks SET status=?,last_error=? WHERE id=?').run(status, 'retained', task.id);
      f.db.prepare("INSERT INTO task_history(task_id,executed_at,status,error) VALUES(?,1,'started','retained history')").run(task.id);
      const before = f.row(task.id), history = f.history(task.id);
      const result = f.success(['done', task.id]);assert.equal(result.alreadyCompleted, true);
      assert.equal(result.reason, 'DELIVERY_COMPLETES_AUTOMATICALLY');assert.deepEqual(result.task, before);
      const text = f.run(['done', task.id]);
      assert.equal(text.status, 0);
      assert.equal(text.stdout, `Task ${task.id} completes automatically on delivery and does not require done.\n`);
      assert.deepEqual(f.row(task.id),before);assert.deepEqual(f.history(task.id),history);
    }
  });
}

test('a delivery claimed or finished while an update is prepared rejects its timing edit without writes', t => {
  const f = fixture(t);
  const component = path.join(f.zylos, '.claude/skills/telegram');
  fs.mkdirSync(path.join(component, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(component, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/claim-during-query.js', import.meta.url)),
    path.join(component, 'scripts/session-group.js'));
  const driver = new URL('../../../comm-bridge/scripts/sqlite-driver.js', import.meta.url).href;
  const cases = [
    { create: ['--cron', '0 9 * * *'], from: 'pending', to: 'running' },
    { create: ['--every', '30 minutes'], from: 'pending', to: 'running' },
    { create: [], from: 'pending', to: 'running' },
    { create: [], from: 'running', to: 'completed' },
    { create: [], from: 'running', to: 'failed' },
    { create: [], from: 'pending', to: 'completed' },
  ];
  for (const { create, from, to } of cases) {
    const task = f.add(`${from} to ${to} during update`, create);
    f.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(from, task.id);
    fs.writeFileSync(path.join(component, 'claim.json'), JSON.stringify({ database: f.dbPath, taskId: task.id, driver, status: to }));
    const before = f.row(task.id), history = f.history(task.id);
    const error = f.fail(['update', task.id, '--in', '30 minutes', '--reply-channel', 'telegram',
      '--reply-endpoint', 'chat-1'], 'TASK_WRONG_STATUS');
    assert.equal(error.status, to);
    assert.deepEqual(f.row(task.id), { ...before, status: to });
    assert.deepEqual(f.history(task.id), history);
  }
});

// These cases cover the real CLI/store boundary, including private-file failures.
// Run for scheduler CLI/schema/routing changes; unrelated UI changes may skip them.
// Children never call tmux/PM2; introducing those calls requires a private tmux socket.
function fixture(t, { time } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-json-'));
  const home = path.join(root, 'home');
  const zylos = path.join(home, 'zylos');
  const tmp = path.join(root, 'tmp');
  const dbPath = path.join(zylos, 'scheduler/scheduler.db');
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(home, '.pm2'),
    TMPDIR: tmp, TMUX_TMPDIR: tmp, TZ: 'UTC', ZYLOS_SESSION_GROUP: 'origin' };
  for (const key of ['TMUX', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  for (const dir of [tmp, path.join(zylos, 'scheduler'), path.join(zylos, '.claude/skills/telegram')]) fs.mkdirSync(dir, { recursive: true });
  if (time !== undefined) { env.SCHEDULER_TEST_TIME = String(time); env.NODE_NO_WARNINGS = '1'; }
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
  const run = (args, merged = false) => {
    const command = merged ? 'sh' : process.execPath;
    const entry = env.SCHEDULER_TEST_TIME === undefined ? cliPath : clockCliPath;
    const commandArgs = merged ? ['-c', 'exec "$@" 2>&1', 'scheduler-cli', process.execPath, entry, ...args] : [entry, ...args];
    const result = spawnSync(command, commandArgs, { env, encoding: 'utf8', timeout: 15000 });
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
  const add = (name, options = []) => success(['add', name,
    ...(options.some(value => ['--in', '--at', '--cron', '--every'].includes(value)) ? [] : ['--in', '2 hours']), ...options]).task;
  const fail = (args, code, text, textExitCode = 0) => {
    const result = json(args);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, code, result.stdout);
    assert.equal(typeof result.value.error.message, 'string');
    assert.equal('data' in result.value, false);
    if (text) {
      const human = run(args);
      assert.equal(human.status, textExitCode);
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
  assert.deepEqual(done, { task: f.row(task.id), alreadyCompleted: true, reason: 'DELIVERY_COMPLETES_AUTOMATICALLY' });
  assert.equal(done.task.status, 'pending');
  assert.equal(JSON.parse(f.run(['list', '--json']).stdout)[0].id, task.id);
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
