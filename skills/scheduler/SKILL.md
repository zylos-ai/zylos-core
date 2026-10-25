---
name: scheduler
description: Use when user wants to schedule tasks for future, recurring, or interval execution. Manages one-time, cron, and interval tasks dispatched via C4 comm-bridge.
---

# Task Scheduler (C5)

Enables Claude to work autonomously by dispatching scheduled tasks via C4 comm-bridge.

## How It Works

1. Scheduler checks for pending tasks that are due.
2. It submits them to C4 as Core scheduler messages, without reading session health or waiting for an online/idle session.
3. C4 handles execution control (target group, health gates, idle waiting and priority).
4. A queued task still needs the existing `done` completion call; queueing does not prove the work finished.

## CLI

`~/zylos/.claude/skills/scheduler/scripts/cli.js <command>`

| Command | Description | Reference |
|---------|-------------|-----------|
| `add <prompt> [options]` | Add a new task | `references/add.md` |
| `update <task-id> [options]` | Update an existing task | `references/update.md` |
| `list` / `next` / `running` / `history` | Query tasks | `references/query.md` |
| `done` / `remove` / `pause` / `resume` | Task lifecycle | `references/lifecycle.md` |

## Timezone

Resolves TZ: `~/zylos/.env` > `process.env.TZ` > `UTC`. Times are parsed and displayed in configured timezone. DB stores UTC. See `references/config.md` for details.

## Target group and replies

Copy the channel, endpoint and optional group-local name from the current Core-generated reply-via. Map c4-send's `--session-group L` to Scheduler's `--reply-session-group L`, together with `--reply-channel X`; do not pass Scheduler a full group as L. Explicit reply targets determine the saved execution group. Without a reply target, creation uses the current `ZYLOS_SESSION_GROUP` via a read-only namespace lookup; origin or no group leaves the saved target empty. No recent-message or tmux inference is used.

For another chat, run `c4-db.js groups --match <text> --json`; use `componentName` for `--reply-channel` and `sessionGroupName` for `--reply-session-group` (omit L for an overall component group). Do not split a namespace yourself. If the target has no messages, use the component's `node scripts/session-group.js <endpoint>`: successful empty output means its overall group; a failed command is not empty output. If the component has no such command, follow its documentation or ask the user to send a message in the target chat and query again. Do not guess; a missing groups result does not itself forbid scheduling.

Changing a reply target recalculates the saved group; provide the complete L again or it becomes the component's overall group. `--clear-reply` removes only the reply route, and ordinary field updates preserve the saved group. Incorrect L can execute in another group even when replies reach the intended endpoint, breaking context continuity. Keep task prompts self-contained.
