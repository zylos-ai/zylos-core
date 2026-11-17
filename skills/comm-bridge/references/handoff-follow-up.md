# Handoff Follow-up

Preserve absorbed-message run ID, total/per-scope counts, first/last IDs, and the
full query/reply commands from the handoff. Read `c4-fetch.js --absorbed --run-id R
--summary` pages using `--scope-after` until nextScope is none. In multi mode,
Origin handles origin and sends each other scope an internal notice with R,
count and first/last IDs; each group verifies its own Pending and C4 history.
Origin verifies earlier internal notices and actual progress after replacement;
a repeated notice does not authorize repeating the underlying work. For repeated
mode switches, verify the switch archive before reusing a fixed-path recovery
file; report ambiguous references and retain unresolved work.
In single mode the sole session handles all * items. Read item pages with
`--after` and the returned next value, never ID arithmetic. Truncated or incomplete
pages are unread: retry with a smaller `--limit`. Use `--id N` for truncated item
previews; require the end line. Above 8192 text bytes use `--id N --out <file>`
and read the full file. Check actual progress before repeating work; an outbound
audit entry alone does not prove completion. Reply using the handoff's command
with `--absorbed-reply R N` and stdin, not a reconstructed display route.
SEND_FAILED means unknown delivery, so do not automatically resend.
ENDPOINT_NOT_PASSABLE or COMPONENT_SPAWN_FAILED must be reported to the owner;
continue other items. Preserve unfinished items on the next handoff. Sync removes
followed-up Pending entries through its normal commit, without changing C4.

