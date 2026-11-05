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

## Re-enable a failed one-time task

Give a failed one-time task a new time (`--in`, `--at`, `--cron` or `--every`) that is in the future. The task returns to `pending`, its failure details are cleared, and the daemon dispatches it at the new time. A time that is not in the future is rejected with `RESCHEDULE_NOT_FUTURE` and nothing is written. An update without a new time leaves the task `failed`.

## Clear the execution group

`--clear-session-group` empties the saved execution group. Where the next run goes depends on the reply configuration:

- With a reply target, it goes to the overall group of the reply channel, not to Origin. For example, a task saved as `telegram`/`g-1` with a Telegram reply target goes to the Telegram overall group.
- Without a reply target, it goes to Origin.

To send a task to Origin, add `--clear-reply` as well. The task then has no reply target. Running a task in Origin while keeping an external reply target is not supported.

## JSON results

With `--json`, success prints `{"ok":true,"data":{"task":{...},"updatedFields":[...],"reenabled":false}}`. Every failure prints `{"ok":false,"error":{"code":"...","message":"..."}}` and exits 1.

Use `--json` whenever you need to know the outcome. Without it, some validation errors still exit 0, so the exit code alone does not prove the update was applied.

Error codes: `INVALID_ARGS`, `TASK_NOT_FOUND`, `TASK_AMBIGUOUS` (`matches` lists the task IDs), `NO_UPDATES`, `RESCHEDULE_NOT_FUTURE`, `SESSION_GROUP_INVALID`, `SESSION_GROUP_TOO_LONG`, `DB_WRITE_FAILED`, `INTERNAL_ERROR`, and the timezone errors.

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

# Clear the execution group; with a reply target the task goes to that channel's overall group
cli.js update task-abc --clear-session-group

# Send the task to Origin; it no longer has a reply target
cli.js update task-abc --clear-session-group --clear-reply
```

## Saved execution group

A changed reply target recomputes the saved component/group; omitted L selects the component's overall group, not the prior group. Supplying L requires `--reply-channel` in this same command. Explicit channels are checked read-only against installed component directories, without requiring `send.js`; rejection leaves the task unchanged. Endpoint-only edits reuse the existing channel and select its overall group. After merging the supplied reply fields with the existing route, channel and endpoint must both have values or both be NULL. An endpoint-only edit without an existing channel returns `INVALID_ARGS` and leaves every task field unchanged. `--clear-reply` clears both reply columns and preserves the saved group, including an empty saved group; schedule/prompt/priority-only edits preserve it too. The editor's session never retargets an existing task.

For target discovery and copying Core reply-via, see [Target group and replies](../SKILL.md#target-group-and-replies).
