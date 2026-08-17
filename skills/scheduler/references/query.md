# Query Commands

## list

`cli.js list [--json] [--reply-channel "<ch>"]`

Shows all active tasks (excluding completed one-time tasks; failed one-time tasks remain visible). Displays TZ header, sorted by priority then next run time.

- `--json` — machine-readable output: a JSON array of full task rows (untruncated `id`, `type`, `status`, `last_error`, `reply_channel`, `reply_endpoint`, `next_run_at`, and all other columns). Outputs `[]` when no tasks match.
- `--reply-channel "<ch>"` — only tasks whose reply channel equals `<ch>` exactly. Works with or without `--json`.

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
cli.js list --json
cli.js list --json --reply-channel multica
cli.js next
cli.js running
cli.js history
cli.js history task-abc
```
