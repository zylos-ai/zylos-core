# Memory dreaming

The supervisor starts an independent process once per calendar day. Set
`memory_dream_hour` with `zylos config set memory_dream_hour <0–23>` (default 02:00).
The process catches up later the same day after downtime. A mode transition
defers the launch. The schedule, dates and weekly day use the workspace's
`.env` timezone. The memory snapshot remains scheduled at 03:00. Results from
a late dream enter the following snapshot.

Dreaming reads full delivered conversations and outgoing replies from C4, between
each group's checkpoint and delivered frontier. The first stage uses up to three
parallel calls without tools. Each receives up to 150 KiB of cleaned conversation
text. The second stage combines the validated results using a memory-scoped
read-only toolset and the existing fragment editor. Only after a second-stage
call exits successfully can first-stage batches advance their checkpoints.
A failed batch blocks coverage for its group at that batch. A completed second
stage with invalid result JSON still advances coverage, and its unparsed reply
is recorded for inspection.

The process owns a lease, renews it every 30 seconds and can replace a lease
whose process has exited or whose heartbeat is more than two minutes old.
Every model edit checks the current lease and token. Model calls have
independent wall-clock limits of ten minutes for extraction, thirty minutes for
merging and ten minutes for weekly tidy or a header repair. Repeatable call
failures are retried twice, except header repair makes at most two calls.
Writes already published by the models are retained.

Daily records live in `activity-monitor/memory-dreaming/<date>/`. The script
writes accepted diary text to `memory/sessions/<date>.md` and sends proposals
and alerts to `alert_target`, or Dashboard Origin when none is set. Diary size
has a 24 KiB soft limit.

Weekly tidy runs after a successful dream. Set the weekday with
`zylos config set memory_tidy_weekday <0–6>` (default 0, Sunday). It checks for
duplicate pages and reviews active pages unchanged for over 30 days. After
that review, the script archives completed and abandoned pages over 30 days
old. It saves the original of each page over 24 KiB before condensation. One
call handles up to five large pages, largest first, and each page is included
at most once per night.
