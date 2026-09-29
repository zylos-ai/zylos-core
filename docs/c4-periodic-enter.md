# C4 bounded periodic Enter and optional bracketed paste

PR #799 adds default-on bounded periodic Enter and delivery diagnostics.
Bracketed paste is opt-in; the default paste command remains unchanged.
All delivery operations target the configured `TMUX_SESSION`. No pane or
process identity is pinned and no Linux /proc inspection is required.

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
| `C4_PERIODIC_ENTER_INTERVAL_MS` | 60000 | Positive integer, minimum 1000; monotonic elapsed time |
| `C4_PERIODIC_ENTER_MAX_ATTEMPTS` | 3 | Positive integer, capped at 10 |
| `C4_ENTER_CAPTURE_ENABLED` | off | Only `1` enables sensitive local captures |

A new actual paste clears the old budget. A successfully pasted conversation
or ordinary non-slash text control arms a new budget. Slash controls and raw
keystrokes clear it. Queue admission and heartbeat auto-ack behavior are
unchanged. No idle, health, input-content or Codex-specific condition gates a
periodic attempt. An empty verdict or delivered status does not cancel it.

Initial and retry Enter commands reset the elapsed-time anchor on successful
command return, not on confirmed application submission. After at least 60
seconds, the awaited dispatcher loop attempts another Enter against
`TMUX_SESSION`, up to three cumulative attempts per eligible paste. With the
normal 1-3 second polling interval and an otherwise free loop, the first attempt
is about 60-63 seconds after the last normal Enter. Work already occupying the
loop may delay it further. The timer cannot interleave with normal delivery.

Failed sends consume budget and reset the attempt anchor, preventing tight
retries. Successful sends reset elapsed time without restoring attempts.
Exhaustion stops until another eligible paste; frequent new messages can defer
recovery indefinitely. A runtime/session restart does not cancel an existing
budget: the next attempt targets the session then available. Restarting the
dispatcher itself loses its in-memory budget. Dispatcher shutdown prevents sends.

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
draft ownership or dialog state, and can send to a replacement runtime or a newly
selected pane. It never changes a message's recorded delivery status.

## Diagnostics

Structured logs include item ID/type, timestamps, paste byte counts, Enter
results and detector branches. They omit message text, pane/process identity
fields and tmux errors that could contain input.
`C4_ENTER_CAPTURE_ENABLED=1` enables private snapshots around verification and
periodic Enter; it remains off by default. Periodic records retain the original
item ID/type and attempt count.

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
