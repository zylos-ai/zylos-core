---
name: scheduler
description: Task scheduling system for autonomous operation. Core C5 component.
---

# Task Scheduler (C5)

Enables Claude to work autonomously by dispatching tasks when idle.

## Components

| File | Purpose |
|------|---------|
| `scheduler.js` | Main scheduler daemon |
| `task-cli.js` | CLI for task management |
| `activity.js` | Reads Claude's activity state |
| `db.js` | SQLite database operations |
| `cron.js` | Cron expression parser |
| `time-parser.js` | Natural language time parsing |

## How It Works

1. Activity Monitor writes state to `~/.claude-status`
2. Scheduler reads state and checks for pending tasks
3. When Claude is idle long enough, dispatches next task
4. Task sent to Claude via C4 comm-bridge

## Task CLI

```bash
# List tasks
~/.claude/skills/scheduler/task-cli.js list

# Add one-time task
~/.claude/skills/scheduler/task-cli.js add "Check emails" --priority 2

# Add recurring task
~/.claude/skills/scheduler/task-cli.js add "Health check" --cron "0 9 * * *"

# Mark task done
~/.claude/skills/scheduler/task-cli.js done <task-id>
```

## Priority Levels

| Priority | Type | Idle Buffer |
|----------|------|-------------|
| 1 | Urgent | 15 seconds |
| 2 | High | 30 seconds |
| 3 | Normal | 45 seconds |
| 4 | Low | 60 seconds |

## Database

SQLite at `~/zylos/scheduler/scheduler.db`

## Service Management

```bash
pm2 status scheduler
pm2 logs scheduler
pm2 restart scheduler
```
