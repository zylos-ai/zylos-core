# Lifecycle Commands

All commands support partial task ID matching.

All commands accept `--json`. Success prints `{"ok":true,"data":{"task":{...}}}` (`remove` prints `{"ok":true,"data":{"id":"..."}}`). Every failure prints `{"ok":false,"error":{"code":"...","message":"..."}}` and exits 1. Without `--json`, some failures still exit 0, so use `--json` whenever you need to know the outcome.

`pause` on a task that is not pending and `resume` on a task that is not paused fail with `TASK_WRONG_STATUS`; `error.status` gives the current status.

## done

`cli.js done <task-id>`

Marks a task as completed. For recurring/interval tasks, the daemon will automatically calculate the next run time.

Completion and the current started history row are committed together. Repeating `done` on a completed task is harmless and exits 0. On a pending task with a previous completion, `done` exits 0 without writing anything: text output explains that the execution was already closed by rescheduling or timeout and shows the next run time; JSON adds `alreadyClosed: true`, `reason: "EXECUTION_ALREADY_CLOSED"` and `nextRunAt`. The task stays pending at its existing next time. If a one-time task timed out but the work has since finished, `done` marks it completed and exits 0; the timeout history remains recorded. To postpone running work, directly use `update` with a future time instead of `done` followed by `update`.

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
