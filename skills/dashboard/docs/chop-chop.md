# Chop-chop control

The status line shows the Zylos version, observed model and reasoning effort,
and runtime CLI version. Codex configuration and service tier remain available
to the existing backend consumers but are omitted from this line. Missing runtime
model or effort evidence is displayed as unknown rather than replaced by configuration.

`POST /api/actions/chop-chop` uses the existing authenticated Actions route:

1. Enqueue `[KEYSTROKE]Escape` through C4, as `interrupt` does.
2. After that command succeeds, wait 500ms.
3. Enqueue a C4 control with content exactly `continue`, without an ack suffix.

Both controls use priority 0 and bypass-state, matching the existing interrupt
mechanism. Success means both enqueue commands succeeded. It does not guarantee
runtime delivery, 500ms between runtime deliveries, or completion of resumed work.
The delay is measured after Escape enqueue succeeds. C4 remains responsible for delivery.

An Escape command failure prevents the continue command. A continue command failure
returns an error with `escape_enqueued: true` and `continue_enqueued: false`;
the earlier Escape cannot be undone. A command failure or timeout can have an
ambiguous enqueue outcome, so failure flags are not proof that C4 accepted no write.
The existing two-second identical-request protection applies to this action.
The old `interrupt` endpoint remains available; only its modal button is replaced.

Local and Fleet actions share the route and confirmation behavior. Tests use
isolated fixture controls and must not send these commands to the live agent.
