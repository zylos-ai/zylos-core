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

Shows deliveries currently in progress or awaiting receipt confirmation (`running`). Successful receipts end automatically; `done` does not settle unresolved deliveries. Unconfirmed receipts older than 180 seconds are marked delivery-failed without resending the occurrence; periodic tasks then resume their cadence.

## history

`cli.js history [task-id] [--limit <1-1000>] [--json]`

Shows the most recent delivery history entries (success means received by C4, not work completed), 20 by default. Optionally filter by task ID (supports partial match).

- `--limit` — maximum number of rows. A value outside 1–1000 is rejected.
- `--json` — prints `{"ok":true,"data":{"rows":[...],"ambiguousPrefix":[...]}}`. Rows do not include the task prompt. `ambiguousPrefix` lists the matching task IDs when a partial ID matches more than one task; otherwise it is empty.

```bash
cli.js list
cli.js list --json
cli.js list --json --reply-channel multica
cli.js next
cli.js running
cli.js history
cli.js history task-abc
cli.js history task-abc --json --limit 100
```
