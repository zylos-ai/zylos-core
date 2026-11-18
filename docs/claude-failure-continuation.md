# Claude failure continuation

A current main-agent Claude StopFailure with `server_error`, `overloaded`, or
`network_error` schedules exactly `Continue` after 30 seconds, then 2 minutes,
then 5 minutes if the continued turns also fail. After the third failed
continuation, AM clears the retry record and the existing notice worker sends
the ordinary service-error notice. The message does not mention retry counts.
A successful continued Stop resets the budget. Other errors and runtimes keep
their existing behavior; quota/request/context/content diagnostics can veto retry.

## AM owns observation and accounting

AM uses the existing long-lived shared reader and its unchanged `turnStartedAt`.
Before its control is claimed, a start later than the failure cancels the pending
Continue and commits the cleared state. `turnOpen` alone is not proof of a new
round because the failed round's closing activity hook can arrive later than
its health hook. Late old tools also do not prove a new round.

A control in `running` has only been claimed; it may still be before paste.
AM retains a later terminal health hook in its existing reader queue until that
control settles. `done` confirms delivery under the standard control contract;
a failure at or after its due time then advances the retry budget. A successful
Stop clears it. There is no separate submission event or failure-specific binding.
AM keeps attempts/deadlines and the frozen first recipient in its health file,
so an AM restart can replay the terminal hook and continue from the same control.

At the due time AM checks for ordinary pending input and silently cancels the
Continue if present and its control has not yet been claimed. Running controls
are left to standard delivery settlement. There is no second pending-input check
in C4. The existing AM delivery-notification path also clears retry state when an ordinary message
was pasted after the failure. A message pasted before failure does not cancel;
notifications for controls do not clear their own continuation budget.

The shared reader's prompt/dequeue rules and five-second Stop lag allowance are
unchanged. This PR adds no shared reader interface, recovery semantics, round
parser, event type or database schema. Esc itself never triggers continuation.

## Standard control delivery

The producer reuses delayed idle controls bound to the existing run/session/pane
identity. C4 recognizes a bound idle `Continue` using existing fields and sends
exactly that word, without `Meanwhile,` or an acknowledgment suffix. Before
paste it rereads the control row only to respect a cancellation already committed
by AM. It does not read failure events or classify rounds.

Transport errors follow existing control retry behavior, including safe requeue
before paste. If delivery finally becomes `failed`, AM restores the original
failure notice instead of silently abandoning the request. A newer failure
expires an older pending control before its health replay marker is published.
No extra idempotency or uncertain-paste replay prevention is added.

## Accepted limitations

- If a successor round is never observed in time, an extra Continue can be sent,
  including with complete records during monitor stalls, restart, or transcript
  backlog. Once cancellation is committed, later reader history loss does not
  revive that control.
- An uncertain paste follows standard control delivery and can repeat Continue.
- If C4 sends before AM saves the returned control ID and AM crashes in that
  gap, recovery can enqueue another Continue. Ordinary pending-row supersession
  does not provide exactly-once recovery for a completed row.
- Input arriving after AM's due-time check but before paste can follow Continue.
- If dispatcher crashes/restarts while delivering Continue, its running row can
  remain unsettled. All later terminal health hooks in that group wait behind
  it, including rate-limit and authentication notices, and the observer skips
  screen checks while continuation owns the screen. Processing resumes in queue
  order after release. That failure neither retries nor notifies until a later
  ordinary message is delivered and AM receives its existing one-way hint.
  The hint is not durable and can be lost during AM restart; another later
  message is then needed. This PR does not change control startup recovery or
  add compensating signals or timeouts.

## Validation boundary

Isolated integration uses real SessionActivity, HealthEventReader, HealthStore
and the C4 fixture database to complete three failed continuations and send one
ordinary service-error notice. A terminal failure arriving while control is
running waits, then settles after done. Other cases cover persisted deadlines,
frozen recipient, AM restart, successful Stop, eligibility, new-round and due
pending-input cancellation, and a final transport failure without any subsequent
hook.

The native timing case observes dequeue at failure+0.2s, cancels at +1s before
Stop at +25s and the +30s deadline, and never replays after state reopen.
Supervisor assembly exercises its real private notification socket: an old
paste does not cancel, a later ordinary paste releases an orphan running retry,
and a subsequent failure can start a fresh retry. Delivery tests cover exact
content, persisted cancellation and pre-paste error requeue. Shared reader and
hook files are unchanged. Tests do not use live Claude, tmux or network services.

Real-Claude reviewer execution covers disconnect, actual 30s/2m/5m delivery,
ordinary error notification, user-input cancellation, AM/dispatcher restart and
Esc. Synthetic hooks and injected adapters do not establish those live outcomes.
