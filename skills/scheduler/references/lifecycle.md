# Lifecycle Commands

All commands support partial task ID matching.

All commands accept `--json`. Success prints `{"ok":true,"data":{"task":{...}}}` (`remove` prints `{"ok":true,"data":{"id":"..."}}`). Every failure prints `{"ok":false,"error":{"code":"...","message":"..."}}` and exits 1. Without `--json`, some failures still exit 0, so use `--json` whenever you need to know the outcome.

`pause` on a task that is not pending and `resume` on a task that is not paused fail with `TASK_WRONG_STATUS`; `error.status` gives the current status.

## done

`cli.js done <task-id>`

Compatibility no-op for old sessions and prompts. Successful delivery is recorded automatically when C4 acknowledges receipt, including a committed C receipt with a notification warning or an unknown U result confirmed by readback. This only means delivered, not that the agent finished the work. One-time tasks become completed; recurring/interval tasks are immediately scheduled again from the delivery time.

`done` exits 0 and prints “任务送达时已自动结束，无需 done”. With `--json`, it returns `{"ok":true,"data":{"task":{...},"alreadyCompleted":true,"reason":"DELIVERY_COMPLETES_AUTOMATICALLY"}}`. It never changes the task or history, including pending, paused, failed or unresolved delivery rows. Unknown or ambiguous IDs keep the normal validation errors.

There is no one-hour work timeout or scheduled timeout reminder. A receipt left unconfirmed for more than 180 seconds is settled at daemon startup or on a regular iteration as failed with `DELIVERY_RESULT_UNKNOWN`. That same occurrence is never resent and no reminder is sent. Periodic tasks resume at their next scheduled occurrence; one-time tasks stay failed and can be re-enabled. The 180-second limit is four times the 45-second receive bound, with time for readback and accounting; deliveries at or below the limit are untouched. If a periodic task cannot calculate its next run (for example, invalid stored cron or timezone), only that task becomes failed with the original reason in last_error. Its confirmed delivery history is retained, and other tasks continue. Old timeout history remains historical evidence, not a new delivery failure. Upgrade migration treats legacy running tasks as delivered once and closes their started histories. It marks tasks completed without npm dependencies or cron calculation, preserving saved timing fields. The installed daemon advances periodic tasks to their next future occurrence; it does not resend the migrated occurrence or catch up downtime cron slots, and intervals advance from daemon resumption. One-time tasks stay completed. This idempotent legacy compatibility rule differs from the bounded failure rule for new unknown receipts.

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
cli.js remove task-abc
cli.js pause task-abc
cli.js resume task-abc
cli.js pause task-abc --json
```
