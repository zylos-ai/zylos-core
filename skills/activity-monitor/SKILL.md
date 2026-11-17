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
4. **Recovery Liveness Detection**: Sends C4 heartbeat probes during recovery and after restarts; healthy sessions have no periodic primary heartbeat
5. **Health Check**: Periodically enqueues system health checks (PM2, disk, memory) via the C4 control queue
6. **Daily Upgrade**: Enqueues a Claude Code upgrade via the C4 control queue at 5:00 AM local time daily (disabled by default; enable with `zylos config set daily_upgrade_enabled true`)
7. **Context Monitoring**: Receives context usage data after every turn; triggers early memory sync and new-session handoff at thresholds read from `config.json` (`model_rotation_thresholds[engine][model]`) for the actual running model; defaults are 70% below 1M and 40% for 1M, with a shared 40% maximum for 1M

## Component startup context

For component authors adding session-start context, see
[Session-start context for components](references/session-start-shards.md).
Emitters have a fixed 5.5-second wait budget and affect startup ordering; refresh
context in the background and emit from a local cache.

## Multi-session Reclaim Configuration

A multi-session agent may request release of its own run when its conversation
reaches a natural stopping point, without a minimum idle period. In uncertain
conversations, leave release to idle TTL. Use the installed absolute path to
`node ~/zylos/.claude/skills/activity-monitor/scripts/supervisor-request.js request-release --json`
(expand `~/zylos` to the actual installation directory), inheriting
`ZYLOS_SESSION_GROUP` and `ZYLOS_RUN_ID`; never supply another group's identity.
An `ok:true` response registers a group/run-scoped in-memory intent, not a
completed release. Finish the current turn. Once the session is idle and no subagent or memory
sync is running, the supervisor follows the same steps as idle reclaim: it
sends the pre-reclaim check prompt, runs a memory sync if there are
unsummarized conversations, then reclaims the session.
New delivered work before fencing cancels the intent. Supervisor restart drops
the intent; ordinary idle TTL remains the fallback. On rejection or an unknown
result, keep the current run; do not exit or assume release succeeded.

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
deadline. The first is always the pre-reclaim check: a one-line control that
names the idle reclaim check in
[Reclaim and restart checks](references/session-checks.md), which holds what
the session does during every reclaim and restart check. Only that idle check
offers a deferral (`supervisor-request.js defer-reclaim`). The command derives
the session group and run ID from the current environment and uses the
existing supervisor socket.
It rejects missing preparation, a different run, an already-started reclaim,
a capacity check past its response deadline, or an upgrade/configuration restart.
An accepted request cancels this reclaim or eviction preparation and resets the
idle clock immediately. TTL and eviction ordering both use this reset; the group
must become idle for the configured eviction minimum before it can be selected
again. Consecutive request counts and reasons live only in memory; a supervisor
restart loses them.

A wake-up the check creates with scheduler `add` saves the session's own group
(Origin saves none and runs in Origin).
The PRE_RECLAIM Sync control follows when the group has unsummarized
conversations, then for Origin the Origin Sync control when Origin has a Sync
backlog, so Sync records the handoff and task the check left. Reclaim begins
only after every preparation control is terminal (`done`, `timeout` once the
ack deadline passes without an ack, `superseded`, `failed` or `cancelled`)
and the same run is idle; while any is still pending or running the group is
not reclaimed. If only some controls could be written, preparation restarts
from the check after the written ones terminate.
Pre-reclaim Group and Origin Sync controls have a 15-minute acknowledgement
deadline. Ordinary periodic Group Sync retains its five-minute deadline;
periodic Origin Sync remains without a deadline.

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
Child hook `transcript_path` is not treated as proof of an independent child
transcript; no additional child transcript scanner changes reclaim activity.
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
the [upgrade restart check](references/session-checks.md), opening with the upgrade as the reason, bound to the
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
the single-session upgrade restart check, opening with a single-session reason, and then `/exit`. Both
are priority 1 and require-idle; the check has the ack suffix and a 60-second
ack deadline. The dispatcher delivers the check first and `/exit` only once the
session is idle after the check's turn, or after the check expires unanswered
or undelivered at its deadline. Queued controls go before new messages, so
activity during the wait neither overtakes nor removes `/exit`. Each restart
request queues one check, and the producer returns as soon as both are queued.

A launch configuration change still sends a single control with its 5-minute
ack deadline and the `ready_for_config_reclaim` flow. It names the
configuration restart check, with the configuration change as the reason. Background work is recorded as interrupted, without deferral, before
the readiness submission.

## No-response Recovery

Applies in both multi-session and single-session mode.

In both session modes, an actually pasted conversation arms no-response
observation from its paste time. Single-session mode includes an instance
without a configured `session_mode`. Any actual AI work after that paste disarms
this observation permanently; it does not reset a silence timer. This applies
even when the work belongs to an older turn and the new message remains queued.
Claude and Codex use the same rule. There is no dequeue, processed-input,
start/Stop or completion correlation.

Actual AI work is the validated current-run/session `lastResponseAt` fact:
main/child pre-tool hooks, real Claude assistant text, thinking or tool_use,
and Codex assistant output or function/custom-tool calls after matching rollout
session identity. Prompt hooks, user rows, queue-operation/queued_command
records, transcript mtime, Stop/idle, natural tool completion and child
start/stop alone do not disarm or postpone observation. Synthetic/error and
metadata output do not prove a response.

If no actual AI work occurs for 15 minutes after the first unanswered paste,
supervisor uses the same Escape → successful enqueue → 500 ms → exact
`continue` helper as Dashboard. Active tools receive no exemption. Each enqueue
rechecks identity, fences, transitions, shutdown, manual actions and paste
ownership; the interval holds no admission lock. Escape's Stop/idle,
interruption write, tool completion and the continue prompt do not suppress
continuation or count as recovery.

After successful continue enqueue, only actual AI work ends the 180-second
recovery wait and disarms observation. With none, the same scene is stopped.
A newer paste retains the unanswered silence anchor, retry cooldown and active
recovery deadline; it can invalidate an in-flight pair's remaining enqueue
without restarting the 15-minute wait. Failed nudges retry after 60 seconds;
blocked admission emits no attempted-nudge event. Superseded and uncertain
attempts are logged. A session mode change clears active recovery; the new
mode cannot stop the scene on that stale deadline. A changed run or
session cannot inherit a stale recovery action.

Health notification remains immediate, before lifecycle delivery, with the
original payload. The already-accepted run metadata supplies the optional
current-session timestamp: an older paste remains tracked for the five-second
screen check but does not arm no-response recovery. Session changes do not
silently discard delivery or its screen check. Background tasks alone never
arm detection; a new unanswered paste during background waiting does.

Single-session mode uses the same rule, thresholds and actual-AI-work
definition, with these additions:

- **Maintenance holds.** While a mode transition is open, a manual restart is
  pending, a `*` or `origin` drain fence exists, the global Memory Sync marker
  is held, or a `/exit` or `/clear` control (rotation, runtime upgrade or
  restart) queued less than 15 minutes ago is unfinished, no nudge or stop is
  sent and active recovery is cleared. Silence is measured again from the end
  of the hold. Each enqueue and the stop recheck these holds. An unreadable
  hold source holds recovery and is logged once.
- **Health recovery ownership.** Before an episode starts, runtime health other
  than `ok` or a recovery probe in flight holds observation the same way.
  Once an episode has started, it owns the run until actual AI work or its
  stop: recovery probes skip that run, and the unfenced single-session auth
  stop waits. A new run starts without recovery state.

Once actual AI work disarms observation, a later stall is outside this rule.
The existing tool watchdog covers only enabled Claude WebFetch/WebSearch:
while runtime health is `ok`, a still-tracked tool reaching its configured
timeout (default 3600 seconds) is nudged, then stopped if the same tool remains
past its configured grace (default 15 seconds), subject to recovery admission
gates. Other tools and Codex have no matching tool watchdog by default. The
existing screen path samples once per delivered message after five seconds;
persistent API-error text requires at least two delivery-triggered checks
spanning 30 seconds to stop, while rate-limit/auth matches use their existing
health validation. Recovery probes act on unhealthy/recovering runtime state,
not as a periodic healthy-session stall detector. Without matching tool,
screen or health evidence, a later API/tool hang has no universal automatic
fallback in this PR. A new paste can arm a new no-response observation.

Transcript parsing reads at most 256 KiB per sample in 64 KiB chunks, carries
at most 1 MiB of a line and retains at most 256 recent tool-result IDs,
including idle gaps before delayed native hooks. Assistant response metadata
is parsed even without an active tool. Unread bytes defer decisions until sampled; a truncated EOF line does
not prevent recovery forever. Oversized/malformed records do not establish
work. Main busy/idle fields and child reclaim semantics remain separate.

Before any AI response disarms observation, this rule includes legitimate
foreground calls silent for 15 minutes; existing
hooks/transcripts cannot distinguish every healthy long call from a hang.
Codex busy Enter accepts steering before pending input is processed. Native
exec yield/poll windows do not impose a 600-second process lifetime, and stdout
streaming does not universally persist transcript activity.

Web timeout also uses the shared nudge helper, preserving configured grace
(default 15 seconds), cooldown and stop fallback while the same tool remains.
New pastes can invalidate an in-flight pair but do not reset that tool's grace
or cooldown. If the tracked tool disappears, its watchdog episode ends; a
different tool starts a new episode with its own grace and cooldown. Web Escape
does not establish an AI response. Active no-response recovery
owns the scene while its pair or grace is pending, suppressing secondary screen
recovery and the tool watchdog. No-response recovery takes precedence when both
detectors are due. Four event
reasons (`no_response_nudge`, `no_response_restart`, `tool_timeout_nudge`,
`tool_timeout_restart`) include session group, run ID and observed silence.
Enqueue success does not prove runtime delivery; failure does not prove that
no partial write occurred. Existing health-probe and non-timeout stop policies
retain their prior scope.

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

## Runtime health evidence retention

Runtime health files keep group replay markers and notification outcomes for seven
idle days, measured from the newer terminal hook or notification outcome. Running
scenes, queued messages/continuations, Origin and every pending notification
(including `sending`) are protected. Once a deleted group's run directory is gone,
its terminal evidence can be removed at the next minute maintenance pass. Pending
notifications remain until their normal terminal outcome, even after deletion.
Old events from an idle-pruned group exceed the five-minute health-event validity
window, so replay cannot resend their first-failure notice. Fresh failures in a
revived group follow the existing notice flow.

The sole health writer caches the decoded file, invalidating it on inode, size,
mtime or ctime changes. Reads return independent snapshots; every successful
write still performs its original durable publication and immediately refreshes
the cache. Cleanup publishes only when it removes entries, without changing v1.


## Memory Sync diagnostics and repair

`activity-monitor/supervisor-events.jsonl` records `sync_triggered` and
`sync_result` and incident-level `sync_alert` alongside existing supervisor decisions. Existing log rotation
and retention apply to diagnostic evidence only. Records contain metadata,
never conversation content, receipts or Sync tokens.

Trigger records include scope, kind (group/origin/global), backlog, lag in
seconds, optional context percent and control/run/checkpoint identifiers.
Reasons include threshold, max_lag, context, inherited, catch_up and pre_reclaim. Logging
failure cannot change a protected operation or its control bookkeeping.

Protected results include commit (checkpoint, verified first/last C4 IDs and
count), advance (both cursor columns before/after), and round_complete (raw
count, advanced groups, remaining quota/backlog). Commit eligibility matches
receipt verification: outgoing rows or delivered incoming rows, filtered to
the appropriate scope. Summary-only Origin progress counts as useful work.
Each failed named operation emits one error record; nested guards delegate
reporting to it. Standalone guards report their failures. Successful lock
acquisition emits no result. Interrupted rounds have no completion result.

### Repair before notification

Release and TTL preparation capture the requested range before dispatch. A
terminal control is not proof of success. Group success requires a new content
checkpoint covering that range and a released Sync marker. A lagging state
header is diagnostic evidence only; it does not fail or retry reclaim Sync.
An Origin round proves durable cursor progress and marker release;
its bounded round need not drain all groups. A failed preparation retries once
with the same 900-second deadline. Two failed attempts permit normal reclaim
and persist one repair_failed incident with the latest matching result code or
no_checkpoint or control_timeout. New real work cancels the
preparation through the existing gates. Child/turn/identity checks still apply.

Groups without a live session do not receive backlog or checkpoint/state-gap
notifications and are not activated for repair. Their existing inherited Sync
trigger applies when ordinary work next activates them. Active readers continue
using normal Sync triggers. Pre-reclaim symptoms are recorded once as diagnostics;
the retry verdict owns any final owner notification.

### Persistent notification incidents

`activity-monitor/sync-alert-episodes.json` atomically records an incident by
scope + kind + alert type. A timeout includes control ID, so each control is a
separate permanent identity. There is no elapsed-time reset or retention cutoff
for notification ownership. This replaces both duration-based throttling and
handled-timeout recovery from rotated diagnostic logs. The same ownership rule
applies to diagnostic-only incidents.

Origin frequency, Origin idle rounds, control confirmation timeouts and active
checkpoint/state gaps emit one `sync_alert` record with type, scope, kind and evidence. They never enqueue an
alert control or notify the owner. Recording does not depend on Origin being
available. External scripts that monitor these diagnostic signals are outside
this mechanism.

Online unrepaired backlog, three requests without a checkpoint,
and final automatic repair failures retain the existing owner notification
route. Their text states the problem, the automatic repair attempted, the failure
reason and a concrete action the owner can request. Final automatic repair
failures continue notifying the owner; suppressing them in a future release is
not implemented here.

Resolution is explicit:

- backlog: count and age have returned inside the applicable trigger limits;
- state_uncommitted: valid state coverage reaches the checkpoint end;
- no_checkpoint: a newer content checkpoint exists;
- control_timeout: a different control is a different incident; the old ID is
  never announced again;
- origin_frequency: trailing-hour requests return to at most four;
- origin_idle: ten known completed rounds contain at most five truly idle rounds;
- repair_failed: durable checkpoint/marker or Origin cursor facts prove
  the captured repair target is fixed.

An unresolved incident records or notifies once, according to its type, including
after restart or loss of trigger logs. Resolved incidents can recur. Notification ownership is persisted before
enqueue; unknown enqueue outcomes keep ownership to avoid duplicates. A final
repair failure blocked by an Origin fence remains durably pending and can send
later even after its group goes offline, without blocking reclaim. Unreadable or
unwritable incident state stops notifications and emits a diagnostic rather than repeatedly messaging owners.

Sync marker expiration retains the baseline rule: a holder from a different run
is immediately stale; a same-run marker retains its existing 30-minute expiry.
Same-run worker failure recovery remains separate.

The incident ledger deliberately remains closed after an unreadable/unwritable
state failure; automatic reset would discard notification ownership and permit
repeated notices. Timeout identities have no retention cutoff, as required by
the one-control/one-incident contract; their small persistent set grows and is
rewritten atomically. This change does not add compaction or a recovery policy.
Origin backlog owner notices retain their threshold-based behavior, including
when every bounded Origin round succeeds but backlog remains above the limit.
Other repair-first notification gates are unchanged. A successful Origin round
is not described as a failed repair in its backlog notice.

Daily snapshots exclude tmp
additions and edits, including staged content, while committing deletions of
tracked temporary files.
