# C4 bounded periodic Enter and optional bracketed paste

PR #799 adds default-on bounded periodic Enter and delivery diagnostics.
Bracketed paste is opt-in; the default paste command remains unchanged.
On the prerelease router, budgets belong to one session group (`null` in single
mode, the row's session_group in multi mode). Every operation uses the existing
bound executor with READY/run/server/session/pane validation. The production
entry delegates to router/factory.js, router/lane.js and router/delivery.js.

## Paste mode

`C4_BRACKETED_PASTE_ENABLED=1` enables `tmux paste-buffer -p`. Unset or
any other value uses the existing `paste-buffer` command without `-p`.
Both modes still send a separate Enter. Bracketed paste may change how Claude
Code treats forwarded instructions, so enabling it requires deployment-specific
validation. Negative isolated tests used disabled feature-flag fetching and
cannot rule out that semantic change; removing that variable alone also did
not enable wrapping in the synthetic-identity/local-interface fixture.

Successful tmux commands prove injection, not application submission. The
existing input heuristic is not a receipt. This PR does not redesign submission
verification or claim to establish the natural false-empty root cause.

## Bounded periodic recovery

| Setting | Default | Meaning |
| --- | --- | --- |
| `C4_BRACKETED_PASTE_ENABLED` | off | Only `1` enables bracketed paste |
| `C4_PERIODIC_ENTER_ENABLED` | on | Unset or `1` enables; any other value disables |
| `C4_PERIODIC_ENTER_INTERVAL_MS` | 5000 | Positive integer, minimum 1000; monotonic elapsed time (was 60000 before #795) |
| `C4_PERIODIC_ENTER_MAX_ATTEMPTS` | 3 | Positive integer, capped at 10 |
| `C4_ENTER_CAPTURE_ENABLED` | off | Only `1` enables sensitive local captures |

A successfully pasted conversation or ordinary non-slash text control arms a
new three-attempt budget. If an earlier item's budget is still pending (not
exhausted), the new budget in the same group keeps that earlier elapsed-time anchor: text pasted
on top of an unsubmitted message must not push its recovery back (#795).
Slash controls and raw keystrokes clear the budget. Queue admission and heartbeat auto-ack behavior are
unchanged. No idle, health, input-content or Codex-specific condition gates a
periodic attempt. An empty verdict or delivered status does not cancel it:
#795 showed confident `empty` verdicts from both the cursor check and the text
parser while the draft was still in the input box, and accepting
`disputed_empty` (below) is only safe because this budget stays armed. Do not
add a cancel-on-empty path without replacing that backstop.

Initial and retry Enter commands do not move the elapsed-time anchor: in
#795 the Enters that followed later pastes did not submit the stuck draft
either, so treating them as progress only delayed recovery. The anchor is the
paste that armed the oldest pending budget, or the last periodic attempt.
After at least the interval (5 seconds by default), the awaited dispatcher
lane attempts another Enter for that group, up to three cumulative attempts
per budget. At the default one-second router poll, an otherwise free lane
starts around 5-6 seconds after that paste. Work already occupying the same
lane may delay it; other groups remain independent. The lane awaits due
supplementation before its next claim. Within a delivery, periodic timers start
only after initial Enter and verification return, and cover any remaining
require-idle settlement wait. They do not run between paste and initial Enter
or during verification. The awaited I/O queue serializes those settlement
attempts, and drains them before the claim settles and the next paste starts.
The prerelease baseline had no between-delivery backstop; the awaited lane
supplementation adds it so the budget remains effective after settlement.

Failed sends consume budget and reset the attempt anchor, preventing tight
retries. Successful sends reset elapsed time without restoring attempts.
Exhaustion stops until another eligible paste. Frequent new messages no
longer defer recovery, because they keep the pending anchor. A runtime/session restart does not cancel an existing
budget: between deliveries, the next attempt opens a fresh executor and resolves
the currently READY runtime in that same group. Within an active claim, its
original executor remains pinned and never redirects to a replacement. Claim
callbacks still drain and close before ledger settlement; only the bounded
group budget survives settlement. Dropping a lane clears its budget. Restarting
the dispatcher loses in-memory budgets; shutdown stops lanes and drains all I/O.

## Accepted operating boundary

The owner has accepted blind, bounded recovery for an agent-dedicated terminal.
In the intended deployment, authorization menus are suppressed at startup or
handled by the existing automatic-selection hook. Claude Code directory trust
dialogs concern previously untrusted directories; the established agent working
directory is already trusted. These are deployment assumptions, not UI checks
introduced by this PR, and isolated test directories can still show dialogs.

A person manually attaching and typing a partial draft is outside the dedicated
agent-terminal convention: a scheduled Enter may submit that draft. Existing
isolated tests also showed Enter selecting menu items. These effects remain
possible if the operating assumptions are violated. The timer does not identify
draft ownership or dialog state. A between-delivery attempt can send to a
replacement runtime in the same group after target resolution, but cannot
redirect a bound operation to another group or pane. It never changes a
message's recorded delivery status.

## Disputed empty verdict

For Claude, the cursor detector runs first and the text parser can override a
cursor `has_content`. The parser only reads the first 10 characters of the
input box's first line, so a multi-line draft can make it report `empty`
while the draft is still there (#795). That override is now reported as
`disputed_empty`: verification sends one extra Enter (`dispute_retry`) and
checks again. A second disagreement, or one on the final check, is accepted
as submitted instead of failing strict conversation verification, because a
strict failure re-pastes the whole message and duplicates the input. The
periodic Enter remains the backstop for anything still left in the input box;
this acceptance depends on the budget staying armed after an `empty` or
`disputed_empty` verdict (see above).

## Diagnostics

Structured logs include item ID/type, timestamps, paste byte counts, Enter
results and detector branches. They omit message text and tmux errors that could contain input. Router events
retain the existing group/run/runtime attribution; periodic events also name
the latest armed item ID/type and attempt.
`C4_ENTER_CAPTURE_ENABLED=1` enables private snapshots around verification and
periodic Enter; it remains off by default. Periodic records retain the latest armed
item ID/type and attempt count within the group.

Captures may contain secrets. The directory is mode 0700, files 0600, with a
100-file cap and 8192 capture characters per file. Capacity stops collection
without deleting old evidence. No scrollback or upload. Geometry collection adds
up to two 500ms command timeouts per observation. General dispatcher log rotation
is outside this PR.

## Verification

Run the dispatcher, session-delivery, periodic-enter, configuration and capture
tests under `skills/comm-bridge/scripts/__tests__/`. Controlled tests cover
default/opt-in paste arguments, session-name routing, normal verification,
interval/cumulative budgets, failed-send throttling, retention across runtime
replacement and recovery after an empty verdict.

Historical isolated runtime tests demonstrate retained-draft recovery and
manual-draft/menu side effects, but are not acceptance of the final revised
head. Full Lark-to-runtime-to-reply acceptance and a confirmed natural #795 root
cause remain outstanding.
