# Lifecycle Commands

All commands support partial task ID matching.

## done

`cli.js done <task-id> --run-id <history-id>`

Completes only the exact active run. Get the run ID and ready-to-copy command from `cli.js running`. Late, duplicate, or mismatched run IDs fail without changing the task. For recurring/interval tasks, the daemon will automatically calculate the next run time.

Before upgrading from a version whose dispatched prompts did not include `--run-id`, run both cutover gates against each machine independently:

```bash
node scripts/run-id-cutover-check.js
cli.js running
```

The read-only cutover check exits non-zero when that machine's stored task prompts contain any static `cli.js done` or `scheduler done` instruction, even if it already contains `--run-id`. Remove those stored completion instructions before installation; never rewrite one with a fixed run ID, because run IDs are created per dispatch and a stored value will become stale. Do not reuse counts from another machine. Then wait until `cli.js running` reports no active tasks. An old in-flight prompt cannot be completed safely after the new CLI is installed because it has no exact run identity.

## remove

`cli.js remove <task-id>`

Permanently deletes a task and its history.

## pause

`cli.js pause <task-id>`

Pauses a pending task. Paused tasks are skipped by the daemon.

## resume

`cli.js resume <task-id>`

Resumes a paused task back to pending status.

```bash
cli.js done task-abc --run-id 42
cli.js remove task-abc
cli.js pause task-abc
cli.js resume task-abc
```
