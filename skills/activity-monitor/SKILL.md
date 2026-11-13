---
name: activity-monitor
description: Guardian service that monitors the active runtime agent's state and automatically restarts it if stopped. Use when checking agent liveness state or understanding the auto-restart mechanism.
user-invocable: false
---

# Activity Monitor Skill

PM2 guardian service that monitors the active runtime agent's (Claude or Codex) activity state and ensures it's always running.

## When to Use

This is a **PM2 service** (not directly invoked by Claude). It runs continuously in the background.

## What It Does

1. **Activity Monitoring**: Tracks the agent's busy/idle state every second
2. **Status File**: Writes `~/zylos/activity-monitor/agent-status.json` with current state (busy/idle, idle_seconds, health)
3. **Guardian Mode**: Automatically restarts the agent if it stops or crashes
4. **Maintenance Awareness**: Waits for restart/upgrade scripts to complete before starting the agent
5. **Recovery Liveness Detection**: Sends C4 heartbeat probes during recovery and after restarts; healthy sessions have no periodic primary heartbeat
6. **Health Check**: Periodically enqueues system health checks (PM2, disk, memory) via the C4 control queue
7. **Daily Upgrade**: Enqueues a Claude Code upgrade via the C4 control queue at 5:00 AM local time daily (disabled by default; enable with `zylos config set daily_upgrade_enabled true`)
8. **Context Monitoring**: Receives context usage data after every turn; triggers early memory sync and new-session handoff at thresholds read from `config.json` (`model_rotation_thresholds[engine][model]`) for the actual running model; defaults are 70% below 1M and 40% for 1M, with a shared 40% maximum for 1M

## Multi-session Reclaim Configuration

A multi-session agent may request release of its own run after verifying pending
work, writing its handoff and arranging external-wait wake-ups under the existing
reclaim rules. Use the installed absolute path to
`node ~/zylos/.claude/skills/activity-monitor/scripts/supervisor-request.js request-release --json`;
the command inherits its group and run identity and accepts no target override.
Acceptance records a group/run-scoped in-memory intent even during the current
turn; the supervisor waits for existing idle and active-subagent protection,
then normal Sync/reclaim, without hot TTL or capacity-eviction minimum idle.
New delivered conversations or controls before fencing cancel the intent.
Supervisor restart drops the intent; ordinary idle TTL remains the fallback. Keep the handoff and current run on rejection
or an unknown result. In uncertain conversations, leave release to idle TTL.

The supervisor reads these settings from `.zylos/config.json` in
the Zylos data directory, with valid environment values taking precedence:

| Config key | Environment variable | Default |
| --- | --- | --- |
| `session_hot_ttl_seconds` | [`ZYLOS_SESSION_HOT_TTL_SECONDS`](https://github.com/zylos-ai/zylos-core/blob/main/README.md#idle-reclaim-environment) | 1800 seconds |
| `session_evict_min_idle_seconds` | `ZYLOS_SESSION_EVICT_MIN_IDLE_SECONDS` | 300 seconds |
| `session_reclaim_defer_alert_count` | `ZYLOS_SESSION_RECLAIM_DEFER_ALERT_COUNT` | 4 requests |

Values must be positive safe integers. An invalid environment value falls back
to the config file; an invalid or missing config value falls back to the default.
Hot TTL refreshes on each Supervisor round. The deferral alert count is read
fresh when a deferral is requested. Dashboard's global idle-reclaim
setting accepts 5–1440 whole minutes and writes seconds through the existing
config lock; the next TTL check uses the saved value without a restart. Existing
positive second values remain valid. The page is read-only in single-session
mode or when the environment variable is present, and displays the effective
value (including fallback when that environment value is invalid). The environment
scope follows the [authoritative README rule](https://github.com/zylos-ai/zylos-core/blob/main/README.md#idle-reclaim-environment).
The eviction minimum remains a startup setting and requires a restart to change.

Both TTL and capacity eviction use the latest C4 message, runtime creation,
same-run reclaim cancellation reset, or session activity (hooks/transcript).
Missing or non-finite session activity is ignored. TTL waits for the configured
interval after that latest activity.

Every TTL reclaim, Origin included, is preceded by preparation controls bound
to the current run, each require-idle, with the ack suffix and a 5-minute ack
deadline. The first is always the pre-reclaim check. During this check, do not
send messages to anyone. Only work this session started that is still running
and whose result it needs (background command, Monitor, subagent or workflow)
can hold reclaim. A Memory Sync is not such work: the supervisor already waits
for it before reclaiming, so do not defer for it. Apply for a delay before
acknowledging the control:

```bash
node ~/zylos/.claude/skills/activity-monitor/scripts/supervisor-request.js defer-reclaim --reason "watching CI of my PR"
```

Confirm `ok:true`, then acknowledge. The command derives the session group and
run ID from the current environment and uses the existing supervisor socket.
It rejects missing preparation, a different run, an already-started reclaim,
a capacity check past its response deadline, or an upgrade/configuration restart.
An accepted request cancels this reclaim or eviction preparation and resets the
idle clock immediately. TTL and eviction ordering both use this reset; the group
must become idle for the configured eviction minimum before it can be selected
again. Consecutive request counts and reasons live only in memory; a supervisor
restart loses them.

Otherwise write the handoff from current records, leaving completed items out.
Waiting for people, reviews or decisions needs only that handoff: replies wake
the group. Create a wake-up only for a step of this session's own ongoing task
waiting on a system that will not message this group (such as its PR's CI).
First use scheduler `list --json` to reuse a pending task covering the same
check. Otherwise use scheduler `add` without a reply option and confirm
`ok:true`; it saves the session's own group (Origin saves none and runs in
Origin). Do not create tasks for other waits.
The PRE_RECLAIM Sync control follows when the group has unsummarized
conversations, then for Origin the Origin Sync control when Origin has a Sync
backlog, so Sync records the handoff and task the check left. Reclaim begins
only after every preparation control is terminal (`done`, `timeout` once the
ack deadline passes without an ack, `superseded`, `failed` or `cancelled`)
and the same run is idle; while any is still pending or running the group is
not reclaimed. If only some controls could be written, preparation restarts
from the check after the written ones terminate.

Once the same run is preparing for TTL reclaim, its own preparation activity
does not restart or cancel that preparation; a new C4 message still cancels it.
Completed preparation stays pending until the same run is idle, without restarting TTL or sending further preparation controls.
This behavior is unchanged when no deferral was requested. An accepted deferral
cancels the current preparation; after the fresh idle interval, the next check
starts a new preparation. Capacity eviction keeps its existing ordering by idle
time. Consecutive deferrals reaching the configured count send the owner one
alert with the group and each reason, without forcing reclaim. Dispatching a new
incoming message to the group clears the count and permits another alert after
another full sequence. Actual reclaim or a new run also clears the count.

Codex does not automatically start a new turn when a background task finishes.
After deferral resets the idle clock, the session returns at the next idle check
(by default, about 30 minutes later). If the next step depends on the background
result, record it in the handoff or arrange for the task itself to send a
completion message back.

Subagent events with `agent_id` are tracked separately for the current run and
session as `activeSubagents` and `lastSubagentActivityAt`. A started, unended
child blocks TTL and capacity eviction while its last event is less than one
hot TTL old; at the TTL boundary it stops blocking. Child events also advance
the reclaim activity clock, including the eviction minimum idle interval.
They never change the main agent's `state`, `idleSince`, `tools`, or
`lastActivityAt`, so require-idle delivery still uses only main-agent state.
During TTL preparation, child activity is masked just like the preparing
session's own activity: completed preparation is retained until children stop
being active and the main agent is idle, without further preparation controls.
Its cutoff remains available through the fence's final child-activity recheck
and is cleared when reclaim completes; ordinary recent child activity still
resets eligibility even if the child stops between observations.
Other reclaim reasons are unchanged. Codex facts use the same reader when
supplied, but current Codex hook subscriptions lack SubagentStart/Stop, so
complete native child lifecycle coverage is not available from that source.

Capacity eviction skips even idle sessions whose latest activity is less than
`session_evict_min_idle_seconds` ago. At the boundary they become eligible for
the existing LRU selection; if all are too recent, new groups wait in the queue.
This does not change the three-second busy/idle observation threshold.

Capacity eviction (a waiting group needs a slot) and memory-pressure reclaim
first send the same pre-reclaim check to the selected group: bound to the
current run, require-idle, with the ack suffix, but with a 60-second ack
deadline and no Sync control. No fence is written while that check is pending
or running. Once it is terminal, the group is evicted when the same run is
still idle; when the deadline passes first, eviction continues without waiting
for the answer. A new C4 message, a replaced run, or session or child activity
after the deadline abandons that group's eviction, and candidates are selected
again by the usual rules; the check's own activity up to its deadline is
ignored. Each selected group gets one check, and while it waits it counts
toward the slots being freed, so no further group is asked meanwhile. A
delivered but unanswered check holds the fence as in-flight work until C4
expires it at the same deadline.

An upgrade restart (`restart_all`) sends each running session listed in the
request, Origin included, its own check control before that session's fence:
the same narrow handoff and wake-up check, opening with the upgrade as the reason, bound to the
current run, require-idle, with the ack suffix and a 60-second ack deadline.
The check names any background work that will be interrupted so the next
session can rerun or check it; it offers no deferral. The restart begins once
the check is terminal or the deadline passes. New
activity does not cancel it, since the upgrade must restart every listed run.
Each run is asked once, including when a busy session cancels and the restart
begins again, and sessions do not wait for each other's answers. A run that
cannot be bound as a target gets no check, and missing reclaim dependencies
stop the restart before any check is sent.

In steady single-session mode an upgrade restart (`zylos upgrade`,
`upgrade-claude`, `restart-claude`) has no Supervisor step: the producer queues
the same check, opening with a single-session reason, and then `/exit`. Both
are priority 1 and require-idle; the check has the ack suffix and a 60-second
ack deadline. The dispatcher delivers the check first and `/exit` only once the
session is idle after the check's turn, or after the check expires unanswered
or undelivered at its deadline. Queued controls go before new messages, so
activity during the wait neither overtakes nor removes `/exit`. Each restart
request queues one check, and the producer returns as soon as both are queued.

A launch configuration change still sends a single control with its 5-minute
ack deadline and the `ready_for_config_reclaim` flow. Its text now carries the
same narrow handoff and wake-up check, with the configuration change as the
reason. Background work is recorded as interrupted, without deferral, before
the readiness submission.

## Status File Format

```json
{
  "state": "idle",
  "last_activity": 1738675200,
  "last_check": 1738675210,
  "last_check_human": "2026-02-04 20:30:10",
  "idle_seconds": 5,
  "inactive_seconds": 10,
  "source": "conv_file",
  "health": "ok"
}
```

- `state`: "busy" | "idle" | "stopped" | "offline"
- `idle_seconds`: Time since entering idle state (0 when busy)
- `source`: "conv_file" (reliable) | "tmux_activity" (fallback)
- `health`: "ok" | "unavailable" | "rate_limited" | "auth_failed" — current public health; legacy `recovering` / `down` states remain readable

## PM2 Management

```bash
# Start
pm2 start ~/zylos/.claude/skills/activity-monitor/scripts/activity-monitor.js --name activity-monitor

# Restart
pm2 restart activity-monitor

# View logs
pm2 logs activity-monitor

# Check status
pm2 list
```

## Guardian Behavior

- **Detection**: Checks if the agent is running every second
- **Restart Delay**: Waits 5 seconds of continuous "not running" before restarting
- **Maintenance Wait**: Detects restart/upgrade scripts and waits for completion
- **Recovery Prompt**: Sends catch-up message via C4 after restart

## How It Works

1. **Monitor Loop** (every 1s):
   - Check if tmux session exists
   - Check if agent process is running
   - Detect activity (conversation file mtime for Claude; tmux activity for Codex)
   - Calculate idle/busy state
   - Write status to ~/zylos/activity-monitor/agent-status.json

2. **Guardian Logic**:
   - If agent not running for 5+ seconds → restart
   - Wait for maintenance scripts to complete
   - Send recovery prompt via C4 after successful restart

3. **Activity Detection**:
   - Claude primary: Conversation file modification time (reliable)
   - Codex / fallback: tmux window activity
   - Threshold: 3 seconds without activity = idle

## Heartbeat Liveness Detection

The health engine uses the C4 control queue to verify runtime responsiveness during recovery. Healthy sessions do not receive periodic `primary` probes, and there is no heartbeat enable/interval setting. The internal maintenance timer still processes pending probe results and recovery scheduling.

### Recovery Probes

| Phase | Trigger | On Success | On Failure |
|-------|---------|------------|------------|
| `recovery` | Unavailable/recovering maintenance retry or user-message recovery | Return to `ok` | Apply existing rate-limit detection or recovery handling |
| `post_restart` | Restart notification or process-running signal after its grace period | Return to `ok` | Apply existing recovery handling |
| `down-check` | Legacy `down` state retry interval | Return to `ok` | Stay `down` and retry later |

Retries in unavailable/recovering use exponential backoff (1m, 5m, 25m, then 60m). Rate-limit cooldown expiry only clears the wait; a later recovery trigger verifies responsiveness. Failed or expired pending probes still run their existing failure handling, including API-error fast scanning while waiting.

Recovery and post-restart probes require end-to-end acknowledgement. The dispatcher retains confirmed-active busy auto-ack for other heartbeat phases; idle heartbeat auto-ack has been removed.

### Unhealthy Message Routing

When health is not `ok`, C4 intake still records incoming messages as delivered. The MessageRouter returns an immediate status response for the current message when replies are enabled; `--no-reply` messages are accepted silently. If the router IPC is unavailable, `c4-receive.js` falls back to the status file and follows the same delivered/current-message behavior.

## Health Check

The activity monitor periodically enqueues system health checks via the C4 control queue.

- **Enabled**: On by default. Disable with `zylos config set health_check_enabled false`
- **Interval**: Every 24 hours (86400 seconds)
- **Persisted state**: `~/zylos/activity-monitor/health-check-state.json` (survives restarts)
- **Priority**: 3 (normal)
- **Gated by target runtime health**: Allowed when the resolved Origin target runtime's health is missing or `ok`; unreadable or unhealthy state defers the check
- **Origin presence**: No running Origin session is required
- **Mode transition**: Deferred while a mode switch is in progress

The health check control message instructs Claude to:
1. Check PM2 services via the health-check skill's sanitized PM2 snapshot helper
2. Check disk space via `df -h`
3. Check memory via `free -m`
4. If issues are found, choose the designated owner or ops contact from memory, otherwise the usual collaborator
5. Log results to `~/zylos/logs/health.log`
6. Acknowledge the control message

Raw `pm2 jlist` output must never enter an agent/tool transcript because it
contains each process's inherited environment.

## Upgrade Check

The activity monitor runs `upgrade-check.js` once per local date at or after
06:00. `upgrade_check_enabled` defaults to `true`. It uses the resolved Origin
target runtime's missing-or-`ok` health and requires no Origin session. A mode
transition defers it; after recovery it catches up later that day. State is
persisted in `~/zylos/activity-monitor/upgrade-check-state.json`.

## Daily Upgrade

The activity monitor enqueues a daily Claude Code upgrade via the C4 control queue.

- **Enabled**: Off by default. Enable with `zylos config set daily_upgrade_enabled true`
- **Schedule**: At or after 5:00 AM local time; catches up later the same day
- **Timezone**: Loaded from `~/zylos/.env` `TZ` field, falls back to `process.env.TZ`, then `UTC`
- **Persisted state**: `~/zylos/activity-monitor/daily-upgrade-state.json` (tracks last upgrade date)
- **Priority**: 3 (normal)
- **Gated by target runtime**: Only for a resolved Claude target with missing or `ok` health; no Origin session is required
- **Mode transition**: Deferred while a mode switch is in progress
- **Gated by config**: Only enqueued when `daily_upgrade_enabled` is `true` in config
- **Once per day**: Checks local date to avoid duplicate enqueues

The control message instructs Claude to use the `upgrade-claude` skill, which handles idle detection, `/exit`, upgrade, and automatic restart.

## Context Monitoring

Event-driven context monitoring via Claude Code's statusLine feature, replacing the old hourly polling.

- **Mechanism**: `context-monitor.js` runs as a statusLine command — Claude Code pipes context data to it via stdin after every turn (zero turn cost)
- **Status file**: Writes `~/zylos/activity-monitor/statusline.json` with full context data (used_percentage, remaining_percentage, cost, session_id)
- **Two thresholds**:
  - **Early memory sync** at 80% of the configured threshold: Enqueues a prompt for Claude to run memory sync as a background task, so it completes well before the session switch. Only triggers when unsummarized conversation count exceeds the checkpoint threshold.
  - **New-session handoff** at the threshold configured via `model_rotation_thresholds[engine][model]` in `config.json`: Enqueues the new-session trigger. The actual session model and context window select the value, including group overrides. Missing values default to 70% below 1M and 40% for 1M; 1M values are capped at 40%. Legacy engine values migrate once to the corresponding native default model without losing the stored number. Priority 1, 5-minute cooldown.
- **Delivery**: Enqueues via C4 control queue with bypass_state — ensures the trigger reaches Claude even during long tasks
- **Two-stage design**: The trigger message instructs Claude to start the new-session handoff flow; the actual `/clear` is gated by block-queue-until-idle in the new-session skill's final step
- **Log**: `~/zylos/activity-monitor/context-monitor.log`

The early memory sync decouples memory sync from the session switch. Memory sync is also triggered by the new session's startup hook if unsummarized conversations exceed the threshold, so data is never lost.

## Daily Memory Commit

The activity monitor runs a daily git commit of the `memory/` directory.

- **Schedule**: 3:00 AM local time
- **Timezone**: Same as daily upgrade (from `~/zylos/.env` TZ)
- **Persisted state**: `~/zylos/activity-monitor/daily-memory-commit-state.json`
- **Script**: Calls `zylos-memory/scripts/daily-commit.js` directly (no C4, no Claude needed)
- **Once per day, also when it fails**: Date-based deduplication. A failed run is recorded for the day (`last_status: "failed"`, `last_error` truncated) and the next attempt is the next day, not the next round
- **Idempotent**: If no memory changes exist, the script skips the commit
- **Large files**: Files over 50 MB are left out of the commit (untracked ones stay untracked, later changes to tracked ones are not committed) and listed in the activity monitor log

## Timing Guarantees

Machine tasks use `SupervisorMachineTasks`:
- **Catch-up**: Upgrade check (06:00) and optional Claude upgrade (05:00) remain due later that local date until successfully recorded
- **Memory commit**: Runs only during the 03:00 hour, including during a mode transition; it does not catch up after that hour
- **Dedup**: Successful work records `last_date`; failed work remains eligible for retry
- **Persistence**: State files survive activity monitor restarts
- **Usage**: Account health, configured intervals and active hours govern sampling/alerts; Origin presence, idle state, input state and pending-work gates are not required. Mode transitions defer usage work

## Permission Auto-Approve

When Claude Code shows a permission prompt (PermissionRequest event), the `hook-auth-prompt.js` hook automatically sends an Enter keystroke to approve it.

**This is intentional by design.** Zylos operates in a full-delegation model where the machine's permissions are entirely granted to the AI agent. Auto-approving permission prompts is the expected behavior, not a security gap.

### How It Works

1. Claude Code fires a PermissionRequest hook when a tool call requires user approval
2. `hook-auth-prompt.js` logs the event to `hook-timing.log`
3. If `auto_approve_permission` is true (default), it enqueues a `[KEYSTROKE]Enter` control at priority 0 with bypass-state and 1-second delay
4. The C4 dispatcher delivers the Enter keystroke to the tmux session, auto-confirming the prompt

### Configuration

```bash
# Disable auto-approve (require manual confirmation)
zylos config set auto_approve_permission false

# Re-enable (default)
zylos config set auto_approve_permission true
```

Config key: `auto_approve_permission` in `~/.zylos/config.json` (default: `true`).

## Log File

Activity log: `~/zylos/activity-monitor/activity.log`
- Auto-truncates to 500 lines daily
- Logs state changes and guardian actions
