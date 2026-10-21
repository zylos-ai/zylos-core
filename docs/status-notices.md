# Runtime status notices

## Failure replies

For an eligible current-runtime quota StopFailure, AM records a reply intent in the same
transaction as its health evidence. C4 chooses the latest eligible dispatcher
delivery in that runtime generation, session and process. This is a latest
delivery policy, not proof that a shared Claude prompt belongs to only one
request. Multiple inputs can share a prompt. It does not fan out to every input.

The dispatcher records submission provenance separately from conversation
`delivered` bookkeeping. A message rejected at unhealthy intake cannot become a
first-failure target. Control messages and inputs without a reply endpoint are
also excluded. The exact original channel and endpoint are frozen; the sender
never selects a newer message while sending or retrying.

A fast failure can arrive before submission verification finishes. The intent
then waits up to 60 seconds for that exact delivery record. Uncertain, failed or
late verification suppresses the notice; it never falls back to an older input.
Missing scope proof defers sending. A confirmed scope change cancels the intent.
Old, malformed, missing-prompt and unordered post-recovery failures do not create
new first-failure intents. Billing errors require a verified full quota window
or an explicit quota-related diagnostic match. Other errors remain diagnostic;
they do not gain new first-failure notices from the historical 33-case table.

AM starts a bounded child worker for external sends, so channel I/O does not
block the AM event loop. First-failure and subsequent inbound replies share the
same conversation cooldown. The worker persists the claim reference before
sending, so a crash after a successful send does not cause replay after the
cooldown expires.

## Inbound replies

C4 rejects new input while the activity monitor reports an unavailable runtime.
It sends a fixed status message to the incoming channel and endpoint. The
endpoint key retains the conversation root and thread but omits individual
message, parent and request identifiers. Status reasons share one cooldown.

A durable claim precedes each send. Only a confirmed successful send starts a
600-second cooldown, measured from completion. A failure known to occur before
starting a sender permits a later input to try again. There is no retry loop.

A timeout, sender failure after launch, or process death during sending leaves
the result uncertain. C4 suppresses another attempt for that conversation and
health episode, including after restart. A verified new outage episode may
attempt again, subject to the shared success cooldown. This avoids replay when
the channel may already have delivered the message. It can also suppress a
notice that was never delivered. An expired claim that never started sending
can be reclaimed.

Legacy cooldown rows retain their original expiration. Their remaining window
is honored even when endpoint metadata was stored in a different order. These
historical reservations are not reclassified as verified delivery evidence.

An outbound audit row is not delivery confirmation. The generic sender timeout
cannot prove a channel child stopped; that uncertainty does not authorize a
second send. Rejected user work is not replayed automatically.

## Health evidence

Managed runtime launches carry a fresh generation ID. Supported Claude hooks
persist sanitized events and wake AM. Session, generation and Linux process
start proof must match before AM changes health. UUIDs and receipt timestamps
are not runtime turn sequence numbers. Ambiguous failures after verified
recovery request a controlled check instead of undoing recovery immediately.

A valid Stop while health is already OK establishes Hook authority. A conflicting
screen-only rate-limit observation is recorded but does not change health. Stop
does not clear an existing outage: it cannot prove ordering against a delayed
failure. SessionStart, UserPromptSubmit and tool completion do not prove recovery.
Old Hook authority does not carry into another generation, session or process.

Only rate_limit and authentication_failed directly establish corresponding
persistent states. Other error categories remain diagnostic unless the existing
recovery policy establishes unavailability. The status-line producer separately
captures sanitized quota snapshots with inherited generation, session, process
proof and receipt time. Hook collection freezes a matching snapshot no older
than 60 seconds into its event; AM never classifies an old failure using a newer
snapshot. Missing, stale or mismatched snapshots retain neutral wording.

Classification first excludes explicit warnings, temporary request limits and
nonquota diagnostics. Otherwise a proven exhausted five-hour/seven-day window
takes precedence over text refinement. Both full windows use the later valid
reset; if either full window has no reset, no time is claimed. Expired reset
values are not displayed. Windows below 100% do not prove a model quota.

The 33 source cases are matched only against bounded Hook diagnostic fields in
memory. Exact rule ID/kind, rather than raw diagnostic or assistant text, is
saved. Error details take precedence; unknown/oversized details do not cause
the matcher to mine unrelated assistant prose. Positive model/credits/cap text
refines only structured rate_limit or billing_error failures. Unmatched rate
limits remain neutral; an unproven billing error does not claim quota exhaustion.
See [matching rules](health-notice-matching.md) for all diagnostic cases.

The collector uses a Linux `flock` admission guard, file sync and atomic rename.
Exact pending duplicates coalesce. The spool admits at most 1000 unique records;
capacity exhaustion or admission failure leaves existing records intact and
emits a fixed diagnostic with `event_lost: true`. It cannot promise delivery
when storage is full. AM removes a spool only after database commit. A crashed
publication's complete temporary event is recovered under the admission lock.
Processed event rows expire after the five-minute replay window plus one minute;
pending rows and current evidence remain. Cleanup is bounded to 500 rows per
transaction. Terminal delivery/notice history is retained for seven days;
pending notice targets and the latest current delivery are protected.

## Compatibility and reporting

C4 schema version 2 adds formal adjacent migration tables for runtime deliveries,
health events/state, notice intents and send attempts. Historical databases and
user-added columns/tables are preserved. Older Core code cannot open the newer
schema; use the supported upgrade recovery workflow for rollback.

Hook registration is enabled for verified-compatible stable Claude 2.x versions
at or above 2.1.301. Unverified/older versions retain screen fallback. Managed
hooks converge on launch and settings sync, preserving custom hooks. Strong
Hook evidence currently requires Linux process proof and `flock`; unsupported
platforms do not gain that evidence path.

AM's atomic status file includes `health_episode`, `health_revision` and a
sanitized `last_hook` snapshot: event ID, event kind, allowlisted error, receipt
time and runtime generation. It never exports prompt/session text, diagnostics,
reply addresses or screen content. The snapshot is an observation, not a new
health authority or a guaranteed complete event stream.

ops-agent already reads the status file for generic health reporting. Forwarding
the new Hook fields and displaying them requires companion ops-agent/server/UI
changes; this Core change does not implement those integrations. Sending Hook
data over the network from the collector is deliberately avoided.

## Message configuration

AM routing and the C4 fallback use the same templates. Every notice contains
Chinese followed by English, prefixed with `Zylos`. A first-failure reply says the delivered
request could not complete; an inbound rejection says the new message did not
enter the queue. A reset time is an estimate from validated quota data, formatted
in UTC; it never clears health or promises automatic task replay.

Operators can configure `.zylos/config.json` and restart the affected processes
through the normal deployment workflow:

```json
{
  "statusNotices": {
    "brand": "Zylos",
    "templates": {
      "failure": {
        "quota_exhausted": {
          "zh": "当前服务暂时受限，本次请求未能完成，请稍后重新发送。",
          "en": "The service is rate-limited. This request could not complete. Please resend it later."
        }
      }
    }
  }
}
```

The two template contexts are `inbound` and `failure`, each with `zh` and `en`
text. Stable quota IDs are `quota_exhausted`, `quota_exhausted_reset`,
`model_quota_exhausted`, `usage_credits_required`, `usage_credits_exhausted`,
and `quota_allocation_unavailable`. These are Core template IDs; the source's
numbered 1-33 entries identify diagnostic rules, not templates. The reset template
supports `{resetAt}`, a validated epoch-millisecond time formatted in UTC.
Missing/expired/invalid reset values select `quota_exhausted` instead.

Existing `rate_limited`, `auth_failed` and `unavailable` category overrides remain
fallbacks. The earlier `language` switch is ignored: notices always include both
languages, with no sender identity or language detection. Overrides are complete message bodies;
the brand prefix is added separately. Missing or invalid values use defaults.
Brand text is limited to 80 characters and each localized body to 2000.
Runtime diagnostic text is never interpolated into messages. Product-specific
wording is operator configuration, not content accepted from an incoming user.
