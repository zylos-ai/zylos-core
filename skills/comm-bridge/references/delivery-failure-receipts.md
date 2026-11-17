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
A burst sharing that key sends the first receipt and suppresses later ones.
Internal receipts have no cooldown. No receipt copies the original body or
arbitrary exception text. No owner notification is added.

Sources without a reply route (`system`, `void`, or no endpoint) have no
receipt. Scheduler work carrying an external channel and endpoint receives a
receipt there; control work without one has no recipient. Origin resident
launch and continuation launch have no claimed message and create no receipt.
Origin failures remain in Router logs/diagnostics; continuation failures retain
their existing five-failure, 30-minute-cooled owner notification.

## External crash boundary

Pending receipts survive restart between failure commit and sending. Each attempted send is terminal, including a sender that cannot start;
receipts do not automatically retry. Sent, failed, suppressed and uncertain
outcomes are persisted. The existing sender reserves cooldown before spawning.

External transports have no shared durable idempotency key or transaction with
C4. A crash after reservation but before sending may suppress an unsent
receipt; a crash after sending but before settlement cannot prove whether it
was sent. This retains the existing conservative behavior for uncertain sends
and **does not guarantee exactly-once delivery across that window**. Accepting
this boundary requires an explicit product decision. Internal receipt insertion
has no cross-system window.

## Launch diagnostics

Confirmation has a 10-second budget with no configuration option. Runtime READY
still has 30 seconds. Other tmux I/O defaults remain unchanged: launch creation,
executor initialization and exec confirmation explicitly receive the remaining
launch budget.

Launch settlement retains monotonic phase durations. For launch errors and
READY timeout, Router emits `session_launch_failed` with
`new_session_ms`, `executor_init_ms`, `exec_confirm_ms`, `cleanup_ms`, `total_ms`,
`timeout_ms`, `last_phase`, `attempt`, `run_id`, `conversation_id`, and `cause`.
Only fixed classifications and durations enter that event. NAME_CONFLICT is
uncounted, unconfirmed stop retains ownership, and observed READY wins over a
launch error. Preflight failures identify their phase as `preflight`; READY timeout uses
`runtime_ready` and the separate READY budget.
