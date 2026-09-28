# C4 delivery hardening and deferred recovery

PR #799 ships bracketed paste, pinned normal delivery and diagnostic logging.
It does not ship automatic periodic Enter, timer configuration or hooks.
Earlier revisions contain the experimental timer and tests as historical evidence.

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

`tmux paste-buffer -p` adds bracketed-paste markers when the application enables
the mode. This is an unconditional behavior change; a separate Enter is still
required. Successful tmux commands prove injection, not application submission.
The existing input heuristic is not a receipt; the natural false-empty trigger
remains unproven.

## Deferred periodic recovery

Pane/PID identity cannot distinguish a prompt from a dialog or human draft.
The existing screen parser cannot establish ownership of the original C4 input.
Blind periodic Enter may confirm dialogs, submit unrelated drafts or combine
messages. Disarming on the existing empty heuristic would recreate the original
false negative. Periodic scheduling and settings are removed until a reliable
draft-ownership and safe-UI-state contract is designed and validated. Historical
`C4_PERIODIC_ENTER_*` settings have no effect in this revision.

## Diagnostics

Structured logs include item ID/type, timestamps, paste bytes, Enter results,
detector branches and identity failures, without message text or tmux command
errors containing input. `C4_ENTER_CAPTURE_ENABLED=1` enables local snapshots
before normal verification; default off. These may contain secrets. The directory
is mode 0700, files 0600, capped at 100 files and 8192 capture characters per file.
Capacity stops collection without deleting old evidence. No scrollback or upload.
Geometry collection adds up to two 500ms command timeouts per observation.

## Verification

Run `node --test skills/comm-bridge/scripts/__tests__/delivery-target.test.js`
and existing dispatcher/capture tests. Wiring tests execute actual dispatcher
functions with controlled tmux/process responses for pane switches, replacements,
missing identity, retries and lifecycle exit. Historical CC/Codex live tests
cover bracketed paste. Historical timer tests do not establish ownership or
justify shipping recovery. No natural reproduction of issue #795 is claimed.
