# Claude failure continuation

A current main-agent Claude `StopFailure` with `server_error`, `overloaded`, or
`network_error` schedules exactly `Continue` after 30 seconds, then 2 minutes,
then 5 minutes if the continued turns also fail. A successful continued `Stop`
resets the budget. Other errors keep their existing immediate notices.
Recognized quota, authentication, model, request, context and content exclusions
can veto a retry; text never authorizes one. Codex and AGY are unchanged.

## Observe and cancel in AM

This PR uses #1350's existing round classification and existing `turnStartedAt`.
AM keeps observing throughout the waiting period. When that start time is later
than the failure time, AM immediately expires the queued Continue and commits
the cleared retry state. A later Stop, reader rebuild or restart cannot revive
an already cancelled control. The marker for our own submitted Continue keeps
its accepted round in the same retry chain.

`turnOpen` alone is not successor evidence: the failed round's asynchronous
closing hook may arrive after its health event. Busy state and late tool hooks
also do not establish a new round. The shared reader owns prompt/dequeue rules,
including the existing five-second Stop lag allowance; this PR does not change
its fields, recovery behavior or interface, and adds no second round parser.
There is no fixed failure reader in C4 delivery.

At the due time, ordinary input already pending in the scope also cancels the
continuation silently. C4 checks this condition again before paste. Existing
lane scheduling order is unchanged.

## Persistence and delivery

- AM's existing sole health writer persists group-scoped retry deadlines and
  attempt counts. The first failure's notification recipient is frozen.
- C4 reuses delayed idle controls, bound run/session/pane identity and internal
  `failureContinue` metadata. Idempotent insertion returns the original row,
  including terminal rows, across a queue-commit/health-write crash.
- Control content is exactly `Continue`, without `Meanwhile,` or an ack suffix.
  A persisted submission marker precedes paste. A subsequent accepted prompt
  confirms submission; the marker alone prevents replay of an uncertain paste.
  The health-event tail is used for submission accounting and later failures,
  not to infer round starts.
- No notice is sent during retrying. After three continued turns fail, the
  existing first-failure worker sends one bilingual exhaustion notice using its
  existing reservation and restart-uncertainty rules.
- Pending retries suppress a stale overload-screen restart for their own run.
  Replacement of the run or session invalidates the retry.

No database table or column changes are required. Esc itself never triggers
continuation.

## Known limitation

If an entire successor round is never observed in time, AM can miss its start
and an additional Continue can be sent. Examples include a stalled monitor,
a restart during that interval, a transcript cursor that has not reached the
relevant records, or Claude omitting dequeue. This can happen even when the
records exist; the limitation is not restricted to missing records or restarts.
The accepted design does not add history recovery to close this gap.

## Validation

The isolated integration connects a real shared SessionActivity reader to AM
and the C4 database: a dequeue 0.2 seconds after failure is observed and cancels
before its 25-second Stop and 30-second deadline, with no later replay after
restart. Other cases cover 30s/2m/5m, exhaustion and the frozen recipient,
ordinary-input cancellation/no replay, error/runtime exclusions, identity changes,
queue-commit crash recovery and successful Stop reset. Delivery tests use an
injected adapter for exact content, idle gating, queued input, stale identity
and ambiguous-paste no replay. No live Claude, tmux or network is involved.

Real-Claude review still covers a mid-response disconnect, actual delayed
Continue delivery and repeated-failure exhaustion, user notice suppression,
incoming-message cancellation, AM restart and Esc. Synthetic hooks and injected
adapters do not establish these live-runtime outcomes.
