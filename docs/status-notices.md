# Runtime status notices

Complete scenario and bilingual-message reference:
[Current notice behavior](current-notice-behavior.md).

## Failure replies

For an eligible current-runtime StopFailure, AM stores health and a pending
first-failure reply in one atomic per-runtime file. At failure receipt it freezes
the latest inbound conversation in `running` or `delivered` with a reply endpoint.
This is the reviewer-selected latest-row policy, not proof that one prompt belongs
to one message or that a `running` input has already been submitted.
Unhealthy intake writes `failed`, including cooldown-suppressed and no-reply input.
The dispatcher remains the writer of `delivered` through `markDelivered()`.
Control messages and inputs without reply endpoints are excluded. Sending never
retargets the frozen original channel and endpoint. No delivery table is created.

Old, malformed and unordered post-recovery failures do not create
new first-failure intents. Billing errors require a verified full quota window
or an explicit quota diagnostic before claiming exhausted quota; otherwise they
get factual billing-error copy. Authentication, model, service and unknown
failures receive their corresponding factual first reply. These replies do not
by themselves establish persistent unavailability.

AM starts a bounded child worker for external sends, so channel I/O does not
block the AM event loop. First-failure and subsequent inbound replies share the
same channel, normalized endpoint, health and reason cooldown. AM owns the
pending reply state; channel I/O stays outside its event loop. A pending first
reply may be lost in a crash; the next inbound message still receives the
unavailable response while the runtime remains unhealthy.

## Inbound replies

C4 rejects new input while the activity monitor reports an unavailable runtime.
It sends a fixed status message to the incoming channel and endpoint. The
endpoint key retains the conversation root and thread but omits individual
message, parent and request identifiers. Distinct health/reason pairs have
separate cooldowns so changed failures can be reported immediately.

A durable 600-second reservation precedes each send. Confirmed success retains
600 seconds measured from completion. A failure known to occur before starting
a sender releases the reservation so a later input can try again. There is no retry loop.

A timeout, sender failure after launch, or process death during sending leaves
the result uncertain. C4 retains the existing cooldown reservation instead of
clearing it. A new inbound request may produce a notice after that reservation
expires; there is no permanent per-episode suppression. A first-reply send is
not automatically retried. Diagnostic attempts are appended to
`activity-monitor/status-notices.log`, rotated at 100 KB. This log does not
participate in resend decisions. No attempt table is created.

Legacy cooldown rows retain their original expiration. Their remaining window
is honored even when endpoint metadata was stored in a different order. These
historical reservations are not reclassified as verified delivery evidence.

An outbound audit row is not delivery confirmation. The generic sender timeout
cannot prove a channel child stopped; that uncertainty does not authorize a
second send. Rejected user work is not replayed automatically.

## Health evidence

Supported Claude hooks append sanitized health events to the existing
`tool-events.jsonl` stream. AM validates the managed tmux pane's Claude PID,
Linux process start proof and session. There is no generation file or launch
environment token. Ambiguous failures after verified
recovery request a controlled check instead of undoing recovery immediately.

A valid Stop while health is already OK establishes Hook authority. A conflicting
screen-only rate-limit observation is recorded but does not change health. Stop
does not clear an existing outage: it cannot prove ordering against a delayed
failure. SessionStart, UserPromptSubmit and tool completion do not prove recovery.
Old Hook authority does not carry into another session or process.

Only rate_limit and authentication_failed directly establish corresponding
persistent states. Other error categories remain diagnostic unless the existing
recovery policy establishes unavailability. The status-line producer separately
captures sanitized quota snapshots with verified session and process
proof and receipt time. Hook collection freezes a matching snapshot no older
than 60 seconds into its event; AM never classifies an old failure using a newer
snapshot. Missing, stale or mismatched snapshots retain neutral wording.

Classification checks structured error type and proven exhausted five-hour/seven-day
windows before text refinement, including warning/temporary/excluded diagnostic
matches. Both full windows use the later valid
reset; if either full window has no reset, no time is claimed. Expired reset
values are not displayed. Windows below 100% do not prove a model quota.

The 33 source cases are matched only against bounded Hook diagnostic fields in
memory. Exact rule ID/kind, rather than raw diagnostic or assistant text, is
saved. Error details take precedence; unknown/oversized details do not cause
the matcher to mine unrelated assistant prose. Positive model/credits/cap text
refines only structured rate_limit or billing_error failures. Unmatched rate
limits remain neutral; an unproven billing error receives billing-error wording
without claiming quota exhaustion. Other structured errors select their factual
template independently of the historical quota text rules.
See [matching rules](health-notice-matching.md) for all diagnostic cases.

Health and pending reply state live in
`activity-monitor/runtime-health/<runtime>.json`, atomically published using
temp-file, fsync and rename. Stop/StopFailure processing saves a single
`received_at` high-water mark in the same write. Only strictly newer terminal
events can be processed; event IDs are diagnostic only. SessionStart and
UserPromptSubmit do not advance this marker. No event-ID set is retained.
The five-minute freshness and process checks still apply. Equal timestamps,
replays and sufficiently backward clock steps can suppress an event; this is
an accepted simplicity tradeoff, with screen detection remaining the fallback.
Health is committed before the event-stream cursor advances so a restart,
cursor reset or rotation replay is handled by the durable time marker.

## Compatibility and reporting

This change does not alter C4 schema version 1 or create health, delivery or
notice tables. Instances that installed an earlier experimental revision of
this PR may already have schema 2. They must not be silently downgraded or have
their tables deleted. Treat adoption on such an instance as a separate protected
recovery/migration operation; preserve backups and existing data. The normal
schema-version guard remains in force.

Hook registration is enabled for stable Claude versions at or above 2.1.78,
the [official introduction of StopFailure](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2178).
Older, prerelease and unknown versions retain screen fallback; 3.x is supported.
Managed hooks are registered during settings synchronization, not every launch.
After independently changing the Claude CLI version, run the hooks sync step
before starting the next session. Custom hooks are preserved. Strong
Hook evidence currently requires Linux process proof; unsupported
platforms do not gain that evidence path.

AM's atomic status file includes `health_episode`, `health_revision` and a
sanitized `last_hook` snapshot: event ID, event kind, allowlisted error, receipt
time. It never exports prompt/session text, diagnostics,
reply addresses or screen content. The snapshot is an observation, not a new
health authority or a guaranteed complete event stream.

ops-agent already reads the status file for generic health reporting. Forwarding
the new Hook fields and displaying them requires companion ops-agent/server/UI
changes; this Core change does not implement those integrations. Sending Hook
data over the network from the collector is deliberately avoided.

## Message configuration

AM routing and the C4 fallback use the same templates. Every notice contains
Chinese followed by English, prefixed with `Zylos`. A first-failure reply says the selected
request could not complete; an inbound rejection says the new message did not
enter the queue. A reset time is an estimate from validated quota data, formatted
in the configured time zone; it never clears health or promises automatic task replay.

Operators can configure `.zylos/config.json` and restart the affected processes
through the normal deployment workflow:

```json
{
  "statusNotices": {
    "brand": "Zylos",
    "timeZone": "Asia/Shanghai",
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
and `quota_allocation_unavailable`. Factual nonquota IDs are `model_unavailable`,
`billing_error`, and `service_error`; baseline IDs are `auth_failed`,
`rate_limited`, and `unavailable`. These are Core template IDs; the source's
numbered 1-33 entries identify diagnostic rules, not templates. The reset template
supports `{resetAt}`, a validated epoch-millisecond time formatted with an explicit
IANA time-zone label. `timeZone` defaults to the host zone; invalid zones use UTC.
Missing/expired/invalid reset values select `quota_exhausted` instead.

Overrides use only the selected ID. A generic `rate_limited` override cannot
replace an identified `quota_exhausted_reset` message. The earlier `language`
switch is ignored: notices always include both
languages, with no sender identity or language detection. Overrides are complete message bodies;
the brand prefix is added separately. Missing or invalid values use defaults.
Brand text is limited to 80 characters and each localized body to 2000.
Runtime diagnostic text is never interpolated into messages. Product-specific
wording is operator configuration, not content accepted from an incoming user.
