# Query Commands

## list

`cli.js list [--json] [--reply-channel "<ch>"] [--name "<pattern>"]`

Shows all active tasks (excluding completed one-time tasks; failed one-time tasks remain visible). Displays TZ header, sorted by priority then next run time.

- `--json` — machine-readable output: a JSON array of full task rows (untruncated `id`, `type`, `status`, `last_error`, `reply_channel`, `reply_endpoint`, `next_run_at`, and all other columns). Outputs `[]` when no tasks match.
- `--reply-channel "<ch>"` — only tasks whose reply channel equals `<ch>` exactly. Works with or without `--json`.
- `--name "<pattern>"` — only tasks whose name equals `<pattern>` exactly (case-sensitive). `*` matches any run of characters, so `"digest-*"` selects every name starting with `digest-`; no other character is special. Works with or without `--json` and combines with `--reply-channel`. An empty pattern is an error (exit 1) rather than a match-all.

## info

`cli.js info <task-id> [--json]` (alias: `get`)

Shows one task in full: untruncated id, schedule, status, last and next run, reply route, last error and the whole prompt. Accepts a partial task ID like the lifecycle commands. Unlike `list`, completed one-time tasks are shown too.

- `--json` — machine-readable output: the full task row as a JSON object (same fields as a `list --json` row).
- Exits 1 with an error on stderr, and prints nothing on stdout, when the task is not found, the ID prefix matches more than one task, or no ID is given.

## next

`cli.js next`

Shows the 5 nearest pending tasks with relative time.

## running

`cli.js running`

Shows tasks currently in `running` status. Useful to check before session compaction.

## history

`cli.js history [task-id] [--limit <1-1000>] [--json]`

Shows the 20 most recent execution history entries by default. `--limit` accepts integers from 1 through 1000; out-of-range or invalid values are rejected with exit code 1. Optionally filter by task ID (supports partial match).

With `--json`, returns `{"ok":true,"data":{"rows":[...],"ambiguousPrefix":[]}}`. History rows omit `prompt`. When a prefix matches several tasks, `data.ambiguousPrefix` contains their matching task IDs; otherwise it is an empty array. Matching tasks' histories remain in the result rather than selecting one task silently. Invalid arguments return a structured error with exit 1; without `--json`, the existing text format and exit behavior are retained.

```bash
cli.js list
cli.js list --json
cli.js list --json --reply-channel multica
cli.js list --json --name "lark-group-digest-*"
cli.js info task-abc
cli.js info task-abc --json
cli.js next
cli.js running
cli.js history
cli.js history task-abc
cli.js history task-abc --limit 50 --json
```
