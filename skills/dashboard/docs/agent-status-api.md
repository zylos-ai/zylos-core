# Agent status API

`GET /api/agent-status` is Dashboard's versioned, read-only contract for the
whole agent. Dashboard is the authority for these status and metric meanings;
external components should consume this endpoint instead of interpreting
activity-monitor files or treating Origin's `/api/state` fields as fleet totals.

## Authentication

Use the same authentication as `/api/state`. A Dashboard browser session or a
`read` (also `admin`) API session can read the endpoint. Exchange a configured
API key for a session token with `POST /api/auth/token`, passing
`Authorization: Bearer <api-key>`, then pass the returned token in the same
header to this endpoint. Without authentication the response is HTTP 401.
Other existing Dashboard authorization rules apply unchanged.

## Response

```json
{
  "schema_version": 1,
  "session_mode": "multi",
  "sampled_at": "2026-11-15T00:00:00.000Z",
  "state": "BUSY",
  "groups": { "running": 3, "busy": 1, "idle": 1, "waiting": 1,
    "unknown": 0, "error": 0, "no_response": 0 },
  "readiness": { "ready": true, "observable": true, "stage": "ready", "reason": "ready" },
  "runtime": { "runtime": "claude", "model": null, "model_id": null, "effort": null },
  "context_pct": null,
  "cost": { "session": null, "daily": 1.25, "weekly": 8.5 },
  "rate_limit_7d_pct": 25,
  "resources": { "scope": "container", "cpu_pct": 20, "mem_pct": 37.5,
    "mem_used_bytes": 300000000, "mem_total_bytes": 800000000,
    "disk_pct": 40, "disk_free_bytes": 2048000000 }
}
```

| Field | Meaning |
| --- | --- |
| `schema_version` | Integer contract version, currently `1`. Adding fields does not increment it. Removing fields or changing their meaning does. Consumers must tolerate unknown fields. |
| `session_mode` | `single` or `multi`; an unreadable/unknown mode falls back to `single`, as in CoreState. |
| `sampled_at` | ISO timestamp when this response was assembled. The contributing cached observations can be older; this is not a promise of simultaneous measurement. |
| `state` | In single mode, the existing `/api/state.state`. In multi mode, any Workbench summary `busy > 0` means `BUSY`; otherwise a readable list (`listKnown === true`) means `IDLE`; otherwise `UNKNOWN`. A readable list containing waiting, error or unknown groups still means `IDLE` when no group is busy. |
| `groups` | `null` in single mode. In multi mode, `running` and the six state counts from `fleetGroupSummary`; running includes starting sessions. If the list is unavailable counts can be zero; `state: UNKNOWN` distinguishes this from a known empty list. |
| `readiness` | `{ ready, observable, stage, reason }`, as defined below. `observable` is true at `session_ready` or `ready`, false at the lower stages. |
| `runtime` | The existing Dashboard runtime information projected to `runtime`, `model`, `model_id`, `effort`. In multi mode it describes Origin. Unavailable fields are `null`. |
| `context_pct` | Current session context percentage in single mode; `null` in multi mode because there is no whole-agent context window. |
| `cost.session` | Current session cost in single mode; `null` in multi mode. |
| `cost.daily`, `cost.weekly` | Existing Dashboard `getCostTiers()` totals: today and the seven-day window, aggregated across the agent. Same units and instance timezone as the Dashboard cost views; unavailable values are `null`. |
| `rate_limit_7d_pct` | Existing Dashboard account seven-day usage percentage (Claude or Codex), or `null` when unknown. |
| `resources.scope` | `container` when the existing cgroup reader finds controller limits; otherwise `host`. |
| `resources.cpu_pct` | Container CPU usage delta divided by quota cores, or existing host CPU delta percentage. `null` without a usable quota or sample pair. |
| `resources.mem_used_bytes` | Container working set (`memory.current - inactive_file` when available), or existing host total minus available memory. |
| `resources.mem_total_bytes`, `resources.mem_pct` | Container memory quota and working-set percentage, or host total and used percentage. Unlimited container quota means both fields are `null`; used bytes remain available. |
| `resources.disk_pct`, `resources.disk_free_bytes` | Existing `statfs` measurement on the Zylos directory's filesystem, regardless of CPU/memory scope. |

All numeric metrics can be `null` when unavailable. Container CPU/memory uses
the OpenMax cgroup v2 reader with its existing v1 fallback. The normal host root
cgroup does not expose `cpu.max` / `memory.max`; merely mounting cgroup v2 does
not imply container scope. An unlimited container still exposes these files and
retains `scope: container` with unknown quota-based percentages.
`/api/state.system_metrics` uses the same sample and includes `scope`; its other
existing fields retain their structure. Other `/api/state` meanings do not change.

## Session readiness

Both modes use CoreState session observations and runtime health. Single mode
uses its only session; multi mode uses Origin and its lifecycle view. It is independent of whole-agent busy/idle: Origin may be
busy while another group accepts work, and sleeping/waking Origin accepts work
through automatic wakeup. The following table is evaluated in order. Single mode has one additional rule:
a ready but busy session reports `ready: false`, `reason: busy`,
`stage: session_ready`. It does not trigger an online report while busy.
A ready idle session reports `ready: true`, `reason: ready`, `stage: ready`.

| Origin observation | Reason | Stage | Ready |
| --- | --- | --- | --- |
| Runtime health `auth_failed` | `health_auth_failed` | `runtime_down` | false |
| Lifecycle `auth_wait` | `auth_wait` | `runtime_down` | false |
| Lifecycle `need_unreadable` | `origin_need_unreadable` | `runtime_down` | false |
| Lifecycle `sleeping` | `sleeping` | `ready` | true |
| Lifecycle `waking` | `waking` | `ready` | true |
| Lifecycle `wake_overdue` | `wake_overdue` | `runtime_up` | false |
| Lifecycle `rate_wait` | `rate_wait` | `session_ready` | false |
| Origin observation/identity/status unavailable | `status_missing` | `runtime_down` | false |
| Identity changed during observation | `session_predates_launch` | `runtime_up` | false |
| Session absent (`not_running`) or starting | `no_session` | `runtime_up` | false |
| Invalid/unreadable/stale Origin status | Existing status-reader reason, or `status_missing` | `runtime_down` | false |
| No present, ready identity for this launch | `no_session` | `runtime_up` | false |
| Present and `identity.ready === true`, busy or idle (multi) / idle (single) | `ready` | `ready` | true |
| Present, ready and busy (single only) | `busy` | `session_ready` | false |

## Sampling and cost

No new timer is started. Requests reuse the existing CoreState refresh and its
in-flight coalescing, Workbench's two-second snapshot cache, account usage cache,
cost aggregation cache and SystemCollector's sampling cadence. CoreState
provides readiness observations in both modes. Single-session runtime health is
read only for an agent-status request, outside the one-second background refresh; there
is no separate readiness file reader or readiness timer. `/api/agent-status` does not sample system
resources or scan the full fleet again inside the Workbench cache window.

The endpoint reports readiness only. OpenMax retains ownership of onboarding
wait loops and online reporting. Its legacy file/session readiness rules remain
in OpenMax for Core 0.x; Dashboard does not import them.
