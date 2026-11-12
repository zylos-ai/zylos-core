# Lifecycle Commands

All commands support partial task ID matching.

All commands accept `--json`. Success prints `{"ok":true,"data":{"task":{...}}}` (`remove` prints `{"ok":true,"data":{"id":"..."}}`). Every failure prints `{"ok":false,"error":{"code":"...","message":"..."}}` and exits 1. Without `--json`, some failures still exit 0, so use `--json` whenever you need to know the outcome.

`pause` on a task that is not pending and `resume` on a task that is not paused fail with `TASK_WRONG_STATUS`; `error.status` gives the current status.

## done

`cli.js done <task-id>`

Marks a task as completed. For recurring/interval tasks, the daemon will automatically calculate the next run time.

Completion and the current started history row are committed together. Repeating `done` on a completed task is harmless. A delayed `done` on a failed task or on a pending task with a previous completion returns `TASK_WRONG_STATUS`; it cannot overwrite a timeout or cancel the next run after postponement. To postpone running work, directly use `update` with a future time instead of `done` followed by `update`.

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
cli.js done task-abc
cli.js remove task-abc
cli.js pause task-abc
cli.js resume task-abc
cli.js pause task-abc --json
```
