# Recovery after unverified delivery

The dispatcher sends a best-effort `notify_delivery_failed` fact to the existing
supervisor socket only after a conversation's retry budget is exhausted and its
conditional `failDelivery` write changes the row to `failed`, with an
`ENTER_UNVERIFIED` error after paste. It does not change failure receipts or
requeue the failed message.

The version 2 fact carries `requestId`, `conversationId`, `sessionGroup` (null in
single mode), `runId`, `sessionId` (the runtime session, not the tmux session),
`runtime`, and `pastedAt` (Unix milliseconds). The receiver rejects malformed
facts, and acknowledges but ignores stale identities. Single-mode null scope is normalized to `origin` for supervisor
recovery gates. The supervisor rechecks the original run and runtime session,
existing recovery fences, current activity, transcript backlog, and unfinished
tools and active child agents immediately before stopping it. Any AI response
after the final paste or unfinished tool prevents the fast stop. `pastedAt`
is the final attempt's paste time: a response between earlier attempts that
ended before the final paste does not prevent this fast stop. The stop uses the
same path as the final no-response recovery step; normal dispatcher demand requests replacement startup.
Other groups and queued messages keep their normal delivery policy.

A process-local map reserves the current stopping run per group. Repeated facts
for that run cannot cause duplicate stops. A replacement run can immediately
qualify again after a new message fails: there is no cross-run restart limit,
background retry loop, or alert. The reservation map is owned by the supervisor:
dispatcher restart preserves it; supervisor restart loses it. A duplicate fact
could therefore permit another stop attempt after supervisor restart, but only
if its original run/session is still present and passes the activity gates.
No durable store or new health state is introduced. The existing 15-minute
silence plus 3-minute grace fallback remains available when the best-effort fact
is lost.
