#!/usr/bin/env node
/**
 * Task CLI - Command line interface for Scheduler V2
 * Manages tasks: add, list, remove, done, pause, resume
 */

const { getDb, generateId, now } = require('./db');
const { getNextRun, isValidCron, describeCron } = require('./cron');
const { parseTime, parseDuration, formatTime, getRelativeTime } = require('./time-parser');
const { getStatus } = require('./activity');

const db = getDb();

const HELP = `
Task CLI - Scheduler V2

Usage: task-cli <command> [options]

Commands:
  list                    List all tasks
  add <prompt> [options]  Add a new task
  remove <task-id>        Remove a task
  done <task-id>          Mark task as completed
  pause <task-id>         Pause a task
  resume <task-id>        Resume a paused task
  status                  Show Claude's activity status
  history [task-id]       Show execution history
  next                    Show upcoming tasks
  running                 Show currently running tasks (for pre-compact check)

Add Options:
  --in "<duration>"       One-time: run in X time (e.g., "30 minutes")
  --at "<time>"           One-time: run at specific time (e.g., "tomorrow 9am")
  --cron "<expression>"   Recurring: cron expression (e.g., "0 8 * * *")
  --every "<interval>"    Interval: repeat every X time (e.g., "2 hours")
  --priority <1-4>        Priority level (1=critical, 4=low, default=3)
  --name "<name>"         Task name (optional)

Examples:
  task-cli add "Say hello" --in "30 minutes"
  task-cli add "Health check" --cron "0 8 * * *" --name "daily-health"
  task-cli add "Check updates" --every "1 hour" --priority 4
  task-cli done task-abc123
`;

function parseArgs(args) {
  const result = { command: null, args: [], options: {} };

  if (args.length === 0) {
    return result;
  }

  result.command = args[0];

  let i = 1;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      result.options[key] = value;
      i += 2;
    } else {
      result.args.push(arg);
      i++;
    }
  }

  return result;
}

// ===== Commands =====

function cmdList() {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status != 'completed' OR type != 'one-time'
    ORDER BY priority ASC, next_run_at ASC
  `).all();

  if (tasks.length === 0) {
    console.log('No tasks scheduled.');
    return;
  }

  console.log('\n  Tasks:\n');
  console.log('  ID              | Pri | Type      | Status  | Next Run           | Name');
  console.log('  ' + '-'.repeat(85));

  for (const task of tasks) {
    const id = task.id.substring(0, 14).padEnd(14);
    const pri = task.priority.toString().padEnd(3);
    const type = task.type.padEnd(9);
    const status = task.status.padEnd(7);
    const nextRun = task.status === 'completed' ? 'done'.padEnd(18) :
                    formatTime(task.next_run_at).padEnd(18);
    const name = task.name || task.prompt.substring(0, 30);

    console.log(`  ${id} | ${pri} | ${type} | ${status} | ${nextRun} | ${name}`);

    // Show prompt (truncated to 80 chars)
    const promptPreview = task.prompt.substring(0, 80).replace(/\n/g, ' ');
    console.log(`                    └─ ${promptPreview}${task.prompt.length > 80 ? '...' : ''}`);
  }
  console.log();
}

function cmdAdd(args, options) {
  const prompt = args.join(' ');

  if (!prompt) {
    console.error('Error: Prompt is required');
    console.log('Usage: task-cli add "<prompt>" [options]');
    return;
  }

  let type, nextRunAt, cronExpression, intervalSeconds;

  // Determine task type from options
  if (options.in) {
    type = 'one-time';
    const seconds = parseDuration(options.in);
    if (!seconds) {
      console.error(`Error: Invalid duration "${options.in}"`);
      return;
    }
    nextRunAt = now() + seconds;
  } else if (options.at) {
    type = 'one-time';
    nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      console.error(`Error: Could not parse time "${options.at}"`);
      return;
    }
  } else if (options.cron) {
    type = 'recurring';
    cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      console.error(`Error: Invalid cron expression "${cronExpression}"`);
      return;
    }
    nextRunAt = getNextRun(cronExpression);
  } else if (options.every) {
    type = 'interval';
    intervalSeconds = parseDuration(options.every);
    if (!intervalSeconds) {
      console.error(`Error: Invalid interval "${options.every}"`);
      return;
    }
    nextRunAt = now() + intervalSeconds;
  } else {
    console.error('Error: Must specify timing (--in, --at, --cron, or --every)');
    console.log(HELP);
    return;
  }

  const priority = parseInt(options.priority) || 3;
  if (priority < 1 || priority > 4) {
    console.error('Error: Priority must be 1-4');
    return;
  }

  const taskId = generateId();
  const currentTime = now();

  db.prepare(`
    INSERT INTO tasks (
      id, name, prompt, type,
      cron_expression, interval_seconds,
      next_run_at, priority, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    taskId,
    options.name || null,
    prompt,
    type,
    cronExpression || null,
    intervalSeconds || null,
    nextRunAt,
    priority,
    currentTime,
    currentTime
  );

  console.log(`\nTask created: ${taskId}`);
  console.log(`  Type: ${type}`);
  console.log(`  Priority: ${priority}`);
  console.log(`  Next run: ${formatTime(nextRunAt)} (${getRelativeTime(nextRunAt)})`);

  if (cronExpression) {
    console.log(`  Schedule: ${describeCron(cronExpression)}`);
  }
  console.log();
}

function cmdRemove(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  // Support partial ID match
  const task = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ?
  `).get(taskId + '%');

  if (!task) {
    console.error(`Error: Task not found: ${taskId}`);
    return;
  }

  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  console.log(`Removed task: ${task.id}`);
}

function cmdDone(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  // Support partial ID match
  const task = db.prepare(`
    SELECT * FROM tasks WHERE id LIKE ?
  `).get(taskId + '%');

  if (!task) {
    console.error(`Error: Task not found: ${taskId}`);
    return;
  }

  const currentTime = now();

  // Update task status
  db.prepare(`
    UPDATE tasks
    SET status = 'completed', last_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(currentTime, currentTime, task.id);

  // Update history entry
  const historyEntry = db.prepare(`
    SELECT id, executed_at FROM task_history
    WHERE task_id = ? AND status = 'started'
    ORDER BY executed_at DESC LIMIT 1
  `).get(task.id);

  if (historyEntry) {
    const durationMs = (currentTime - historyEntry.executed_at) * 1000;
    db.prepare(`
      UPDATE task_history
      SET status = 'success', completed_at = ?, duration_ms = ?
      WHERE id = ?
    `).run(currentTime, durationMs, historyEntry.id);
  }

  console.log(`Completed task: ${task.id}`);

  // If recurring/interval, scheduler will handle next run
  if (task.type !== 'one-time') {
    console.log('(Scheduler will calculate next run time)');
  }

  // Special handling: if pre-compact task completed, create auto-compact task
  if (task.name === 'pre-compact') {
    const compactTaskId = generateId();
    db.prepare(`
      INSERT INTO tasks (id, name, prompt, type, priority, status, next_run_at, created_at, updated_at, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      compactTaskId,
      'auto-compact',
      '/compact',
      'one-time',
      1,  // highest priority
      'pending',
      currentTime,  // run immediately when idle
      currentTime,
      currentTime,
      'Asia/Shanghai'
    );
    console.log(`Created auto-compact task: ${compactTaskId}`);
  }
}

function cmdPause(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const task = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? AND status = 'pending'
  `).get(taskId + '%');

  if (!task) {
    console.error(`Error: Pending task not found: ${taskId}`);
    return;
  }

  db.prepare(`
    UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?
  `).run(now(), task.id);

  console.log(`Paused task: ${task.id}`);
}

function cmdResume(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const task = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? AND status = 'paused'
  `).get(taskId + '%');

  if (!task) {
    console.error(`Error: Paused task not found: ${taskId}`);
    return;
  }

  db.prepare(`
    UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?
  `).run(now(), task.id);

  console.log(`Resumed task: ${task.id}`);
}

function cmdStatus() {
  const status = getStatus();

  console.log('\n  Claude Status:');
  console.log(`    State: ${status.state}`);
  console.log(`    Idle: ${status.idleSeconds !== null ? status.idleSeconds + 's' : 'unknown'}`);
  console.log(`    Session: ${status.sessionExists ? 'exists' : 'not found'}`);

  // Show pending tasks count
  const pending = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'
  `).get();

  const running = db.prepare(`
    SELECT COUNT(*) as count FROM tasks WHERE status = 'running'
  `).get();

  console.log(`\n  Tasks:`);
  console.log(`    Pending: ${pending.count}`);
  console.log(`    Running: ${running.count}`);
  console.log();
}

function cmdHistory(taskId) {
  let query = `
    SELECT h.*, t.name, t.prompt
    FROM task_history h
    JOIN tasks t ON h.task_id = t.id
  `;
  let params = [];

  if (taskId) {
    query += ' WHERE h.task_id LIKE ?';
    params.push(taskId + '%');
  }

  query += ' ORDER BY h.executed_at DESC LIMIT 20';

  const history = db.prepare(query).all(...params);

  if (history.length === 0) {
    console.log('No execution history.');
    return;
  }

  console.log('\n  Execution History:\n');
  console.log('  Time                | Task ID        | Status  | Duration');
  console.log('  ' + '-'.repeat(65));

  for (const entry of history) {
    const time = formatTime(entry.executed_at).padEnd(18);
    const id = entry.task_id.substring(0, 14).padEnd(14);
    const status = entry.status.padEnd(7);
    const duration = entry.duration_ms ? `${Math.round(entry.duration_ms / 1000)}s` : '-';

    console.log(`  ${time} | ${id} | ${status} | ${duration}`);
  }
  console.log();
}

function cmdNext() {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    ORDER BY next_run_at ASC
    LIMIT 5
  `).all();

  if (tasks.length === 0) {
    console.log('No pending tasks.');
    return;
  }

  console.log('\n  Upcoming Tasks:\n');

  for (const task of tasks) {
    console.log(`  ${getRelativeTime(task.next_run_at).padEnd(12)} | P${task.priority} | ${task.name || task.prompt.substring(0, 40)}`);
  }
  console.log();
}

function cmdRunning() {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'running'
    ORDER BY updated_at ASC
  `).all();

  if (tasks.length === 0) {
    console.log('\n  No running tasks. Safe to compact.\n');
    return;
  }

  console.log('\n  ⚠️  Running Tasks (complete these before compacting!):\n');
  console.log('  ID              | Started            | Name');
  console.log('  ' + '-'.repeat(60));

  for (const task of tasks) {
    const id = task.id.substring(0, 14).padEnd(14);
    const started = formatTime(task.updated_at).padEnd(18);
    const name = task.name || task.prompt.substring(0, 30);

    console.log(`  ${id} | ${started} | ${name}`);
  }

  console.log('\n  Run "task-cli done <task-id>" to complete them before /compact\n');
}

// ===== Main =====

function main() {
  const { command, args, options } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'list':
      cmdList();
      break;
    case 'add':
      cmdAdd(args, options);
      break;
    case 'remove':
    case 'rm':
    case 'delete':
      cmdRemove(args[0]);
      break;
    case 'done':
    case 'complete':
      cmdDone(args[0]);
      break;
    case 'pause':
      cmdPause(args[0]);
      break;
    case 'resume':
      cmdResume(args[0]);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'history':
      cmdHistory(args[0]);
      break;
    case 'next':
      cmdNext();
      break;
    case 'running':
      cmdRunning();
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      if (command) {
        console.error(`Unknown command: ${command}`);
      }
      console.log(HELP);
  }
}

main();
