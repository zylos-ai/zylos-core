# Memory dreaming

The supervisor starts an independent process once per calendar day. Set
`memory_dream_hour` with `zylos config set memory_dream_hour <0–23>` (default 02:00).
Use an early-morning hour. A daytime setting can assign messages from two calendar days to one diary date.
If a whole night is missed, its messages carry over and are recorded under the day before the next run.
The process catches up later the same day after downtime. A mode transition
defers the launch. The schedule, dates and weekly day use the workspace's
`.env` timezone. The memory snapshot remains scheduled at 03:00. Results from
a late dream enter the following snapshot.

Dreaming reads full delivered conversations and outgoing replies from C4, between
each group's checkpoint and delivered frontier. The first stage uses up to three
parallel calls without tools. Each receives up to 150 KiB of cleaned conversation
text. Outbound system notices advance coverage without appearing in model input.
Groups containing only system notices use a no-content checkpoint. The second
stage combines the validated results using a memory-scoped
read-only toolset and the existing fragment editor. Only after a second-stage
call exits successfully can first-stage batches advance their checkpoints.
A failed batch defers its group from that batch onward in both the second-stage
input and checkpoint coverage. A completed second
stage with invalid result JSON still advances coverage, and its unparsed reply
is recorded for inspection.

The process owns a lease, renews it every 30 seconds and can replace a lease
whose process has exited or whose heartbeat is more than two minutes old.
Every model edit checks the current lease and token. Model calls have
independent wall-clock limits of ten minutes for extraction, thirty minutes for
merging, sixty minutes for the weekly tidy review, twenty minutes per page condensing
call and ten minutes per header repair.
Each call can emit up to 64 MiB on stdout, including streamed tool results.
Repeatable call failures are retried twice, except header repair makes at most two calls.
A header that could not be repaired is reported once per night and checked again on a later run.
Writes already published by the models are retained.

The date supplied to the models and used for the diary is the calendar day
before the run. Daily records live in `activity-monitor/memory-dreaming/<date>/`. The script
writes accepted diary text to `memory/sessions/<date>.md`, appending it to any
existing session log. It sends proposals and alerts to `alert_target` and uses
Dashboard Origin once when the configured target is unavailable or unset. Diary size
has a 24 KiB soft limit.

Weekly tidy runs after a successful dream. Set the weekday with
`zylos config set memory_tidy_weekday <0–6>` (default 0, Sunday). It checks for
duplicate pages and reviews active pages unchanged for over 30 days. After
that review, the script archives completed and abandoned pages over 30 days
old. Then each page over 24 KiB, measured after that cleanup and largest first,
gets its own condensing call. The script saves the original in the archive and
inlines the page; the model returns a rewritten body that fits the limit. A
project page is rewritten as a short `## Current`, an overview of older results
and the recent results; a decision page keeps its dated sections. A body over
150 KiB, which some runtimes would cut in the middle, is split at entry starts
into parts of at most 120 KiB (an entry longer than a part is cut at line
ends); each part is first condensed to notes in its own call. Notes have a target size,
not a limit; when the notes together are still over 150 KiB they are split and
condensed again, and a round that does not shorten them stops condensing that
page. The final call rewrites the body from the notes. The script keeps the
header, writes the body only if the page did not change meanwhile, and reports
pages it could not condense; they are tried again the next week. A page moved
or shortened by a live session before its turn is left alone.
