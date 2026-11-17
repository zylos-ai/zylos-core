# Delivery failure receipts

New terminal failures from delivery attempts, orphan recovery and pending
expiry enqueue a receipt in the same C4 transaction. Original messages stay
failed and are never replayed. Historical failures are not backfilled.

Internal receipts use the original row's endpoint (the sender group), never
its body. Their inbound conversation and group head commit with the original
failure. Unique original and receipt conversation IDs prevent duplicate and
recursive receipts, even after expiry overwrites the receipt's delivery action.

External receipts use the original channel and endpoint. The dispatcher drains
at most 20 pending receipts each poll through the existing status sender,
including after startup recovery. Its existing 600-second cooldown applies to
channel, normalized endpoint, target group, runtime, health and failure reason.
A burst sharing that key admits the first receipt and suppresses other
messages. Internal receipts have no cooldown. No receipt copies the original body or
arbitrary exception text. User-message failures do not notify the owner.

## Scheduled-message failures

Scheduler handoff supplies `--core-source scheduler` and `--task-name`. C4
persists them as nullable `conversations.core_source` and `task_name` in the
unreleased 4→5 migration. Provenance never comes from a message-body prefix.
Historical rows have null provenance and retain user-message receipt behavior;
a missing scheduler task name uses an unnamed-task label.

For scheduler messages, `launch_failed`, `ready_timeout`, `pending_expired` and
`orphan_expired` notifications go to the owner instead of the original chat.
The last category is expiry observed during restart recovery. Delivery/Enter
verification failures and retry exhaustion of unknown cause retain their
ordinary receipt path; they are outside the scheduled startup/readiness/expiry
scope. No original message is replayed.

`scheduled-failure-alert.js` reserves the existing durable cooldown/admission
for the target session group and fixed reason, at most once per 600 seconds
across different messages. It renders task name, fixed failure classification,
target group and channel+endpoint, and asks the owner to have the corresponding
session investigate in that chat. Original message bodies and arbitrary errors
are never copied. The durable failure queue also works for scheduled messages
with no reply endpoint.

The activity-monitor's existing `SupervisorServerHealth.notify` implementation
now lives in `cli/lib/supervisor-server-health.js`; activity-monitor re-exports
the same class. Comm-bridge uses its Core module loader, without importing
another skill. Both continuation alerts and scheduled-message alerts reuse
that exact policy: valid `alert_target` first; unset/invalid target or send
failure falls back once to `DEFAULT_ALERT_DESTINATION` (Dashboard Origin).
The shared policy's outcome contract is unchanged, including a best-effort
fallback when both destinations fail. Queue `sent` here means that shared
notification policy completed; it is not independent transport confirmation.

Non-scheduler sources without a reply route (`system`, `void`, or no endpoint)
have no receipt. Scheduler control-queue work is outside this conversation-row
failure path. Origin resident launch and continuation launch have no claimed
message and create no receipt. Origin failures remain in Router diagnostics;
continuation failures retain their existing five-failure, 30-minute-cooled
owner notification.

## Internal exactly once; external best effort within a bounded lifetime

Internal receipt insertion commits exactly once with the original failure.
External receipts are best effort for at most 600 seconds from their stored
`created_at`. Crash windows can produce a repeat within that lifetime. No
channel idempotency mechanism is introduced.

Cooldown reservation and the receipt's `pending`→`queued` admission commit
in one SQLite transaction. `queued` means this external receipt has durable
permission to send. On restart, that same receipt bypasses cooldown, even
when its old reservation still exists. Other messages remain subject to the
600-second cooldown and can be classified `suppressed` before admission.

Only confirmed successful sends mark admitted receipts `sent`. Failed or
uncertain transport results update the attempt time and wait at least 30
seconds before another send. Once 600 seconds have elapsed from `created_at`,
the receipt becomes terminal `failed` and is never sent again. Crash recovery
resumes durable admission without incrementing a retry counter; no retry
counter is stored. Bounded draining orders by attempt time then original ID
so retries do not permanently block later work. Internal queued receipts are
excluded from external draining. No outcome creates a recursive receipt or
additional owner alert.

The production drainer reports failed or uncertain sends as structured
`failure_receipt_send_failed` Router diagnostics and lifetime exhaustion as
`failure_receipt_exhausted`. These events contain routing identifiers and
fixed outcome classifications only, never message bodies, credentials, or
arbitrary exception text.

A crash after reservation but before spawn retries the original receipt within
its remaining lifetime.
A crash after a successful external send but before queue settlement also
resends it within its remaining lifetime, potentially producing a duplicate.
Repeated crashes in that window can produce further duplicates until the
lifetime expires. Once success is durably settled,
further polls do not send that receipt again. Original messages stay failed;
only their notification is retried.

## Launch diagnostics

Preflight, launch creation, executor initialization and exec confirmation share
one monotonic 10-second budget starting at `SessionAdapter.launch`, with no
configuration option. Preflight open/command I/O receives the remaining budget;
its former independent 3000 ms timeout no longer truncates this launch path.
Time spent in preflight is deducted from all later phases. Runtime capability
queries are also bounded by the remaining time. Runtime READY still has its
separate 30-second budget. Other tmux I/O defaults remain unchanged. Guarded
cleanup retains its separate bounded allowance after launch failure.

Launch settlement retains monotonic phase durations. For launch errors and
READY timeout, Router emits `session_launch_failed` with
`preflight_ms`, `new_session_ms`, `executor_init_ms`, `exec_confirm_ms`, `cleanup_ms`, `total_ms`,
`timeout_ms`, `last_phase`, `attempt`, `run_id`, `conversation_id`, and `cause`.
Only fixed classifications and durations enter that event. NAME_CONFLICT is
uncounted, unconfirmed stop retains ownership, and observed READY wins over a
launch error. Preflight failures identify their phase as `preflight`; READY timeout uses
`runtime_ready` and the separate READY budget.
