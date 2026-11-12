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

Write commands (`add`, `update`, `done`, `remove`, `pause`, `resume`) and `history` accept `--json`. Use it whenever you need to know the outcome: without it, some validation errors still exit 0.

To re-enable a failed one-time task or clear a task's execution group, use `update`; see `references/update.md`.

For recurring and interval tasks, `update --at` or `--in` changes only the next run: the type, cron/interval and saved schedule timezone stay unchanged. After that run is marked `done`, cron resumes at its next matching time; an interval resumes from completion. The requested time is parsed in the current configured TZ. Use `--cron` or `--every` to replace the cadence or periodic type. One-time updates keep their existing behavior. Text output explicitly says only the next run changed; JSON includes `nextRunOnly: true`.

To postpone unfinished work when a task is already running, directly use `update --in`, `--at`, `--cron`, or `--every`. The new time must be in the future. This completes the current execution's history as success and puts the task back in pending at the requested time, including recurring and interval tasks. There is no separate `done` step. Updates that only change the prompt, name, or other fields leave the execution running.

A one-time task that runs past the timeout becomes failed and sends one timeout notification to its owning agent session, using the same session group and reply target as dispatch. Notification failure is logged without retrying or changing the failed task. Recurring and interval timeouts continue through the normal next-run calculation without notification.

## Timezone

Resolves TZ: `~/zylos/.env` > `process.env.TZ` > `UTC`. Times are parsed and displayed in configured timezone. DB stores UTC. See `references/config.md` for details.

## Target group and replies

Copy the channel and endpoint from the current Core-generated reply-via into `--reply-channel` and `--reply-endpoint`. Core reply-via no longer supplies a group name. Scheduler asks the reply component for the endpoint's group and saves it when adding or changing the reply target. A missing query script or an empty answer selects the component's overall group. A failed query rejects add/update with `SESSION_GROUP_QUERY_FAILED`, without creating or changing the task. The query is bounded to five seconds and 4 KiB of stdout.

If an explicit group-local name is already known, `--reply-session-group L` with `--reply-channel X` saves it without querying. Never pass a full namespaced group as L. For another chat, `c4-db.js groups --match <text> --json` provides `componentName` and `sessionGroupName`; a missing result does not forbid scheduling. Without an explicit reply target, creation uses only the current `ZYLOS_SESSION_GROUP` via a read-only namespace lookup; origin or no group leaves the saved target empty. No recent-message or tmux inference is used.

`--reply-channel` and `--reply-endpoint` must both have values or both be absent. Update merges supplied reply fields with the saved route before checking the pair; an endpoint-only edit queries the new endpoint using the existing channel. `--clear-reply` removes only the reply route, and ordinary field updates preserve the saved group. Keep task prompts self-contained.

The fixed reply address `dashboard` + `origin` always executes in Origin: no query, no saved group, and an explicit `--reply-session-group` is rejected with `INVALID_ARGS`. A task with neither reply address nor saved group also executes in Origin without a reply route.

On execution, a task with a reply address and both saved-group columns empty is queried and conditionally saved once. Existing saved overall groups are retained. If this query fails, the task still executes in the component's overall group for that run; this fallback is not saved, so the next run queries again. History records `SESSION_GROUP_QUERY_FAILED` as a warning (a successful task can retain that error field); bounded details go to scheduler logs. A later execution error takes precedence. A concurrent update is never overwritten; the claimed run keeps its original route and query result. Failed writeback is logged and does not stop dispatch.
