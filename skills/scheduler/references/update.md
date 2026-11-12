# update

`cli.js update <task-id> [options]`

Updates an existing task. Supports partial ID matching.

## Options

All `add` timing options (`--in`, `--at`, `--cron`, `--every`) plus:

| Option | Description |
|--------|-------------|
| `--name "<name>"` | Update task name |
| `--prompt "<prompt>"` | Update task content |
| `--priority <1-3>` | Update priority |
| `--block-queue-until-idle` | Enable block-queue-until-idle behavior |
| `--no-block-queue-until-idle` | Disable block-queue-until-idle behavior |
| `--reply-channel "<source>"` | Update reply channel |
| `--reply-endpoint "<endpoint>"` | Update reply endpoint |
| `--reply-session-group "<L>"` | Target group-local name; requires explicit `--reply-channel` |
| `--clear-reply` | Clear reply configuration |
| `--clear-session-group` | Clear the saved execution group and keep the reply configuration; see [Clear the execution group](#clear-the-execution-group); cannot be combined with `--reply-channel`, `--reply-endpoint` or `--reply-session-group` |
| `--miss-threshold <seconds>` | Update miss threshold |
| `--json` | Print a single-line result; see [JSON results](#json-results) |

When the schedule is changed, the timezone column is automatically synced to the current configured TZ.

## Postpone a running task

Directly update its time with `--in`, `--at`, `--cron` or `--every`. The current execution is completed using the same history handling as `done`, and the task becomes `pending` at the requested future time. Recurring and interval tasks keep that requested next time rather than recalculating it as a completed run. Prompt/name-only updates leave the task running. A past time fails with `RESCHEDULE_NOT_FUTURE` without changing the task or history; a concurrent completion or timeout fails with `TASK_WRONG_STATUS` without resurrecting the execution. Do not follow a successful postponement with `done`.

## Re-enable a failed one-time task

Give a failed one-time task a new time (`--in`, `--at`, `--cron` or `--every`) that is in the future. The task returns to `pending`, its failure details are cleared, and the daemon dispatches it at the new time. A time that is not in the future is rejected with `RESCHEDULE_NOT_FUTURE` and nothing is written. An update without a new time leaves the task `failed`.

## Clear the execution group

`--clear-session-group` empties the saved execution group. Where the next run goes depends on the reply configuration:

- With a reply target, the next execution queries that endpoint and saves its group again. A missing script or empty answer selects the component overall group. A failed query uses the overall group for that run without saving it. The fixed `dashboard` + `origin` address executes in Origin without querying.
- Without a reply target, it goes to Origin.

To send a task to Origin, add `--clear-reply` as well. The task then has no reply target. Running a task in Origin while keeping an external reply target is not supported.

## JSON results

With `--json`, success prints `{"ok":true,"data":{"task":{...},"updatedFields":[...],"reenabled":false,"executionFinished":false}}`. `executionFinished` is true when a running execution was completed and rescheduled; `task.next_run_at` is the requested next time. Every failure prints `{"ok":false,"error":{"code":"...","message":"..."}}` and exits 1.

Use `--json` whenever you need to know the outcome. Without it, some validation errors still exit 0, so the exit code alone does not prove the update was applied.

Error codes: `INVALID_ARGS`, `TASK_NOT_FOUND`, `TASK_AMBIGUOUS` (`matches` lists the task IDs), `TASK_WRONG_STATUS`, `NO_UPDATES`, `RESCHEDULE_NOT_FUTURE`, `SESSION_GROUP_INVALID`, `SESSION_GROUP_TOO_LONG`, `SESSION_GROUP_QUERY_FAILED`, `DB_WRITE_FAILED`, `INTERNAL_ERROR`, and the timezone errors.

## Examples

```bash
# Update priority
cli.js update task-abc --priority 1

# Change schedule
cli.js update task-abc --cron "0 10 * * *"

# Enable idle requirement
cli.js update task-abc --block-queue-until-idle

# Update reply
cli.js update task-abc --reply-channel "telegram" --reply-endpoint "new_id"

# Clear reply
cli.js update task-abc --clear-reply

# Switch from cron to interval
cli.js update task-abc --every "2 hours"

# Re-enable a failed one-time task
cli.js update task-abc --in "30 minutes" --json

# Clear the execution group; the next run queries the reply target again
cli.js update task-abc --clear-session-group

# Send the task to Origin; it no longer has a reply target
cli.js update task-abc --clear-session-group --clear-reply
```

## Saved execution group

A changed reply target recomputes the saved component/group; omitted L queries the resulting reply endpoint. A missing query script or empty answer selects the component's overall group; query failure rejects the update with `SESSION_GROUP_QUERY_FAILED` and leaves every task field unchanged. Supplying L requires `--reply-channel` in this same command. Explicit channels are checked read-only against installed component directories, without requiring `send.js`; rejection leaves the task unchanged. Endpoint-only edits reuse the existing channel and query the new endpoint. The fixed `dashboard` + `origin` address saves no group, skips querying, and rejects explicit L with `INVALID_ARGS`. After merging the supplied reply fields with the existing route, channel and endpoint must both have values or both be NULL. An endpoint-only edit without an existing channel returns `INVALID_ARGS` and leaves every task field unchanged. `--clear-reply` clears both reply columns and preserves the saved group, including an empty saved group; schedule/prompt/priority-only edits preserve it too. The editor's session never retargets an existing task.

For target discovery and copying Core reply-via, see [Target group and replies](../SKILL.md#target-group-and-replies).
