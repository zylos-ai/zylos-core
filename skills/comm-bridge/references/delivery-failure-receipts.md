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
owner alert.

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

Preflight tmux observation retains its existing 3000 ms command timeout.
After preflight, launch creation, executor initialization and exec confirmation
share one 10-second launch budget with no configuration option; each operation
receives the remaining budget. Runtime READY still has its separate 30-second
budget. Other tmux I/O defaults remain unchanged.

Launch settlement retains monotonic phase durations. For launch errors and
READY timeout, Router emits `session_launch_failed` with
`new_session_ms`, `executor_init_ms`, `exec_confirm_ms`, `cleanup_ms`, `total_ms`,
`timeout_ms`, `last_phase`, `attempt`, `run_id`, `conversation_id`, and `cause`.
Only fixed classifications and durations enter that event. NAME_CONFLICT is
uncounted, unconfirmed stop retains ownership, and observed READY wins over a
launch error. Preflight failures identify their phase as `preflight`; READY timeout uses
`runtime_ready` and the separate READY budget.
