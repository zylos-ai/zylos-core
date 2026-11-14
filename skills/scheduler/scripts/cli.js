#!/usr/bin/env node
/**
 * Task Management CLI
 * Command-line interface for task creation, monitoring, and control
 */

import { getDb, generateId, now } from './database.js';
import { getNextRun, isValidCron, describeCron, getDefaultTimezone } from './cron-utils.js';
import { parseTime, parseDuration, formatTime, getRelativeTime } from './time-utils.js';
import { loadTimezone } from './tz.js';

let db;
let jsonOutput = false;
const has = (options, key) => Object.hasOwn(options, key);

function success(data) {
  if (!jsonOutput) return false;
  console.log(JSON.stringify({ ok: true, data }));
  return true;
}

function fail(code, message, details = {}, textLines = [], textExitCode = 0) {
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: false, error: { code, message, ...details } }));
    process.exitCode = 1;
  } else {
    console.error(`Error: ${message}`);
    for (const line of textLines) console.error(line);
    process.exitCode = textExitCode;
  }
}

function write(action) {
  try { return db.transaction(action)(); }
  catch (error) {
    error.code = 'DB_WRITE_FAILED';
    throw error;
  }
}

function replyPair(channel, endpoint) {
  return typeof channel === 'string' && channel.trim().length > 0
    && typeof endpoint === 'string' && endpoint.trim().length > 0;
}

function findTask(taskId, status) {
  if (!taskId) { fail('INVALID_ARGS', 'Task ID is required'); return null; }
  const suffix = status ? ' AND status = ?' : '';
  const params = [escapeLike(taskId) + '%', ...(suffix ? [status] : [])];
  const tasks = db.prepare(`SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'${suffix}`).all(...params);
  const qualifier = status === 'pending' ? 'Pending ' : status === 'paused' ? 'Paused ' : '';
  if (!tasks.length) {
    if (status) {
      const task = db.prepare("SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'").get(escapeLike(taskId) + '%');
      if (task) {
        fail('TASK_WRONG_STATUS', `${qualifier}task not found: ${taskId}`, { status: task.status });
        return null;
      }
    }
    fail('TASK_NOT_FOUND', `${status ? qualifier + 'task' : 'Task'} not found: ${taskId}`);
    return null;
  }
  if (tasks.length > 1) {
    const kind = status ? ` ${status}` : '';
    fail('TASK_AMBIGUOUS', `Ambiguous task ID prefix '${taskId}' matches multiple${kind} tasks:`,
      { matches: tasks.map(task => task.id) },
      [...tasks.map(task => `  - ${task.id}`), 'Please provide a more specific prefix.']);
    return null;
  }
  return tasks[0];
}

/** Escape special LIKE pattern characters in user input */
function escapeLike(str) {
  return str.replace(/[%_!]/g, '!$&');
}

/**
 * Turn a --name pattern into a GLOB pattern: "*" stays a wildcard, while
 * the other GLOB metacharacters ("?" and "[") match themselves literally.
 */
function nameToGlob(pattern) {
  return pattern.replace(/[?[]/g, '[$&]');
}

const ALLOWED_UPDATE_COLUMNS = new Set([
  'name', 'prompt', 'priority', 'require_idle', 'reply_channel', 'reply_endpoint',
  'miss_threshold', 'type', 'cron_expression', 'interval_seconds', 'next_run_at', 'timezone', 'updated_at',
  'status', 'last_error', 'failed_at'
]);

const HELP = `
Task CLI - Scheduler V2

Usage: ~/zylos/.claude/skills/scheduler/scripts/cli.js <command> [options]

Commands:
  list [options]          List all tasks
  info <task-id> [--json] Show one task in full (untruncated id and prompt)
  add <prompt> [options]  Add a new task
  update <task-id> [options]  Update an existing task
  remove <task-id>        Remove a task
  done <task-id>          Mark task as completed
  pause <task-id>         Pause a task
  resume <task-id>        Resume a paused task
  history [task-id]       Show execution history
  next                    Show upcoming tasks
  running                 Show currently running tasks

List Options:
  --json                  Machine-readable output: JSON array of full task rows
                          (untruncated id, type, status, last_error, reply_channel,
                          reply_endpoint, next_run_at, ...)
  --reply-channel "<ch>"  Only tasks with this reply channel (works with or without --json)
  --name "<pattern>"      Only tasks with this exact name; "*" matches any characters
                          (e.g. "digest-*"). Case-sensitive.

Info Options:
  --json                  Machine-readable output: the full task row as a JSON object.
                          Exits 1 when the task is not found or the ID prefix is ambiguous

Add Options:
  --in "<duration>"       One-time: run in X time (e.g., "30 minutes")
  --at "<time>"           One-time: run at specific time (e.g., "tomorrow 9am")
  --cron "<expression>"   Recurring: cron expression (e.g., "0 8 * * *")
  --every "<interval>"    Interval: repeat every X time (e.g., "2 hours")
  --priority <1-3>        Priority level (1=urgent, 2=high, 3=normal, default=3)
  --name "<name>"         Task name (optional)
  --block-queue-until-idle
                          Wait for sustained idle, then block subsequent dispatch until execution settles
                          Legacy alias: --require-idle
  --reply-channel "<source>"      Reply channel (e.g., "telegram", "lark")
  --reply-endpoint "<endpoint>"  Reply endpoint (e.g., "8101553026", "chat_id topic_id")
  --miss-threshold <seconds>  Skip if overdue by more than this (default=300)

Update Options (same as Add, plus):
  --prompt "<prompt>"     Update task content
  --no-block-queue-until-idle
                          Disable block-queue-until-idle behavior
                          Legacy alias: --no-require-idle
  --clear-reply           Clear reply configuration

Update timing:
  --in / --at             Change only the next run of recurring/interval tasks;
                          preserve cadence and saved timezone
  --cron / --every        Replace the schedule and use the current timezone

Write and History Options:
  --json                  Single-line success/error envelope; errors exit 1
  --limit <1-1000>        History maximum rows (default=20)

Examples:
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Say hello" --in "30 minutes"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Health check" --cron "0 8 * * *"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Check updates" --every "1 hour"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --priority 1
  ~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --block-queue-until-idle
  ~/zylos/.claude/skills/scheduler/scripts/cli.js done task-abc123
  ~/zylos/.claude/skills/scheduler/scripts/cli.js list --json --name "digest-*"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js info task-abc123 --json
`;

function parseArgs(args) {
  const result = { command: null, args: [], options: {} };

  if (args.length === 0) {
    return result;
  }

  result.command = args[0];

  // Boolean flags (no value required)
  const booleanFlags = new Set([
    'block-queue-until-idle',
    'no-block-queue-until-idle',
    'require-idle',
    'no-require-idle',
    'clear-reply',
    'json'
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

function cmdList(options = {}) {
  // An empty --name (e.g. an unset shell variable) must not widen the result to every task
  if ('name' in options && !options.name) {
    fail('INVALID_ARGS', '--name requires a non-empty pattern', {}, [], 1);
    return;
  }

  // Show all active tasks including failed ones (so user can see what timed out)
  let sql = `
    SELECT * FROM tasks
    WHERE (status != 'completed' OR type != 'one-time')
  `;
  const params = [];
  if (options['reply-channel']) {
    sql += ` AND reply_channel = ?`;
    params.push(options['reply-channel']);
  }
  if (options.name) {
    sql += ` AND name GLOB ?`;
    params.push(nameToGlob(options.name));
  }
  sql += ` ORDER BY priority ASC, next_run_at ASC`;
  const tasks = db.prepare(sql).all(...params);

  if (options.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  if (tasks.length === 0) {
    console.log('No tasks scheduled.');
    return;
  }

  console.log(`\n  Tasks (TZ: ${getDefaultTimezone()}):\n`);
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

function describeSchedule(task) {
  if (task.type === 'recurring') {
    const description = describeCron(task.cron_expression);
    return description === task.cron_expression
      ? `cron ${task.cron_expression}`
      : `${description} (cron ${task.cron_expression})`;
  }
  if (task.type === 'interval') {
    return `every ${task.interval_seconds}s`;
  }
  return 'one-time';
}

function cmdInfo(taskId, options = {}) {
  // Partial ID match; completed tasks stay visible here, unlike list
  const task = findTask(taskId);
  if (!task) {
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  const timeWithRelative = (timestamp) =>
    `${formatTime(timestamp)} (${getRelativeTime(timestamp)})`;
  const nextRun = task.status === 'completed' ? 'done' : timeWithRelative(task.next_run_at);
  const reply = task.reply_channel
    ? [task.reply_channel, task.reply_endpoint].filter(Boolean).join(' ')
    : 'none';

  console.log(`\n  Task ${task.id} (TZ: ${getDefaultTimezone()}):\n`);
  console.log(`  Name:           ${task.name}`);
  console.log(`  Status:         ${task.status}`);
  console.log(`  Type:           ${task.type}`);
  console.log(`  Schedule:       ${describeSchedule(task)}`);
  console.log(`  Priority:       ${task.priority}`);
  console.log(`  Next run:       ${nextRun}`);
  console.log(`  Last run:       ${task.last_run_at ? timeWithRelative(task.last_run_at) : 'never'}`);
  console.log(`  Block queue:    ${task.require_idle ? 'until idle' : 'no'}`);
  console.log(`  Miss threshold: ${task.miss_threshold}s`);
  console.log(`  Reply:          ${reply}`);
  if (task.last_error) {
    const failedAt = task.failed_at ? ` (${formatTime(task.failed_at)})` : '';
    console.log(`  Last error:     ${task.last_error}${failedAt}`);
  }
  console.log(`  Created:        ${formatTime(task.created_at)}`);
  console.log(`  Updated:        ${formatTime(task.updated_at)}`);
  console.log('\n  Prompt:');
  for (const line of task.prompt.split('\n')) {
    console.log(`    ${line}`);
  }
  console.log();
}

function cmdAdd(args, options) {
  const prompt = args.join(' ');

  if (!prompt) {
    fail('INVALID_ARGS', 'Prompt is required');
    if (!jsonOutput) console.log('Usage: cli.js add "<prompt>" [options]');
    return;
  }

  let type, nextRunAt, cronExpression, intervalSeconds;

  // Determine task type from options
  if (options.in) {
    type = 'one-time';
    const seconds = parseDuration(options.in);
    if (!seconds) {
      fail('INVALID_ARGS', `Invalid duration "${options.in}"`);
      return;
    }
    nextRunAt = now() + seconds;
  } else if (options.at) {
    type = 'one-time';
    nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      fail('INVALID_ARGS', `Could not parse time "${options.at}"`);
      return;
    }
  } else if (options.cron) {
    type = 'recurring';
    cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      fail('INVALID_ARGS', `Invalid cron expression "${cronExpression}"`);
      return;
    }
    nextRunAt = getNextRun(cronExpression);
  } else if (options.every) {
    type = 'interval';
    intervalSeconds = parseDuration(options.every);
    if (!intervalSeconds) {
      fail('INVALID_ARGS', `Invalid interval "${options.every}"`);
      return;
    }
    nextRunAt = now() + intervalSeconds;
  } else {
    fail('INVALID_ARGS', 'Must specify timing (--in, --at, --cron, or --every)');
    if (!jsonOutput) console.log(HELP);
    return;
  }

  const priority = options.priority ? parseInt(options.priority, 10) : 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    fail('INVALID_ARGS', 'Priority must be 1-3 (1=urgent, 2=high, 3=normal)');
    return;
  }

  // Parse block-queue-until-idle flag (legacy alias: require-idle)
  const requireIdle = (options['block-queue-until-idle'] || options['require-idle']) ? 1 : 0;

  // Parse reply-channel and reply-endpoint
  const replyChannel = options['reply-channel'] || null;
  const replyEndpoint = options['reply-endpoint'] || null;
  if ((has(options, 'reply-channel') || has(options, 'reply-endpoint')) && !replyPair(replyChannel, replyEndpoint)) {
    fail('INVALID_ARGS', '--reply-channel and --reply-endpoint must both be nonempty', {}, [], 1);
    return;
  }

  // Parse miss-threshold
  const missThreshold = options['miss-threshold']
    ? parseInt(options['miss-threshold'], 10)
    : 300;  // Default 5 minutes
  if (!Number.isInteger(missThreshold) || missThreshold < 0) {
    fail('INVALID_ARGS', 'miss-threshold must be a positive integer');
    return;
  }

  const taskId = generateId();
  const currentTime = now();

  write(() => db.prepare(`
    INSERT INTO tasks (
      id, name, prompt, type,
      cron_expression, interval_seconds,
      next_run_at, priority, status,
      require_idle, miss_threshold,
      reply_channel, reply_endpoint,
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
    replyChannel,
    replyEndpoint,
    currentTime,
    currentTime,
    getDefaultTimezone()
  ));

  if (success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) })) return;
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
  const task = findTask(taskId);
  if (!task) return;
  write(() => db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id));
  if (success({ id: task.id })) return;
  console.log(`Removed task: ${task.id}`);
}

function cmdDone(taskId) {
  const task = findTask(taskId);
  if (!task) return;
  const currentTime = now();
  write(() => {
    db.prepare(`UPDATE tasks SET status='completed',last_run_at=?,updated_at=? WHERE id=?`)
      .run(currentTime, currentTime, task.id);
    const historyEntry = db.prepare(`SELECT id,executed_at FROM task_history
      WHERE task_id=? AND status='started' ORDER BY executed_at DESC LIMIT 1`).get(task.id);
    if (historyEntry) {
      db.prepare(`UPDATE task_history SET status='success',completed_at=?,duration_ms=? WHERE id=?`)
        .run(currentTime, (currentTime - historyEntry.executed_at) * 1000, historyEntry.id);
    }
  });
  if (success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id) })) return;
  console.log(`Completed task: ${task.id}`);
  if (task.type !== 'one-time') console.log('(Scheduler will calculate next run time)');
}

function cmdPause(taskId) {
  const task = findTask(taskId, 'pending');
  if (!task) return;
  write(() => db.prepare("UPDATE tasks SET status='paused',updated_at=? WHERE id=?").run(now(), task.id));
  if (success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id) })) return;
  console.log(`Paused task: ${task.id}`);
}

function cmdResume(taskId) {
  const task = findTask(taskId, 'paused');
  if (!task) return;
  write(() => db.prepare("UPDATE tasks SET status='pending',updated_at=? WHERE id=?").run(now(), task.id));
  if (success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id) })) return;
  console.log(`Resumed task: ${task.id}`);
}

function cmdHistory(taskId, options) {
  const rawLimit = has(options, 'limit') ? options.limit : '20';
  const limit = typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    fail('INVALID_ARGS', '--limit must be an integer between 1 and 1000');
    process.exitCode = 1;
    return;
  }
  let ambiguousPrefix = [];

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
      ambiguousPrefix = matchingTasks.map(task => task.id);
      if (!jsonOutput) {
        console.log(`\n  ⚠ Warning: Prefix '${taskId}' matches ${matchingTasks.length} tasks:`);
        matchingTasks.forEach(t => console.log(`    - ${t.id}`));
        console.log();
      }
    }
  }

  query += ' ORDER BY h.executed_at DESC, h.id DESC LIMIT ?';
  params.push(limit);

  const history = db.prepare(query).all(...params);
  if (success({ rows: history.map(({ prompt, ...entry }) => entry), ambiguousPrefix })) return;

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
  const task = findTask(taskId);
  if (!task) return;
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
      fail('INVALID_ARGS', 'Priority must be 1-3');
      return;
    }
    updates.priority = priority;
    updatedFields.push('priority');
  }

  // Update require_idle (external flag renamed to block-queue-until-idle)
  if (options['block-queue-until-idle'] || options['require-idle']) {
    updates.require_idle = 1;
    updatedFields.push('require_idle');
  } else if (options['no-block-queue-until-idle'] || options['no-require-idle']) {
    updates.require_idle = 0;
    updatedFields.push('require_idle');
  }

  // Validate the merged reply address before writing any task fields.
  if (options['clear-reply']) {
    updates.reply_channel = null;
    updates.reply_endpoint = null;
    updatedFields.push('reply_channel', 'reply_endpoint');
  } else if (has(options, 'reply-channel') || has(options, 'reply-endpoint')) {
    const channel = has(options, 'reply-channel') ? options['reply-channel'] : task.reply_channel;
    const endpoint = has(options, 'reply-endpoint') ? options['reply-endpoint'] : task.reply_endpoint;
    if (!replyPair(channel, endpoint)) {
      fail('INVALID_ARGS', '--reply-channel and --reply-endpoint must both be nonempty', {}, [], 1);
      return;
    }
    if (has(options, 'reply-channel')) { updates.reply_channel = channel; updatedFields.push('reply_channel'); }
    if (has(options, 'reply-endpoint')) { updates.reply_endpoint = endpoint; updatedFields.push('reply_endpoint'); }
  }

  // Update miss_threshold
  if (options['miss-threshold']) {
    const threshold = parseInt(options['miss-threshold'], 10);
    if (!Number.isInteger(threshold) || threshold < 0) {
      fail('INVALID_ARGS', 'miss-threshold must be a positive integer');
      return;
    }
    updates.miss_threshold = threshold;
    updatedFields.push('miss_threshold');
  }

  // Update schedule (type and next_run_at)
  let scheduleUpdated = false;
  const nextRunOnly = ['recurring', 'interval'].includes(task.type) && Boolean(options.in || options.at);
  if (options.in) {
    const seconds = parseDuration(options.in);
    if (!seconds) {
      fail('INVALID_ARGS', `Invalid duration "${options.in}"`);
      return;
    }
    if (!nextRunOnly) {
      updates.type = 'one-time';
      updates.cron_expression = null;
      updates.interval_seconds = null;
    }
    updates.next_run_at = now() + seconds;
    scheduleUpdated = true;
  } else if (options.at) {
    const nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      fail('INVALID_ARGS', `Could not parse time "${options.at}"`);
      return;
    }
    if (!nextRunOnly) {
      updates.type = 'one-time';
      updates.cron_expression = null;
      updates.interval_seconds = null;
    }
    updates.next_run_at = nextRunAt;
    scheduleUpdated = true;
  } else if (options.cron) {
    const cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      fail('INVALID_ARGS', `Invalid cron expression "${cronExpression}"`);
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
      fail('INVALID_ARGS', `Invalid interval "${options.every}"`);
      return;
    }
    updates.type = 'interval';
    updates.cron_expression = null;
    updates.interval_seconds = intervalSeconds;
    updates.next_run_at = now() + intervalSeconds;
    scheduleUpdated = true;
  }

  if (scheduleUpdated) {
    if (!nextRunOnly) updates.timezone = getDefaultTimezone();
    updatedFields.push(...(nextRunOnly ? ['next_run_at'] : ['type', 'schedule']));
    if (task.type === 'one-time' && task.status === 'failed') {
      if (updates.next_run_at <= now()) {
        fail('RESCHEDULE_NOT_FUTURE', 'A failed task must be rescheduled to a future time', {}, [], 1);
        return;
      }
      updates.status = 'pending';
      updates.last_error = null;
      updates.failed_at = null;
    }
  }

  // Check if any updates were provided
  if (Object.keys(updates).length === 0) {
    fail('NO_UPDATES', 'No updates provided');
    if (!jsonOutput) console.log('Use --help to see available options');
    return;
  }

  // Build UPDATE query (validate column names against whitelist)
  updates.updated_at = now();
  for (const key of Object.keys(updates)) {
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) {
      fail('INVALID_ARGS', `Invalid update field: ${key}`);
      return;
    }
  }
  const setClauses = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = Object.values(updates);

  write(() => db.prepare(`
    UPDATE tasks SET ${setClauses} WHERE id = ?
  `).run(...values, task.id));
  if (success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),
    ...(nextRunOnly ? { nextRunOnly: true } : {}) })) return;

  console.log(`\nTask updated: ${task.id}`);
  console.log(`  Updated fields: ${updatedFields.join(', ')}`);

  if (scheduleUpdated) {
    console.log(`  Type: ${updates.type || task.type}`);
    if (nextRunOnly) console.log('  Only the next run changed; recurring schedule and timezone unchanged');
    console.log(`  Next run: ${formatTime(updates.next_run_at)} (${getRelativeTime(updates.next_run_at)})`);
  }
  console.log();
}

// ===== Main =====

function main() {
  const { command, args, options } = parseArgs(process.argv.slice(2));
  const jsonCommands = ['add', 'update', 'done', 'complete', 'remove', 'rm', 'delete', 'pause', 'resume', 'history'];
  jsonOutput = jsonCommands.includes(command) && process.argv.slice(2).includes('--json');
  try {
    process.env.TZ = loadTimezone();
  } catch (error) {
    const code = error.code || 'UNKNOWN_TZ_ERROR';
    if (jsonOutput) fail(code, error.message);
    else console.error(`Error [${code}]: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    if (jsonOutput) {
      for (const [key, value] of Object.entries(options)) {
        if (value === undefined || value === '') {
          fail('INVALID_ARGS', `Invalid or missing option: --${key}`);
          return;
        }
      }
    }
    db = getDb();
    switch (command) {
      case 'list': cmdList(options); break;
      case 'info':
      case 'get': cmdInfo(args[0], options); break;
      case 'add': cmdAdd(args, options); break;
      case 'update': cmdUpdate(args[0], options); break;
      case 'remove':
      case 'rm':
      case 'delete': cmdRemove(args[0]); break;
      case 'done':
      case 'complete': cmdDone(args[0]); break;
      case 'pause': cmdPause(args[0]); break;
      case 'resume': cmdResume(args[0]); break;
      case 'history': cmdHistory(args[0], options); break;
      case 'next': cmdNext(); break;
      case 'running': cmdRunning(); break;
      case 'help':
      case '--help':
      case '-h': console.log(HELP); break;
      default:
        if (jsonOutput) fail('INVALID_ARGS', command ? `Unknown command: ${command}` : 'Command is required');
        else {
          if (command) console.error(`Unknown command: ${command}`);
          console.log(HELP);
        }
    }
  } catch (error) {
    if (jsonOutput) fail(error.code === 'DB_WRITE_FAILED' ? error.code : 'INTERNAL_ERROR', error.message);
    else { console.error(`Error: ${error.message}`); process.exitCode = 1; }
  }
}

main();
