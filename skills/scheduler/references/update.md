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
| `--require-idle` | Enable idle requirement |
| `--no-require-idle` | Disable idle requirement |
| `--reply-channel "<source>"` | Update reply channel |
| `--reply-endpoint "<endpoint>"` | Update reply endpoint |
| `--clear-reply` | Clear reply configuration |
| `--miss-threshold <seconds>` | Update miss threshold |

When the schedule is changed, the timezone column is automatically synced to the current configured TZ.

## Examples

```bash
# Update priority
cli.js update task-abc --priority 1

# Change schedule
cli.js update task-abc --cron "0 10 * * *"

# Enable idle requirement
cli.js update task-abc --require-idle

# Update reply
cli.js update task-abc --reply-channel "telegram" --reply-endpoint "new_id"

# Clear reply
cli.js update task-abc --clear-reply

# Switch from cron to interval
cli.js update task-abc --every "2 hours"
```
