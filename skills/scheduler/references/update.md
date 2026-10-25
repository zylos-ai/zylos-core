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
| `--miss-threshold <seconds>` | Update miss threshold |

When the schedule is changed, the timezone column is automatically synced to the current configured TZ.

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

## Saved execution group

A changed reply target recomputes the saved component/group; omitted L selects the component's overall group, not the prior group. Supplying L requires `--reply-channel` in this same command. Explicit channels are checked read-only against installed component directories, without requiring `send.js`; rejection leaves the task unchanged. Endpoint-only edits reuse the existing channel and select its overall group. If there is no reply channel, an endpoint-only edit updates the endpoint and preserves the saved execution group. `--clear-reply` preserves the saved group, including an empty saved group; schedule/prompt/priority-only edits preserve it too. The editor's session never retargets an existing task.

Take exact channel/endpoint and group-local name from Core reply-via, mapping `--session-group` to `--reply-session-group`. For another chat, query `c4-db.js groups --match <text> --json` and use `componentName`/`sessionGroupName`. If not yet registered, use the component's `node scripts/session-group.js <endpoint>` (successful empty output means overall group; failure does not). Otherwise follow component documentation or have the user send a message and query again. Do not infer namespaces or guess L.
