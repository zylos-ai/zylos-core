---
name: scheduler
description: Use when user wants to schedule tasks for future, recurring, or interval execution. Manages one-time, cron, and interval tasks dispatched via C4 comm-bridge.
---

# Task Scheduler (C5)

Enables Claude to work autonomously by dispatching scheduled tasks via C4 comm-bridge.

## How It Works

1. Activity Monitor writes state to `~/zylos/activity-monitor/agent-status.json`
2. Scheduler checks for pending tasks that are due
3. If runtime is alive, dispatches task to C4 comm-bridge
4. C4 handles execution control (idle waiting, priority queueing)
5. Task sent to Claude based on priority and idle requirements

## CLI

`~/zylos/.claude/skills/scheduler/scripts/cli.js <command>`

| Command | Description | Reference |
|---------|-------------|-----------|
| `add <prompt> [options]` | Add a new task | `references/add.md` |
| `update <task-id> [options]` | Update an existing task | `references/update.md` |
| `list` / `next` / `running` / `history` | Query tasks | `references/query.md` |
| `done` / `remove` / `pause` / `resume` | Task lifecycle | `references/lifecycle.md` |

## Command Results

`add`, `update`, `done`, `remove`, `pause`, `resume`, and `history` support `--json`: success is `{"ok":true,"data":{...}}`; errors are `{"ok":false,"error":{"code":"...","message":"..."}}` with exit code 1. Without `--json`, existing text output and exit behavior are retained. `list --json` keeps its existing JSON-array format.

For periodic tasks, `update --at` / `--in` changes only the next run; the saved cadence and timezone remain intact. Its JSON result includes `nextRunOnly: true`. A failed one-time task can be re-enabled by updating it to a future time. Reply channel and endpoint must form a nonempty pair. See the command references for details.

## Timezone

Resolves TZ: `~/zylos/.env` > `process.env.TZ` > `UTC`. Times are parsed and displayed in configured timezone. DB stores UTC. See `references/config.md` for details.
