# Query Commands

## list

`cli.js list`

Shows all active tasks (excluding completed one-time tasks). Displays TZ header, sorted by priority then next run time.

## next

`cli.js next`

Shows the 5 nearest pending tasks with relative time.

## running

`cli.js running`

Shows tasks currently in `running` status. Useful to check before session compaction.

## history

`cli.js history [task-id]`

Shows the 20 most recent execution history entries. Optionally filter by task ID (supports partial match).

```bash
cli.js list
cli.js next
cli.js running
cli.js history
cli.js history task-abc
```
