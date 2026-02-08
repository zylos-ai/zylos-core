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
| `--require-idle` | Wait for Claude to be idle | off |
| `--miss-threshold <seconds>` | Skip if overdue by more than this | 300 |
| `--reply-channel "<source>"` | Reply channel (e.g., "telegram", "lark") | none |
| `--reply-endpoint "<endpoint>"` | Reply endpoint (e.g., user ID) | none |

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
cli.js add "Compact session" --cron "0 2 * * *" --require-idle

# With reply
cli.js add "Daily report" --at "9am" --reply-channel "telegram" --reply-endpoint "8101553026"
cli.js add "Weekly report" --cron "0 9 * * 1" --reply-channel "lark" --reply-endpoint "chat_id topic_id"

# Long miss threshold (backup: must execute even if delayed)
cli.js add "Backup data" --cron "0 2 * * *" --miss-threshold 86400
```

## Best Practices

### --require-idle

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
--reply-channel "telegram"                                    # Broadcast
```

Endpoint structure depends on channel implementation. Can contain multiple space-separated values.
