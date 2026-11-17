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
arbitrary exception text. No owner notification is added.

Sources without a reply route (`system`, `void`, or no endpoint) have no
receipt. Scheduler work carrying an external channel and endpoint receives a
receipt there; control work without one has no recipient. Origin resident
launch and continuation launch have no claimed message and create no receipt.
Origin failures remain in Router logs/diagnostics; continuation failures retain
their existing five-failure, 30-minute-cooled owner notification.

## Internal exactly once; external at least once

Internal receipt insertion commits exactly once with the original failure.
External receipts use at-least-once sending: crash windows can produce a
repeat, which is preferable to losing the undelivered-message notification.
No channel idempotency mechanism is introduced.

Cooldown reservation and the receipt's `pending`→`queued` admission commit
in one SQLite transaction. `queued` means this external receipt has durable
permission to send. On restart, that same receipt bypasses cooldown, even
when its old reservation still exists. Other messages remain subject to the
600-second cooldown and can be classified `suppressed` before admission.

Only confirmed successful sends mark admitted receipts `sent`. Failure or
uncertain transport results keep the receipt retryable, update its attempt
time, and produce no recursive receipt or owner alert. Bounded draining
orders by attempt time then original ID so retries do not permanently block
later work. Internal queued receipts are excluded from external draining.

A crash after reservation but before spawn resends the original receipt.
A crash after a successful external send but before queue settlement also
resends it, potentially producing a duplicate. Repeated crashes in that
window can produce further duplicates. Once success is durably settled,
further polls do not send that receipt again. Original messages stay failed;
only their notification is retried.

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
