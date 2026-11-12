#!/usr/bin/env node
/**
 * Task Management CLI
 * Command-line interface for task creation, monitoring, and control
 */

import { getDb, generateId, now } from './database.js';
import { getNextRun, isValidCron, describeCron, getDefaultTimezone } from './cron-utils.js';
import { parseTime, parseDuration, formatTime, getRelativeTime } from './time-utils.js';
import { loadTimezone } from './tz.js';
import { resolveSavedSessionGroup, updatedReplyTarget } from './saved-session-group.js';

let db;

function reject(code, message, extra = {}, textExitCode = 0, textHint) {
  throw Object.assign(new Error(message), { code, extra, textExitCode, textHint, text: `Error: ${message}` });
}

function fail(error) {
  const code = error.code?.startsWith('SQLITE_') ? 'DB_WRITE_FAILED' : error.code ?? 'INTERNAL_ERROR';
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: false, error: { code, message: error.message, ...error.extra } }));
    process.exitCode = 1;
  } else {
    console.error(error.text ?? `Error: ${code}: ${error.message}`);
    if (error.textHint) console.log(error.textHint);
    // Converted validation returns keep their original text-mode exit status.
    process.exitCode = error.textExitCode ?? 1;
  }
}

function success(data) {
  console.log(JSON.stringify({ ok: true, data }));
}

/** Escape special LIKE pattern characters in user input */
function escapeLike(str) {
  return str.replace(/[%_!]/g, '!$&');
}

const ALLOWED_UPDATE_COLUMNS = new Set([
  'name', 'prompt', 'priority', 'require_idle', 'reply_channel', 'reply_endpoint', 'session_component', 'session_group_name',
  'miss_threshold', 'type', 'cron_expression', 'interval_seconds', 'next_run_at', 'timezone', 'updated_at',
  'status', 'failed_at', 'last_error'
]);

const HELP = `
Task CLI - Scheduler V2

Usage: ~/zylos/.claude/skills/scheduler/scripts/cli.js <command> [options]

Commands:
  list [options]          List all tasks
  add <prompt> [options]  Add a new task
  update <task-id> [options]  Update an existing task
  remove <task-id>        Remove a task
  done <task-id>          Compatibility no-op; deliveries finish automatically
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
  --reply-session-group "<L>"    Group-local name (requires --reply-channel)
  --reply-endpoint "<endpoint>"  Reply endpoint (e.g., "8101553026", "chat_id topic_id")
  --miss-threshold <seconds>  Skip if overdue by more than this (default=300)

Update Options (same as Add, plus):
  --prompt "<prompt>"     Update task content
  --no-block-queue-until-idle
                          Disable block-queue-until-idle behavior
                          Legacy alias: --no-require-idle
  --clear-reply           Clear reply configuration
  --clear-session-group   Clear the execution group, keeping reply configuration;
                          with a reply target, the next run queries its execution group

Update timing:
  --in / --at             Change only the next run of recurring/interval tasks; cadence and timezone stay unchanged
  --cron / --every        Replace the recurring schedule/type

Write Options (add/update/remove/pause/resume/done):
  --json                  Single-line success/error envelope; JSON errors exit 1

History Options:
  --json                  Rows without prompt, plus ambiguousPrefix task IDs
  --limit <1-1000>        Maximum history rows (default=20)

Examples:
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Say hello" --in "30 minutes"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Health check" --cron "0 8 * * *"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js add "Check updates" --every "1 hour"
  ~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --priority 1
  ~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --block-queue-until-idle
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
    'block-queue-until-idle',
    'no-block-queue-until-idle',
    'require-idle',
    'no-require-idle',
    'clear-reply',
    'clear-session-group',
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

function cmdAdd(args, options) {
  const prompt = args.join(' ');

  if (!prompt) {
    reject('INVALID_ARGS', 'Prompt is required', {}, 0, 'Usage: cli.js add "<prompt>" [options]');
  }

  let type, nextRunAt, cronExpression, intervalSeconds;

  // Determine task type from options
  if (options.in) {
    type = 'one-time';
    const seconds = parseDuration(options.in);
    if (!seconds) {
      reject('INVALID_ARGS', `Invalid duration "${options.in}"`);
    }
    nextRunAt = now() + seconds;
  } else if (options.at) {
    type = 'one-time';
    nextRunAt = parseTime(options.at);
    if (!nextRunAt) {
      reject('INVALID_ARGS', `Could not parse time "${options.at}"`);
    }
  } else if (options.cron) {
    type = 'recurring';
    cronExpression = options.cron;
    if (!isValidCron(cronExpression)) {
      reject('INVALID_ARGS', `Invalid cron expression "${cronExpression}"`);
    }
    nextRunAt = getNextRun(cronExpression);
  } else if (options.every) {
    type = 'interval';
    intervalSeconds = parseDuration(options.every);
    if (!intervalSeconds) {
      reject('INVALID_ARGS', `Invalid interval "${options.every}"`);
    }
    nextRunAt = now() + intervalSeconds;
  } else {
    reject('INVALID_ARGS', 'Must specify timing (--in, --at, --cron, or --every)', {}, 0, HELP);
  }

  const priority = options.priority ? parseInt(options.priority, 10) : 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    reject('INVALID_ARGS', 'Priority must be 1-3 (1=urgent, 2=high, 3=normal)');
  }

  // Parse block-queue-until-idle flag (legacy alias: require-idle)
  const requireIdle = (options['block-queue-until-idle'] || options['require-idle']) ? 1 : 0;

  // Parse reply-channel and reply-endpoint
  const savedGroup = resolveSavedSessionGroup(options);
  const replyChannel = options['reply-channel'] ?? null;
  const replyEndpoint = options['reply-endpoint'] || null;

  // Parse miss-threshold
  const missThreshold = options['miss-threshold']
    ? parseInt(options['miss-threshold'], 10)
    : 300;  // Default 5 minutes
  if (!Number.isInteger(missThreshold) || missThreshold < 0) {
    reject('INVALID_ARGS', 'miss-threshold must be a positive integer');
  }

  const taskId = generateId();
  const currentTime = now();

  db.prepare(`
    INSERT INTO tasks (
      id, name, prompt, type,
      cron_expression, interval_seconds,
      next_run_at, priority, status,
      require_idle, miss_threshold,
      reply_channel, reply_endpoint, session_component, session_group_name,
      created_at, updated_at, timezone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    savedGroup.session_component,
    savedGroup.session_group_name,
    currentTime,
    currentTime,
    getDefaultTimezone()
  );

  if (options.json) return success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) });
  console.log(`\nTask created: ${taskId}`);
  console.log(`  Type: ${type}`);
  console.log(`  Priority: ${priority}`);
  console.log(`  Next run: ${formatTime(nextRunAt)} (${getRelativeTime(nextRunAt)})`);

  if (cronExpression) {
    console.log(`  Schedule: ${describeCron(cronExpression)}`);
  }
  console.log();
}

function cmdRemove(taskId, options) {
  if (!taskId) {
    reject('INVALID_ARGS', 'Task ID is required');
  }

  // Support partial ID match
  const tasks = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    reject('TASK_NOT_FOUND', `Task not found: ${taskId}`);
  }

  if (tasks.length > 1) {
    reject('TASK_AMBIGUOUS', `Ambiguous task ID prefix '${taskId}' matches multiple tasks:\n${tasks.map(t => `  - ${t.id}`).join('\n')}\nPlease provide a more specific prefix.`, { matches: tasks.map(t => t.id) });
  }

  db.prepare('DELETE FROM tasks WHERE id = ?').run(tasks[0].id);
  if (options.json) return success({ id: tasks[0].id });
  console.log(`Removed task: ${tasks[0].id}`);
}

function cmdDone(taskId, options) {
  if (!taskId) {
    reject('INVALID_ARGS', 'Task ID is required');
  }

  // Support partial ID match
  const tasks = db.prepare(`
    SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    reject('TASK_NOT_FOUND', `Task not found: ${taskId}`);
  }

  if (tasks.length > 1) {
    reject('TASK_AMBIGUOUS', `Ambiguous task ID prefix '${taskId}' matches multiple tasks:\n${tasks.map(t => `  - ${t.id}`).join('\n')}\nPlease provide a more specific prefix.`, { matches: tasks.map(t => t.id) });
  }

  const task = tasks[0];

  if (options.json) return success({ task, alreadyCompleted: true, reason: 'DELIVERY_COMPLETES_AUTOMATICALLY' });
  console.log(`任务送达时已自动结束，无需 done：${task.id}`);

}

function cmdPause(taskId, options) {
  if (!taskId) {
    reject('INVALID_ARGS', 'Task ID is required');
  }

  const tasks = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!' AND status = 'pending'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    const task = db.prepare("SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'").get(escapeLike(taskId) + '%');
    reject(task ? 'TASK_WRONG_STATUS' : 'TASK_NOT_FOUND', `Pending task not found: ${taskId}`, task ? { status: task.status } : {});
  }

  if (tasks.length > 1) {
    reject('TASK_AMBIGUOUS', `Ambiguous task ID prefix '${taskId}' matches multiple pending tasks:\n${tasks.map(t => `  - ${t.id}`).join('\n')}\nPlease provide a more specific prefix.`, { matches: tasks.map(t => t.id) });
  }

  db.prepare(`
    UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?
  `).run(now(), tasks[0].id);

  if (options.json) return success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(tasks[0].id) });
  console.log(`Paused task: ${tasks[0].id}`);
}

function cmdResume(taskId, options) {
  if (!taskId) {
    reject('INVALID_ARGS', 'Task ID is required');
  }

  const tasks = db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!' AND status = 'paused'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    const task = db.prepare("SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'").get(escapeLike(taskId) + '%');
    reject(task ? 'TASK_WRONG_STATUS' : 'TASK_NOT_FOUND', `Paused task not found: ${taskId}`, task ? { status: task.status } : {});
  }

  if (tasks.length > 1) {
    reject('TASK_AMBIGUOUS', `Ambiguous task ID prefix '${taskId}' matches multiple paused tasks:\n${tasks.map(t => `  - ${t.id}`).join('\n')}\nPlease provide a more specific prefix.`, { matches: tasks.map(t => t.id) });
  }

  db.prepare(`
    UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?
  `).run(now(), tasks[0].id);

  if (options.json) return success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(tasks[0].id) });
  console.log(`Resumed task: ${tasks[0].id}`);
}

function cmdHistory(taskId, options) {
  const limit = Object.hasOwn(options, 'limit') ? Number(options.limit) : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) reject('INVALID_ARGS', 'limit must be an integer from 1 to 1000', {}, 1);
  let query = `
    SELECT h.id, h.task_id, t.name, h.executed_at, h.completed_at, h.status, h.duration_ms, h.error
    FROM task_history h
    JOIN tasks t ON h.task_id = t.id
  `;
  let params = [];

  if (taskId) {
    query += ` WHERE h.task_id LIKE ? ESCAPE '!'`;
    params.push(escapeLike(taskId) + '%');
  }

  let ambiguousPrefix = [];
  // Check for ambiguous task prefix before querying history
  if (taskId) {
    const matchingTasks = db.prepare(`
      SELECT id FROM tasks WHERE id LIKE ? ESCAPE '!'
    `).all(escapeLike(taskId) + '%');

    if (matchingTasks.length > 1) {
      ambiguousPrefix = matchingTasks.map(task => task.id);
      if (!options.json) {
        console.log(`\n  ⚠ Warning: Prefix '${taskId}' matches ${matchingTasks.length} tasks:`);
        matchingTasks.forEach(t => console.log(`    - ${t.id}`));
        console.log();
      }
    }
  }

  query += ' ORDER BY h.executed_at DESC, h.id DESC LIMIT ?';
  params.push(limit);

  const history = db.prepare(query).all(...params);
  if (options.json) return success({ rows: history, ambiguousPrefix });

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
    console.log('\n  No deliveries in progress.\n');
    return;
  }

  console.log('\n  Deliveries in progress or awaiting confirmation:\n');
  console.log('  ID              | Started            | Name');
  console.log('  ' + '-'.repeat(60));

  for (const task of tasks) {
    const id = task.id.substring(0, 14).padEnd(14);
    const started = formatTime(task.updated_at).padEnd(18);
    const name = task.name || task.prompt.substring(0, 30);

    console.log(`  ${id} | ${started} | ${name}`);
  }

  console.log('\n  Delivery success is recorded automatically; done does not change these rows.\n');
}

function cmdUpdate(taskId, options) {
  if (!taskId) {
    reject('INVALID_ARGS', 'Task ID is required');
  }

  // Support partial ID match
  const tasks = db.prepare(`
    SELECT * FROM tasks WHERE id LIKE ? ESCAPE '!'
  `).all(escapeLike(taskId) + '%');

  if (tasks.length === 0) {
    reject('TASK_NOT_FOUND', `Task not found: ${taskId}`);
  }

  if (tasks.length > 1) {
    reject('TASK_AMBIGUOUS', `Ambiguous task ID prefix '${taskId}' matches multiple tasks:\n${tasks.map(t => `  - ${t.id}`).join('\n')}\nPlease provide a more specific prefix.`, { matches: tasks.map(t => t.id) });
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
      reject('INVALID_ARGS', 'Priority must be 1-3');
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

  if (options['clear-session-group'] && ['reply-channel', 'reply-endpoint', 'reply-session-group'].some(key => Object.hasOwn(options, key))) {
    reject('INVALID_ARGS', '--clear-session-group cannot be combined with reply target options', {}, 1);
  }
  const replyUpdates = options['clear-session-group']
    ? { session_component: null, session_group_name: null,
      ...(options['clear-reply'] ? updatedReplyTarget(task, options) : {}) }
    : updatedReplyTarget(task, options);
  Object.assign(updates, replyUpdates);
  updatedFields.push(...Object.keys(replyUpdates));

  // Update miss_threshold
  if (options['miss-threshold']) {
    const threshold = parseInt(options['miss-threshold'], 10);
    if (!Number.isInteger(threshold) || threshold < 0) {
      reject('INVALID_ARGS', 'miss-threshold must be a positive integer');
    }
    updates.miss_threshold = threshold;
    updatedFields.push('miss_threshold');
  }

  // A temporary time override preserves a periodic task's saved cadence and zone.
  const nextRunOnly = (task.type === 'recurring' || task.type === 'interval') && Boolean(options.in || options.at);
  // Update schedule (type and next_run_at)
  let scheduleUpdated = false;
  if (options.in) {
    const seconds = parseDuration(options.in);
    if (!seconds) {
      reject('INVALID_ARGS', `Invalid duration "${options.in}"`);
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
      reject('INVALID_ARGS', `Could not parse time "${options.at}"`);
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
      reject('INVALID_ARGS', `Invalid cron expression "${cronExpression}"`);
    }
    updates.type = 'recurring';
    updates.cron_expression = cronExpression;
    updates.interval_seconds = null;
    updates.next_run_at = getNextRun(cronExpression);
    scheduleUpdated = true;
  } else if (options.every) {
    const intervalSeconds = parseDuration(options.every);
    if (!intervalSeconds) {
      reject('INVALID_ARGS', `Invalid interval "${options.every}"`);
    }
    updates.type = 'interval';
    updates.cron_expression = null;
    updates.interval_seconds = intervalSeconds;
    updates.next_run_at = now() + intervalSeconds;
    scheduleUpdated = true;
  }

  if (scheduleUpdated) {
    if (!nextRunOnly) {
      updates.timezone = getDefaultTimezone();
      updatedFields.push('type');
    }
    updatedFields.push('schedule');
  }

  // Check if any updates were provided
  if (Object.keys(updates).length === 0) {
    reject('NO_UPDATES', 'No updates provided', {}, 0, 'Use --help to see available options');
  }

  const reenabled = task.status === 'failed' && task.type === 'one-time' && scheduleUpdated;
  if (reenabled) {
    if (updates.next_run_at <= now()) {
      reject('RESCHEDULE_NOT_FUTURE', 'Rescheduled time must be in the future', { nextRunAt: updates.next_run_at }, 1);
    }
    updates.status = 'pending';
    updates.failed_at = null;
    updates.last_error = null;
  }

  // Build UPDATE query (validate column names against whitelist)
  updates.updated_at = now();
  for (const key of Object.keys(updates)) {
    if (!ALLOWED_UPDATE_COLUMNS.has(key)) {
      reject('INTERNAL_ERROR', `Invalid update field: ${key}`);
    }
  }
  const setClauses = Object.keys(updates).map(key => `${key} = ?`).join(', ');
  const values = Object.values(updates);

  db.transaction(() => {
    if (reenabled && updates.next_run_at <= now()) {
      reject('RESCHEDULE_NOT_FUTURE', 'Rescheduled time must be in the future', { nextRunAt: updates.next_run_at }, 1);
    }
    db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(...values, task.id);
  }).immediate();

  if (options.json) return success({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id), updatedFields, reenabled, ...(nextRunOnly ? { nextRunOnly: true } : {}) });
  console.log(`\nTask updated: ${task.id}`);
  console.log(`  Updated fields: ${updatedFields.join(', ')}`);

  if (scheduleUpdated) {
    console.log(`  Type: ${updates.type || task.type}`);
    console.log(`  Next run: ${formatTime(updates.next_run_at)} (${getRelativeTime(updates.next_run_at)})`);
  }
  if (nextRunOnly) console.log('  Only the next run changed; recurring schedule and timezone unchanged');
  if (reenabled) console.log('  Re-enabled: pending');
  console.log();
}

// ===== Main =====

function main() {
  try {
    process.env.TZ = loadTimezone();
  } catch (error) {
    const code = error.code || 'UNKNOWN_TZ_ERROR';
    fail(Object.assign(error, { code, text: `Error [${code}]: ${error.message}` }));
    return;
  }

  const { command, args, options } = parseArgs(process.argv.slice(2));
  db = getDb();

  switch (command) {
    case 'list':
      cmdList(options);
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
      cmdRemove(args[0], options);
      break;
    case 'done':
    case 'complete':
      cmdDone(args[0], options);
      break;
    case 'pause':
      cmdPause(args[0], options);
      break;
    case 'resume':
      cmdResume(args[0], options);
      break;
    case 'history':
      cmdHistory(args[0], options);
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
        throw Object.assign(new Error(`Unknown command: ${command}`), { code: 'INVALID_ARGS', textExitCode: 0, textHint: HELP, text: `Unknown command: ${command}` });
      }
      console.log(HELP);
  }
}

try { main(); }
catch (error) {
  fail(error);
}
