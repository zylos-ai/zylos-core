# add

`cli.js add <prompt> [options]`

Creates a new scheduled task. Exactly one timing option is required.

## Timing Options

| Option | Type | Example |
|--------|------|---------|
| `--in "<duration>"` | One-time | `--in "30 minutes"` |
| `--at "<time>"` | One-time | `--at "tomorrow 9am"` |
| `--cron "<expression>"` | Recurring | `--cron "0 9 * * *"` |
| `--every "<interval>"` | Interval | `--every "2 hours"` |

### Duration Formats (`--in`, `--every`)

- Natural language: "30 minutes", "2 hours", "2.5 hours", "1 hour 30 minutes", "an hour"
- Short forms: "30m", "2h", "1d"
- Pure numbers: "7200" (seconds)

## Other Options

| Option | Description | Default |
|--------|-------------|---------|
| `--priority <1-3>` | 1=urgent, 2=high, 3=normal | 3 |
| `--name "<name>"` | Task display name | Truncated prompt |
| `--block-queue-until-idle` | Wait for sustained idle, then block later dispatch until execution settles | off |
| `--miss-threshold <seconds>` | Skip if overdue by more than this | 300 |
| `--reply-channel "<source>"` | Reply channel (e.g., "telegram", "lark") | none |
| `--reply-endpoint "<endpoint>"` | Reply endpoint (e.g., user ID) | none |
| `--reply-session-group "<L>"` | Group-local name; requires explicit `--reply-channel` | component overall group |

## Examples

```bash
# One-time (delay)
cli.js add "Check emails" --in "30 minutes" --priority 2

# One-time (absolute time)
cli.js add "Send report" --at "tomorrow 9am"

# Recurring (cron)
cli.js add "Health check" --cron "0 9 * * *"

# Interval
cli.js add "Check updates" --every "2 hours"
cli.js add "Check updates" --every "90 minutes"

# Maintenance (wait for idle)
cli.js add "Compact session" --cron "0 2 * * *" --block-queue-until-idle

# With reply
cli.js add "Daily report" --at "9am" --reply-channel "telegram" --reply-endpoint "8101553026"
cli.js add "Weekly report" --cron "0 9 * * 1" --reply-channel "lark" --reply-endpoint "chat_id topic_id"

# Long miss threshold (backup: must execute even if delayed)
cli.js add "Backup data" --cron "0 2 * * *" --miss-threshold 86400
```

## Best Practices

### --block-queue-until-idle

Use for: session compaction, data cleanup, health checks needing full attention.
Don't use for: user notifications, time-sensitive tasks, high-priority alerts.

### --miss-threshold

- **Default 300s**: health checks, heartbeats, real-time notifications
- **Long (explicit)**: backups (`86400`), reports (`14400`), batch processing
- Default (5 min) is suitable for most tasks.

### Reply Configuration

`--reply-channel` and `--reply-endpoint` specify where results are sent.

```bash
--reply-channel "telegram" --reply-endpoint "8101553026"     # Telegram user
--reply-channel "lark" --reply-endpoint "chat_xxx topic_yyy" # Lark topic
--reply-channel "telegram"                                    # Overall component group; no reply endpoint
```

Endpoint structure depends on channel implementation. Can contain multiple space-separated values.

### Saving the execution group

An explicit `--reply-channel X` must name an installed component directory (no `send.js` requirement). It stores X and optional `--reply-session-group L` without allocating a namespace. This target takes precedence over the creating session. Without X, creation uses only `ZYLOS_SESSION_GROUP`: a known namespace is reverse-mapped read-only; origin or no variable saves no group. Unknown namespaces and malformed groups fail without creating a task. A target need not already have messages.

Copy channel/endpoint from Core reply-via and rename its `--session-group L` option to `--reply-session-group L`. For another chat use `c4-db.js groups --match <text> --json`, selecting `componentName` and `sessionGroupName`; do not split the full namespace yourself. For a new chat use the component's `node scripts/session-group.js <endpoint>`; successful empty output means the overall group, while failure must not be treated as empty. If unavailable, follow component docs or ask for a message in that chat and query again. Never guess L or reject a target solely because groups has no row. Wrong L can execute in a different context even when the reply endpoint is right.

```bash
cli.js add "Report to this group" --in "1 hour" --reply-channel telegram --reply-endpoint "-1001" --reply-session-group "g-1001"
```
