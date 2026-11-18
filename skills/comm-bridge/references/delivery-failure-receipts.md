# Terminal delivery notifications

New terminal failures from routing delivery attempts,
orphan recovery and pending expiry enqueue notification work in the same C4 transaction. Original messages
stay failed and are never replayed. Historical failed messages are not backfilled.
The existing `failure_receipts` table holds internal receipts and external
owner-alert work; its name and schema are unchanged by the routing revision.

## Internal receipts

Internal failures return exactly one receipt to the original sender group,
using stored routing metadata rather than message-body parsing. The receipt's
inbound row and group head commit with the original terminal failure. Unique
original/receipt IDs prevent duplicates and recursion, even after expiry changes
the receipt's delivery action. Internal text includes the original ID, target
group, fixed reason and “系统回执，无需回复”. It honors statusNotices.brand.
Unverified Enter delivery says that delivery could not be confirmed.

## External owner alerts

Every non-internal terminal delivery failure goes to the owner, for every
fixed reason, including delivery_failed, delivery_unverified and
orphan_retry_exhausted. It never sends a failure receipt to the original chat.
Initial c4-receive auth/health rejections retain the existing branded status reply
with template overrides and the 600-second cooldown. They do not enqueue owner
alerts. Status replies do not mean the inbound work reached the runtime.

Scheduler handoff supplies `--core-source scheduler` and `--task-name`. C4
persists nullable TEXT conversations.core_source and task_name in the
unreleased 4→5 migration. Scheduler alerts name the task, with an unnamed-task
fallback, and include the original message #id for diagnosis. User alerts identify channel+endpoint and message #id. Both provide complete Chinese and English sections containing target group,
source channel/chat (labelled `Source chat`) and fixed failure classification.
Both sections use the configured status-notice `[brand]` prefix with the same
validated `Zylos` fallback as internal receipts. Each section ends by
asking whether the owner wants an investigation and can reply directly to the
alert: “需要我排查原因吗？需要的话请直接回复这条消息。” Bodies and arbitrary exception
text are never copied. Historical rows have NULL source and use user wording;
a body prefix never establishes scheduler provenance. These two wording columns
are excluded from public history projections; the dedicated read-only diagnosis
command exposes the bounded task name and classified source when needed.

The sender reuses the existing SQLite cooldown/admission mechanism, keyed by
target session group and fixed reason. Different messages sharing that key
admit at most one alert per 600 seconds, regardless of source or endpoint.
Cooldown suppression is terminal for those other messages.

The activity-monitor's SupervisorServerHealth.notify implementation lives in
cli/lib/supervisor-server-health.js. Activity-monitor re-exports the identical
class and default destination. Comm-bridge uses its Core loader, without
importing another skill. The routing sequence remains: valid alert_target first;
unset/invalid target or a failed send falls back once to DEFAULT_ALERT_DESTINATION
(Dashboard Origin). A configured Origin target is never sent to twice in one
attempt. Existing continuation and server-health policies retain their routing.

notify now returns true only when a channel-send promise resolves without
throwing and without returning false, for either configured target or fallback.
It returns false if both destinations fail (or the configured Origin fails).
This is the existing transport's observable success, not an independent
end-user read receipt. Other callers may continue ignoring the result.

## Persistent alert delivery and bounds

External failure work commits as pending. Cooldown admission and transition to
queued commit together; queued survives restart and bypasses cooldown for the
same notification, while different messages are still suppressed.

The sender marks an alert sent only on notify === true. False, missing results,
throws or uncertain results leave it retryable. Failed attempts persist their
time and wait at least 30 seconds; a same-second first failure may round to
31 seconds. At age 600 seconds from created_at the work becomes terminal failed,
without another send. A drain handles at most 20 eligible rows and is single
flight. No retry counter or configuration option is added. With immediate
transport failures and advancing 31-second polls, tests observe 20 attempts
(40 channel sends when owner and Origin both fail), then zero further sends.
Actual slow transport attempts reduce that count.

A crash before sending is recoverable from the queue. A crash after sending
but before durable settlement can duplicate the same owner alert. Crashes do
not increment a retry counter; remaining lifetime and persisted backoff remain
in force. Neither alert failure nor exhaustion recursively creates another
notification. Original failed messages are never redelivered.

The production drainer emits failure_receipt_send_failed and
failure_receipt_exhausted in Router diagnostics. These existing event names
are retained. They contain IDs, fixed classifications and numeric age/lifetime,
never message bodies, exception text, credentials or environment values.

Scheduler control-queue work is outside this conversation-row failure path.
Origin resident startup and continuation launch have no claimed message, so
create no per-message notification. Origin failures remain in Router diagnostics;
continuation failures retain their existing five-failure, 30-minute-cooled
owner notification.

## Launch diagnostics

Preflight, capability queries, new-session, executor initialization and exec
confirmation share one monotonic 10-second budget starting at SessionAdapter.launch,
with no configuration option. Every launch operation gets the remaining budget.
Other tmux I/O defaults and the separate 30-second runtime READY budget remain
unchanged. Guarded cleanup has its separate bounded allowance.

session_launch_failed contains preflight_ms, new_session_ms, executor_init_ms,
exec_confirm_ms, cleanup_ms, total_ms, timeout_ms, last_phase, attempt, run_id,
conversation_id and cause. NAME_CONFLICT is uncounted, unconfirmed stop retains
ownership and observed READY wins over launch error. Preflight failures identify
preflight; READY timeout identifies runtime_ready and its separate budget.

## Investigating an alert

This is an owner-authorized, read-only investigation. If a short owner reply
such as “需要” is unclear, first follow the installed
[short-reply rule](../SKILL.md#short-replies-to-owner-alerts). Read only this
chat's recent records, including outbound delivery_action=system_notice rows:

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js recent 20 --channel '<channel>' --endpoint '<endpoint>'
```

Use the incoming reply's exact channel and endpoint. The documented
[recent command](c4-db.md#recent) normalizes message-level routing metadata but
keeps actual topics/threads isolated. Match the owner's reply to the alert's
question before acting; if it remains ambiguous, ask which alert they mean.
A “yes” to the investigation question authorizes investigation, not a rerun.

Take the original message #id from the alert body, not the alert's own outbound
C4 row ID. Both scheduler and user alerts include that original ID. Replace ID
below with its positive integer value:

```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-diagnose.js --id ID
```

The command reads the current schema in read-only mode and returns JSON:

1. data.message contains id, status, retry_count, original channel/endpoint,
   target session_group, source/task_name, fixed reason and alert_state. An old
   failed row can have reason=null because historical failures were not
   backfilled. Report that limitation; do not infer a cause from its body.
2. data.launch_failures.events contains retained Router session_launch_failed
   events matching conversation_id. Inspect preflight_ms, new_session_ms,
   executor_init_ms, exec_confirm_ms, cleanup_ms, total_ms, timeout_ms,
   last_phase, cause, attempt and run_id. Router writes them to
   $ZYLOS_DIR/comm-bridge/router-events.jsonl (default ~/zylos/comm-bridge), with
   timestamp rotations. The command reuses Core's event reader, caps scanning
   at 10000 records and returns at most 20 matching events. limited=true means
   the bounded scan stopped; unavailable=true means the log could not be read.
   Empty events may mean log retention or a non-launch failure, not success.
3. data.target comes from Core's current session reader. In multi mode it
   observes the target group; in single mode the runtime target is Origin.
   observation=unknown, present=null, ready=null or status_valid=false means
   the current state could not be confirmed. Do not treat an unavailable tmux
   server or stale/invalid status as proof that the session exited. Compare
   present/ready/runtime/state/health only when the observation is valid.

The diagnostic output excludes message bodies, arbitrary exceptions, launch
configuration and environment values. NOT_FOUND means the ID is unavailable;
DIAGNOSTIC_UNAVAILABLE means the database/schema or a required Core module
could not be read safely. A target observation failure instead returns
target.observation=unknown; a log read failure returns
launch_failures.unavailable=true. Do not bypass those results with unprojected database text
or another chat's history.

After checking, explain the fixed failure category, retained timing evidence
and current target state to the owner, including any missing evidence. The
original message remains failed and will not replay automatically, even if
the target is healthy now. Ask the owner whether to rerun a scheduled task
manually or notify the original sender; investigate first and obtain that
explicit decision before either action. Never silently replay a user message
or change the failed row to pending.
