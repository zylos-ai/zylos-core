# C4 delivery hardening and bounded recovery

PR #799 ships bracketed paste, pinned normal delivery, opt-in bounded periodic
Enter and diagnostic logging. There are no hooks. Periodic recovery remains
default-off and is distinct from a reliable submission acknowledgement.

## Delivery target

Before paste, resolve a concrete tmux pane ID, runtime PID and Linux process
start time. Discovery checks the pane process and direct children; unavailable
identity fails without pasting. Arbitrary process wrapper trees are unsupported.
Paste, initial Enter, retries, Escape and checks all use that pane. Changing the
selected pane cannot redirect delivery. Before paste and each key, revalidate
the runtime in the pinned pane. Checks around verification prevent accepting a
replacement runtime's empty prompt. Identity changes stop delivery and the
normal queue retry policy applies. Lifecycle exit controls accept disappearance
after the initial Enter, but do not accept a replacement runtime. Explicit raw
keystroke controls resolve and validate a target immediately before sending.

Target discovery distinguishes present, authoritatively absent and lookup error.
A failed tmux command is not proof of exit: pane removal needs a successful
pane listing, while a successful dead-pane lookup or runtime search can confirm
absence. `pgrep` exit 1 means no children; other errors, malformed output and
non-ENOENT process read failures remain errors. Lifecycle completion additionally
requires ENOENT for the original process stat; permission/read errors cannot
masquerade as absence. Configuration reads use the same Claude fallback at
startup and during verification when config is absent or malformed; valid runtime
changes are observed immediately and invalidate the old target.

`tmux paste-buffer -p` adds bracketed-paste markers when the application enables
the mode. This is an unconditional behavior change; a separate Enter is still
required. Successful tmux commands prove injection, not application submission.
The existing input heuristic is not a receipt; the natural false-empty trigger
remains unproven.

## Bounded periodic recovery

| Setting | Default | Meaning |
| --- | --- | --- |
| `C4_PERIODIC_ENTER_ENABLED` | off | Set `1` to enable |
| `C4_PERIODIC_ENTER_INTERVAL_MS` | 60000 | Minimum 1000; monotonic elapsed time |
| `C4_PERIODIC_ENTER_MAX_ATTEMPTS` | 3 | Positive integer, capped at 10 |
| `C4_ENTER_CAPTURE_ENABLED` | off | Set `1` for sensitive local pane captures |

A new actual paste clears the old budget. A successfully pasted conversation
or ordinary non-slash text control arms the budget using the exact target
captured BEFORE paste. Slash controls and raw keystrokes clear it. Queue admission
and heartbeat auto-ack behavior are unchanged. No idle, health or empty-input
condition gates a periodic attempt. In particular, an ordinary verification
returning empty or marking delivered does not cancel the budget.

Initial and retry Enter commands reset the elapsed-time anchor on successful
command return, not on confirmed application submission. At least 60 seconds
after the last Enter, the awaited dispatcher loop attempts one Enter on the
original pane and retains the cumulative maximum of three attempts. Failed
commands consume budget and reset the attempt anchor so they cannot spin.
Successful commands reset elapsed time but do not restore attempts. Exhaustion
stops until another eligible paste; new messages may defer recovery indefinitely.
Startup has no budget for pre-existing drafts. Shutdown prevents sends.

The timer resolves the original pinned pane, never the currently selected pane,
and checks runtime PID/start time before sending. A missing or replaced runtime
cancels the budget. This prevents selection drift but cannot prove draft
ownership. The single awaited loop prevents the timer from interleaving with
normal paste/verification; external writers are outside that guarantee. Linux
process inspection and tmux sending are not an atomic transaction.

## Accepted operating boundary, unresolved risk

Pane/PID identity cannot distinguish a prompt from a dialog or human draft.
The existing screen parser cannot establish ownership of the original C4 input.
Blind periodic Enter may confirm dialogs, submit unrelated drafts or combine
messages. Disarming on the existing empty heuristic would recreate the original
false negative. The owner has explicitly chosen to retain this bounded blind
recovery behavior for the agent terminal, without adding those gates. This is an
accepted operating tradeoff, not proof these risks are fixed. Dialogs, menus,
manual drafts and external writers remain unsupported safety assumptions for
broad enablement. Empty/busy-input tests do not establish safety for all UI states.
The original false-empty root cause is not declared solved.

## Diagnostics

Structured logs include item ID/type, timestamps, paste bytes, Enter results,
detector branches and identity failures, without message text or tmux command
errors containing input. `C4_ENTER_CAPTURE_ENABLED=1` enables local snapshots
before normal verification and before/after periodic Enter; default off.
Periodic events/captures include the original item ID/type, pane and attempt.
These may contain secrets. The directory
is mode 0700, files 0600, capped at 100 files and 8192 capture characters per file.
Capacity stops collection without deleting old evidence. No scrollback or upload.
Geometry collection adds up to two 500ms command timeouts per observation.

## Verification

Run `node --test skills/comm-bridge/scripts/__tests__/delivery-target.test.js skills/comm-bridge/scripts/__tests__/periodic-enter.test.js`
and existing dispatcher/capture tests. Wiring tests execute actual dispatcher
functions with controlled tmux/process responses for pane switches, replacements,
missing identity, retries and lifecycle exit. Historical CC/Codex live tests
cover bracketed paste. Timer tests cover exact interval, cumulative cap, failed
command rate limiting, original-pane recovery after selection changes, replaced
runtime cancellation, and recovery despite an empty verdict or unhealthy/busy
monitor. These tests do not establish UI/draft ownership. No natural reproduction
of issue #795 is claimed.
