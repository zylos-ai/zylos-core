#!/usr/bin/env node
/**
 * Task Management CLI
 * Command-line interface for task creation, monitoring, and control
 */

import { getDb, generateId, now } from './database.js';
import { getNextRun, isValidCron, describeCron, DEFAULT_TIMEZONE } from './cron-utils.js';
import { parseTime, parseDuration, formatTime, getRelativeTime } from './time-utils.js';

const db = getDb();

/** Escape special LIKE pattern characters in user input */
function escapeLike(str) {
  return str.replace(/[%_!]/g, '!$&');
}

const ALLOWED_UPDATE_COLUMNS = new Set([
  'name', 'prompt', 'priority', 'require_idle', 'reply_source', 'reply_endpoint',
  'miss_threshold', 'type', 'cron_expression', 'interval_seconds', 'next_run_at', 'updated_at'
]);

const HELP = `
Task CLI - Scheduler V2

Usage: ~/zylos/.claude/skills/scheduler/scripts/cli.js <command> [options]

Commands:
  list                    List all tasks
  add <prompt> [options]  Add a new task
  update <task-id> [options]  Update an existing task
  remove <task-id>        Remove a task
  done <task-id>          Mark task as completed
  pause <task-id>         Pause a task
  resume <task-id>        Resume a paused task
  history [task-id]       Show execution history
  next                    Show upcoming tasks
  running                 Show currently running tasks

Add Options:
  --in "<duration>"       One-time: run in X time (e.g., "30 minutes")
  --at "<time>"           One-time: run at specific time (e.g., "tomorrow 9am")
  --cron "<expression>"   Recurring: cron expression (e.g., "0 8 * * *")
  --every "<interval>"    Interval: repeat every X time (e.g., "2 hours")
  --priority <1-3>        Priority level (1=urgent, 2=high, 3=normal, default=3)
  --name "<name>"         Task name (optional)
  --require-idle          Wait for Claude to be idle before executing
  --reply-source "<source>"      Reply channel (e.g., "telegram", "lark")
  --reply-endpoint "<endpoint>"  Reply endpoint (e.g., "8101553026", "chat_id topic_id")
  --miss-threshold <seconds>  Skip if overdue by more than this (default=300)

Update Options (same as Add, plus):
  --prompt "<prompt>"     Update task content
  --no-require-idle       Disable idle requirement
  --clear-reply           Clear reply configuration

Examples:
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Say hello" --in "30 minutes"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Health check" --cron "0 8 * * *"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Check updates" --every "1 hour"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --priority 1
  ~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --require-idle
  ~/zylos/.claude/skills/scheduler/scripts/cli.js done task-abc123
`;

function parseArgs(args) {
  const result = { command: null, args: [], options: {} };

  if (args.length === 0) {
    return result;
  }

  result.command = args[0];

  // Boolean flags (no value required)
  const booleanFlags = new Set([
    'require-idle',
    'no-require-idle',
    'clear-reply'
  ]);

  let i = 1;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);

      // Check if this is a boolean flag
      if (booleanFlags.has(key)) {
        result.options[key] = true;
        i++;
      } else {
        // Regular flag with value
        const value = args[i + 1];
        result.options[key] = value;
        i += 2;
      }
    } else {
      result.args.push(arg);
      i++;
    }
  }

  return result;
}

// ===== Commands =====

function cmdList() {
  // Show all active tasks including failed ones (so user can see what timed out)
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
    console.log('Usage: cli.js add "<prompt>" [options]');
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

  const priority = options.priority ? parseInt(options.priority, 10) : 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    console.error('Error: Priority must be 1-3 (1=urgent, 2=high, 3=normal)');
    return;
  }

  // Parse require-idle flag
  const requireIdle = options['require-idle'] ? 1 : 0;

  // Parse reply-source and reply-endpoint
  const replySource = options['reply-source'] || null;
  const replyEndpoint = options['reply-endpoint'] || null;

  // Parse miss-threshold
  const missThreshold = options['miss-threshold']
    ? parseInt(options['miss-threshold'], 10)
    : 300;  // Default 5 minutes
  if (!Number.isInteger(missThreshold) || missThreshold < 0) {
    console.error('Error: miss-threshold must be a positive integer');
    return;
  }

  const taskId = generateId();
  const currentTime = now();

  db.prepare(`
    INSERT INTO tasks (
      id, name, prompt, type,
      cron_expression, interval_seconds,
      next_run_at, priority, status,
      require_idle, miss_threshold,
      reply_source, reply_endpoint,
      created_at, updated_at, timezone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    options.name || prompt.substring(0, 40),  // Default name to truncated prompt
    prompt,
    type,
    cronExpression || null,
    intervalSeconds || null,
    nextRunAt,
    priority,
    requireIdle,
    missThreshold,
    replySource,
    replyEndpoint,
    currentTime,
    currentTime,
    DEFAULT_TIMEZONE
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
  const tasks = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    console.error(`Error: Task not found: ${taskId}`);
    return;
  }

  if (tasks.length > 1) {
    console.error(`Error: Ambiguous task ID prefix '${taskId}' matches multiple tasks:`);
    tasks.forEach(t => console.error(`  - ${t.id}`));
    console.error('Please provide a more specific prefix.');
    return;
  }

  db.prepare('DELETE FROM tasks WHERE id = ?').run(tasks[0].id);
  console.log(`Removed task: ${tasks[0].id}`);
}

function cmdDone(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  // Support partial ID match
  const tasks = db.prepare(`
    SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    console.error(`Error: Task not found: ${taskId}`);
    return;
  }

  if (tasks.length > 1) {
    console.error(`Error: Ambiguous task ID prefix '${taskId}' matches multiple tasks:`);
    tasks.forEach(t => console.error(`  - ${t.id}`));
    console.error('Please provide a more specific prefix.');
    return;
  }

  const task = tasks[0];

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
}

function cmdPause(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const tasks = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!' AND status = 'pending'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    console.error(`Error: Pending task not found: ${taskId}`);
    return;
  }

  if (tasks.length > 1) {
    console.error(`Error: Ambiguous task ID prefix '${taskId}' matches multiple pending tasks:`);
    tasks.forEach(t => console.error(`  - ${t.id}`));
    console.error('Please provide a more specific prefix.');
    return;
  }

  db.prepare(`
    UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?
  `).run(now(), tasks[0].id);

  console.log(`Paused task: ${tasks[0].id}`);
}

function cmdResume(taskId) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  const tasks = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!' AND status = 'paused'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    console.error(`Error: Paused task not found: ${taskId}`);
    return;
  }

  if (tasks.length > 1) {
    console.error(`Error: Ambiguous task ID prefix '${taskId}' matches multiple paused tasks:`);
    tasks.forEach(t => console.error(`  - ${t.id}`));
    console.error('Please provide a more specific prefix.');
    return;
  }

  db.prepare(`
    UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?
  `).run(now(), tasks[0].id);

  console.log(`Resumed task: ${tasks[0].id}`);
}

function cmdHistory(taskId) {
  let query = `
    SELECT h.*, t.name, t.prompt
    FROM task_history h
    JOIN tasks t ON h.task_id = t.id
  `;
  let params = [];

  if (taskId) {
    query += ` WHERE h.task_id LIKE ? ESCAPE '!'`;
    params.push(escapeLike(taskId) + '%');
  }

  // Check for ambiguous task prefix before querying history
  if (taskId) {
    const matchingTasks = db.prepare(`
      SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!'
    `).all(escapeLike(taskId) + '%');

    if (matchingTasks.length > 1) {
      console.log(`\n  ⚠ Warning: Prefix '${taskId}' matches ${matchingTasks.length} tasks:`);
      matchingTasks.forEach(t => console.log(`    - ${t.id}`));
      console.log();
    }
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

  console.log('\n  Run "cli.js done <task-id>" to complete them before /compact\n');
}

function cmdUpdate(taskId, options) {
  if (!taskId) {
    console.error('Error: Task ID is required');
    return;
  }

  // Support partial ID match
  const tasks = db.prepare(`
    SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    console.error(`Error: Task not found: ${taskId}`);
    return;
  }

  if (tasks.length > 1) {
    console.error(`Error: Ambiguous task ID prefix '${taskId}' matches multiple tasks:`);
    tasks.forEach(t => console.error(`  - ${t.id}`));
    console.error('Please provide a more specific prefix.');
    return;
  }

  const task = tasks[0];
  const updates = {};
  const updatedFields = [];

  // Update name
  if (options.name) {
    updates.name = options.name;
    updatedFields.push('name');
  }

  // Update prompt
  if (options.prompt) {
    updates.prompt = options.prompt;
    updatedFields.push('prompt');
  }

  // Update priority
  if (options.priority) {
    const priority = parseInt(options.priority, 10);
    if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
      console.error('Error: Priority must be 1-3');
      return;
    }
    updates.priority = priority;
    updatedFields.push('priority');
  }

  // Update require_idle
  if (options['require-idle']) {
    updates.require_idle = 1;
    updatedFields.push('require_idle');
  } else if (options['no-require-idle']) {
    updates.require_idle = 0;
    updatedFields.push('require_idle');
  }

  // Update reply configuration
  if (options['clear-reply']) {
    updates.reply_source = null;
    updates.reply_endpoint = null;
    updatedFields.push('reply_source', 'reply_endpoint');
  } else {
    if (options['reply-source']) {
      updates.reply_source = options['reply-source'];
      updatedFields.push('reply_source');
    }
    if (options['reply-endpoint']) {
      updates.reply_endpoint = options['reply-endpoint'];
      updatedFields.push('reply_endpoint');
    }
  }

  // Update miss_threshold
  if (options['miss-threshold']) {
    const threshold = parseInt(options['miss-threshold'], 10);
    if (!Number.isInteger(threshold) || threshold < 0) {
      console.error('Error: miss-threshold must be a positive integer');
      return;
    }
    updates.miss_threshold = threshold;
    updatedFields.push('miss_threshold');
  }

  // Update schedule (type and next_run_at)
  let scheduleUpdated = false;
  if (options.in) {
    const seconds = parseDuration(options.in);
    if (!seconds) {
      console.error(`Error: Invalid duration "${options.in}"`);
      return;
    }
    updates.type = 'one-time';
    updates.cron_expression = null;
    updates.interval_seconds = null;
    updates.next_run_at = now() + seconds;
    scheduleUpdated = true;
  } else if (options.at) {
    const nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      console.error(`Error: Could not parse time "${options.at}"`);
      return;
    }
    updates.type = 'one-time';
    updates.cron_expression = null;
    updates.interval_seconds = null;
    updates.next_run_at = nextRunAt;
    scheduleUpdated = true;
  } else if (options.cron) {
    const cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      console.error(`Error: Invalid cron expression "${cronExpression}"`);
      return;
    }
    updates.type = 'recurring';
    updates.cron_expression = cronExpression;
    updates.interval_seconds = null;
    updates.next_run_at = getNextRun(cronExpression);
    scheduleUpdated = true;
  } else if (options.every) {
    const intervalSeconds = parseDuration(options.every);
    if (!intervalSeconds) {
      console.error(`Error: Invalid interval "${options.every}"`);
      return;
    }
    updates.type = 'interval';
    updates.cron_expression = null;
    updates.interval_seconds = intervalSeconds;
    updates.next_run_at = now() + intervalSeconds;
    scheduleUpdated = true;
  }

  if (scheduleUpdated) {
    updatedFields.push('type', 'schedule');
  }

  // Check if any updates were provided
  if (Object.keys(updates).length === 0) {
    console.error('Error: No updates provided');
    console.log('Use --help to see available options');
    return;
  }

  // Build UPDATE query (validate column names against whitelist)
  updates.updated_at = now();
  for (const key of Object.keys(updates)) {
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) {
      console.error(`Error: Invalid update field: ${key}`);
      return;
    }
  }
  const setClauses = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = Object.values(updates);

  db.prepare(`
    UPDATE tasks SET ${setClauses} WHERE id = ?
  `).run(...values, task.id);

  console.log(`\nTask updated: ${task.id}`);
  console.log(`  Updated fields: ${updatedFields.join(', ')}`);

  if (scheduleUpdated) {
    console.log(`  Type: ${updates.type}`);
    console.log(`  Next run: ${formatTime(updates.next_run_at)} (${getRelativeTime(updates.next_run_at)})`);
  }
  console.log();
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
    case 'update':
      cmdUpdate(args[0], options);
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
