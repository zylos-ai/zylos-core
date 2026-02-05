---
name: scheduler
description: Use when user wants to schedule tasks for future, recurring, or interval execution. Manages one-time, cron, and interval tasks dispatched via C4 comm-bridge.
---

# Task Scheduler (C5)

Enables Claude to work autonomously by dispatching scheduled tasks via C4 comm-bridge.

## Components

| File | Purpose |
|------|---------|
| `daemon.js` | Main scheduler daemon |
| `cli.js` | CLI for task management |
| `runtime.js` | Runtime monitor and IPC |
| `database.js` | SQLite persistence layer |
| `cron-utils.js` | Cron expression utilities |
| `time-utils.js` | Time parsing utilities |

## How It Works

1. Activity Monitor writes state to `~/.claude-status`
2. Scheduler checks for pending tasks that are due
3. If runtime is alive, dispatches task to C4 comm-bridge
4. C4 handles execution control (idle waiting, priority queueing)
5. Task sent to Claude based on priority and idle requirements

## Task CLI

### Commands

| Command | Description |
|---------|-------------|
| `list` | List all tasks |
| `add <prompt> [options]` | Add a new task |
| `update <task-id> [options]` | Update an existing task |
| `done <task-id>` | Mark task as completed |
| `remove <task-id>` | Remove a task |
| `pause <task-id>` | Pause a task |
| `resume <task-id>` | Resume a paused task |
| `next` | Show upcoming tasks |
| `running` | Show currently running tasks |
| `history [task-id]` | Show execution history |

### Add Options

| Option | Description |
|--------|-------------|
| `--in "<duration>"` | One-time: run in X time (e.g., "30 minutes", "2.5 hours", "1 hour 30 minutes") |
| `--at "<time>"` | One-time: run at specific time (e.g., "tomorrow 9am") |
| `--cron "<expression>"` | Recurring: cron expression (e.g., "0 8 * * *") |
| `--every "<interval>"` | Interval: repeat every X time (e.g., "2 hours", "90 minutes", "2h") |
| `--priority <1-3>` | Priority level (1=urgent, 2=high, 3=normal, default=3) |
| `--name "<name>"` | Task name (optional) |
| `--require-idle` | Wait for Claude to be idle before executing (pending C4 support) |
| `--reply-source "<source>"` | Reply channel (e.g., "telegram", "lark") |
| `--reply-endpoint "<endpoint>"` | Reply endpoint (e.g., "8101553026", "chat_id topic_id") |
| `--miss-threshold <seconds>` | Skip if overdue by more than this (default=300) |

### Update Options

All Add options, plus:

| Option | Description |
|--------|-------------|
| `--prompt "<prompt>"` | Update task content |
| `--no-require-idle` | Disable idle requirement |
| `--clear-reply` | Clear reply configuration |

**Duration formats** (`--in`, `--every`):
- Natural language: "30 minutes", "2 hours", "2.5 hours", "1 hour 30 minutes", "an hour"
- Short forms: "30m", "2h", "1d"
- Pure numbers: "7200" (seconds)

### Examples

```bash
# List tasks
~/zylos/.claude/skills/scheduler/scripts/cli.js list

# Add one-time task (run in 30 minutes)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Check emails" --in "30 minutes" --priority 2

# Add one-time task (run at specific time)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Send report" --at "tomorrow 9am"

# Add recurring task (cron)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Health check" --cron "0 9 * * *"

# Add interval task (repeat every 2 hours)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Check updates" --every "2 hours"

# Add interval task (flexible formats)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Check updates" --every "90 minutes"
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Check updates" --every "2.5 hours"

# Mark task done
~/zylos/.claude/skills/scheduler/scripts/cli.js done <task-id>

# View execution history (all tasks)
~/zylos/.claude/skills/scheduler/scripts/cli.js history

# View execution history for specific task
~/zylos/.claude/skills/scheduler/scripts/cli.js history <task-id>

# Show upcoming tasks
~/zylos/.claude/skills/scheduler/scripts/cli.js next

# Show currently running tasks
~/zylos/.claude/skills/scheduler/scripts/cli.js running

# Maintenance task (wait for idle)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Compact session" \
  --cron "0 2 * * *" --require-idle

# Task with reply (notify via Telegram)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Daily report" \
  --at "9am" --reply-source "telegram" --reply-endpoint "8101553026"

# Task with reply (notify to Lark topic)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Weekly report" \
  --cron "0 9 * * 1" --reply-source "lark" --reply-endpoint "chat_id topic_id"

# Task with custom miss threshold (backup: must execute even if delayed)
~/zylos/.claude/skills/scheduler/scripts/cli.js add "Backup data" \
  --cron "0 2 * * *" --miss-threshold 86400

# Update task priority
~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --priority 1

# Update task schedule
~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --cron "0 10 * * *"

# Enable idle requirement
~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --require-idle

# Update reply configuration
~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc \
  --reply-source "telegram" --reply-endpoint "new_id"

# Clear reply configuration
~/zylos/.claude/skills/scheduler/scripts/cli.js update task-abc --clear-reply
```

## Priority Levels

| Priority | Type | Description |
|----------|------|-------------|
| 1 | Urgent | Highest priority, immediate execution |
| 2 | High | Important tasks, execute soon |
| 3 | Normal | Default priority, standard execution |

**Note**: Priority only affects dispatch order, not idle waiting. Use `--require-idle` for idle control.

## Best Practices

### When to Use --require-idle

**Use for maintenance tasks**:
- Session compaction
- Data cleanup
- System health checks that need full attention

**Don't use for**:
- User notifications (should be immediate)
- Time-sensitive tasks
- High-priority alerts

### How to Set --miss-threshold

**Short threshold (use default 300s or less)**:
- Health checks / heartbeats - if missed, skip to next
- Real-time notifications - outdated notifications are useless
- Time-sensitive tasks

**Long threshold (specify explicitly)**:
- Data backups (`--miss-threshold 86400`) - must execute even if delayed
- Reports (`--miss-threshold 14400`) - valuable even if late
- Batch processing - not time-critical

**Default (5 minutes)**: Suitable for most tasks.

### Reply Configuration

Use `--reply-source` and `--reply-endpoint` together to specify where task results should be sent.

**Examples**:
```bash
# Telegram user
--reply-source "telegram" --reply-endpoint "8101553026"

# Lark topic (multiple parts separated by space)
--reply-source "lark" --reply-endpoint "chat_xxx topic_yyy"

# Broadcast (no endpoint)
--reply-source "telegram"
```

**Note**: Endpoint structure depends on the channel implementation. Endpoints can contain multiple space-separated values.

## Database

SQLite at `~/zylos/scheduler/scheduler.db`

## Service Management

```bash
pm2 status scheduler
pm2 logs scheduler
pm2 restart scheduler
```
