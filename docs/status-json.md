# Local operations status

`zylos status --json` is the local fallback for the
[Dashboard operations interfaces](../skills/dashboard/docs/api.md#operations-interfaces).
It prints one JSON object on one line. It reads observations; it does not start
sessions or repair configuration. Host PM2/disk information is only printed by
the text form, `zylos status`.

## Compatibility

During the 1.0 beta, these interfaces are not guaranteed to remain unchanged.
Starting with the next beta, the intent is to avoid major changes and preserve
backward compatibility for the interfaces and fields listed here: prefer adding
fields, without removing, renaming or changing the types of existing fields.
Necessary removals or changes will first be marked deprecated here and recorded
in CHANGELOG. Unlisted fields may still change. Consumers should tolerate extra
fields and distinguish `null` from a positive observation.

## Envelope

Success has exit code 0 and the shape `{ "ok": true, "data": { ... } }`.
Partial observation failures can still produce a successful envelope: inspect
the nullable fields, `presence` and health `source` before deciding an instance
is healthy. `ok` means the projection was collected, not that the agent is ready.

Failure has exit code 1 and the shape
`{ "ok": false, "error": { "code": "STATUS_UNAVAILABLE", "message": "...", "persisted": [] } }`.
Invalid arguments use `error.code: "INVALID_ARGUMENT"`. Errors have no `data`.
`error.code` is for programs; `message` is diagnostic text and may change.

## Operations Fields

All paths below are relative to `data` and are present on a successful response.

| Field | Type and meaning |
| --- | --- |
| `sessionMode` | `"single"`, `"multi"`, or `null` when the mode cannot be read. A configuration without a `session_mode` key means `"single"`. |
| `origin.presence` | `"running"`, `"starting"`, `"not_running"`, or `"unknown"`. A confirmed live session can still have an unreadable or stale status sample. |
| `origin.runId` | String or `null`; the observed process generation, absent when no live identity was read. |
| `origin.sessionId` | String or `null`; the observed runtime session identity. |
| `origin.status.state` | String or `null`; the current valid runtime sample's state (for example `"idle"` or `"busy"`). `null` means there is no current valid sample; it must not be treated as idle. |
| `runtimeHealth.claude.source`, `runtimeHealth.codex.source` | `"record"`, `"missing"`, or `"unreadable"`. |
| `runtimeHealth.claude.health`, `runtimeHealth.codex.health` | `"ok"`, `"auth_failed"`, `"rate_limited"`, `"unavailable"`, `"down"`, `"recovering"`, or `null`. `null` is used for a missing or unreadable record. |
| `runtimeHealth.claude.publicHealth`, `runtimeHealth.codex.publicHealth` | Same nullable string type; legacy `"down"` and `"recovering"` records are projected as `"unavailable"`. Missing and unreadable records are `null`. |
| `readAt` | ISO 8601 UTC string, for example `"2026-11-17T01:02:03.000Z"`; the time this local status read began. |

In single mode, `origin` describes the single runtime session. In multi mode it
describes the Origin group. A sleeping multi-mode Origin can legitimately be
`"not_running"`; presence alone is not a readiness check.

The JSON output converts timestamps and missing/default values at the output
boundary. Internal `collectStatus()` observations and the text status, attach and
doctor views retain their existing representation.
