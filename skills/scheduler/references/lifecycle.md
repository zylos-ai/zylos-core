# Lifecycle Commands

All commands support partial task ID matching.

## done

`cli.js done <task-id>`

Marks a task as completed. For recurring/interval tasks, the daemon will automatically calculate the next run time.

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
```
