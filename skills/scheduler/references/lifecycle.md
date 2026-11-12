# Lifecycle Commands

All commands support partial task ID matching and `--json`. With `--json`, success returns `{"ok":true,"data":{...}}`; errors return `{"ok":false,"error":{"code":"...","message":"..."}}` and exit 1. An unknown or ambiguous ID returns `TASK_NOT_FOUND` or `TASK_AMBIGUOUS` respectively; an omitted ID is `INVALID_ARGS`. `done`, `pause`, and `resume` put the resulting task in `data.task`; `remove` returns `data.id`. Without `--json`, the existing text output and exit behavior are retained.

## done

`cli.js done <task-id>`

Marks a task as completed. For recurring/interval tasks, the daemon will automatically calculate the next run time.

## remove

`cli.js remove <task-id>`

Permanently deletes a task and its history.

## pause

`cli.js pause <task-id>`

Pauses a pending task. Paused tasks are skipped by the daemon. A task in another status returns `TASK_WRONG_STATUS`; its JSON error includes the current `status`.

## resume

`cli.js resume <task-id>`

Resumes a paused task back to pending status. A task in another status returns `TASK_WRONG_STATUS`; its JSON error includes the current `status`.

```bash
cli.js done task-abc
cli.js remove task-abc
cli.js pause task-abc
cli.js resume task-abc
```
