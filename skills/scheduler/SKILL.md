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
4. A successful C4 receipt ends this delivery immediately: history becomes success, one-time tasks become completed, and recurring/interval tasks return to pending for the next occurrence. Success means delivered to C4, not that the agent has finished the work. Committed C receipts also count as delivered even when session notification fails; their warning is retained. Unknown U results count as success only after readback confirms receipt.

## CLI

`~/zylos/.claude/skills/scheduler/scripts/cli.js <command>`

| Command | Description | Reference |
|---------|-------------|-----------|
| `add <prompt> [options]` | Add a new task | `references/add.md` |
| `update <task-id> [options]` | Update an existing task | `references/update.md` |
| `list` / `next` / `running` / `history` | Query tasks | `references/query.md` |
| `done` / `remove` / `pause` / `resume` | Task lifecycle | `references/lifecycle.md` |

Write commands (`add`, `update`, `done`, `remove`, `pause`, `resume`) and `history` accept `--json`. Use it whenever you need to know the outcome: without it, some validation errors still exit 0.

To re-enable a failed one-time task or clear a task's execution group, use `update`; see `references/update.md`.

For recurring and interval tasks, `update --at` or `--in` changes only the next run: the type, cron/interval and saved schedule timezone stay unchanged. After that occurrence is delivered, cron resumes at its next matching time; an interval resumes from delivery time. The requested time is parsed in the current configured TZ. Use `--cron` or `--every` to replace the cadence or periodic type. One-time updates keep their existing behavior. Text output explicitly says only the next run changed; JSON includes `nextRunOnly: true`.

`done` is a compatibility no-op for old prompts: it exits 0 and returns `alreadyCompleted: true` with `--json`, without changing the task or history. Delivery messages no longer ask the agent to call it.

There is no work-completion timeout or timeout notification. `running` exists only while receipt is in progress or unconfirmed. At startup and every daemon iteration, an unconfirmed or interrupted delivery older than 180 seconds is closed as failed with `DELIVERY_RESULT_UNKNOWN`, without resending that occurrence or sending a reminder. This bound is four times the 45-second receive timeout, allowing readback/accounting to finish. The latest started history time defines delivery age (task update time is used only when no started row exists). A periodic task schedules its next occurrence; a one-time task remains visibly failed and can be re-enabled with `update`. On upgrade, legacy running tasks and their started histories are treated as delivered once: one-time tasks complete, periodic tasks resume their saved cadence.

## Timezone

Resolves TZ: `~/zylos/.env` > `process.env.TZ` > `UTC`. Times are parsed and displayed in configured timezone. DB stores UTC. See `references/config.md` for details.

## Target group and replies

Copy the channel and endpoint from the current Core-generated reply-via into `--reply-channel` and `--reply-endpoint`. Core reply-via no longer supplies a group name. Scheduler asks the reply component for the endpoint's group and saves it when adding or changing the reply target. A missing query script or an empty answer selects the component's overall group. A failed query rejects add/update with `SESSION_GROUP_QUERY_FAILED`, without creating or changing the task. The query is bounded to five seconds and 4 KiB of stdout.

If an explicit group-local name is already known, `--reply-session-group L` with `--reply-channel X` saves it without querying. Never pass a full namespaced group as L. For another chat, `c4-db.js groups --match <text> --json` provides `componentName` and `sessionGroupName`; a missing result does not forbid scheduling. Without an explicit reply target, creation uses only the current `ZYLOS_SESSION_GROUP` via a read-only namespace lookup; origin or no group leaves the saved target empty. No recent-message or tmux inference is used.

`--reply-channel` and `--reply-endpoint` must both have values or both be absent. Update merges supplied reply fields with the saved route before checking the pair; an endpoint-only edit queries the new endpoint using the existing channel. `--clear-reply` removes only the reply route, and ordinary field updates preserve the saved group. Keep task prompts self-contained.

The fixed reply address `dashboard` + `origin` always executes in Origin: no query, no saved group, and an explicit `--reply-session-group` is rejected with `INVALID_ARGS`. A task with neither reply address nor saved group also executes in Origin without a reply route.

On execution, a task with a reply address and both saved-group columns empty is queried and conditionally saved once. Existing saved overall groups are retained. If this query fails, the task still executes in the component's overall group for that run; this fallback is not saved, so the next run queries again. History records `SESSION_GROUP_QUERY_FAILED` as a warning (a successful task can retain that error field); bounded details go to scheduler logs. A later execution error takes precedence. A concurrent update is never overwritten; the claimed run keeps its original route and query result. Failed writeback is logged and does not stop dispatch.
