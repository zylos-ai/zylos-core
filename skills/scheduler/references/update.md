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
| `--clear-reply` | Clear reply configuration |
| `--miss-threshold <seconds>` | Update miss threshold |
| `--json` | Structured success or error result |

## Timing and Timezone

For recurring and interval tasks, `--at` / `--in` changes only `next_run_at`. The task keeps its type, cron expression or interval, and saved schedule timezone. The requested time is parsed in the current configured TZ. After that execution is completed, cron resumes at its next matching time in the saved timezone; intervals advance from execution time. Text output states that only the next run changed; JSON includes `nextRunOnly: true`.

`--cron` / `--every` replaces the task type and cadence, and syncs its saved timezone to the current configured TZ. One-time task timing and timezone behavior stays unchanged.

## Re-enable a Failed One-time Task

Update a failed one-time task with a future `--in`, `--at`, `--cron`, or `--every` time. It returns to pending and clears `last_error` and `failed_at`. If the resulting time is not in the future, `RESCHEDULE_NOT_FUTURE` is returned without writing any changes. Updating other fields without a new time leaves the task failed.

## Reply Configuration

Reply channel and endpoint must form a nonempty pair. Updates first merge supplied values with the saved reply values, then validate the result. You can change only the endpoint when a channel is already saved, for example. A missing partner or explicit empty value returns `INVALID_ARGS` without changing the task. `--clear-reply` clears both.

## Structured Result

With `--json`, updates return `{"ok":true,"data":{"task":{...}}}`; periodic `--at` / `--in` results also include `data.nextRunOnly: true`. Errors return `{"ok":false,"error":{"code":"...","message":"..."}}` and exit 1. Without it, the existing text output and exit behavior are retained.

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
```
