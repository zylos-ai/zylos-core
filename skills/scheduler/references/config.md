# Configuration

## Components

| File | Purpose |
|------|---------|
| `daemon.js` | Main scheduler daemon |
| `daemon-tasks.js` | Daemon task processing logic |
| `cli.js` | CLI for task management |
| `runtime.js` | Runtime monitor and IPC |
| `database.js` | SQLite persistence layer |
| `cron-utils.js` | Cron expression utilities |
| `time-utils.js` | Time parsing utilities |
| `tz.js` | Timezone loading and validation |

## Timezone

Resolution order:
1. `~/zylos/.env` (`TZ=...`)
2. External `process.env.TZ` (e.g., PM2 env block)
3. `UTC` only when both are unset

Example `.env`:
```bash
TZ=Asia/Shanghai
```

Behavior:
- Natural language times (`--at "tomorrow 9am"`) are parsed in configured timezone
- Cron expressions are evaluated in configured timezone
- CLI display uses configured timezone
- Database timestamps remain UTC Unix seconds
- If `TZ` is present but invalid, CLI/daemon exits with a clear error (fail-fast)

After changing timezone config:
```bash
pm2 restart scheduler
```

## Database

SQLite at `~/zylos/scheduler/scheduler.db`

## Priority Levels

| Priority | Type | Description |
|----------|------|-------------|
| 1 | Urgent | Highest priority, immediate execution |
| 2 | High | Important tasks, execute soon |
| 3 | Normal | Default priority, standard execution |

Priority only affects dispatch order, not idle waiting. Use `--require-idle` for idle control.

## Retry / Missed Task Behavior

Scheduler uses an implicit retry mechanism based on `miss_threshold` (default 300s), not an explicit retry counter:

1. Task reaches `next_run_at` but runtime is offline → task stays `pending`
2. Daemon retries dispatch every 5s while within the `miss_threshold` window
3. Runtime comes back online within window → task dispatched (late but successful)
4. Window expires → one-time tasks marked `failed`, recurring/interval skip to next schedule

The `retry_count` / `max_retries` columns in the database are reserved but unused. Adjust `--miss-threshold <seconds>` per task to control the retry window.

## Service Management

```bash
pm2 status scheduler
pm2 logs scheduler
pm2 restart scheduler
```
