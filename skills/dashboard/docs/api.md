# Dashboard API Reference

## Module Responsibilities

This reference describes Dashboard HTTP routes, including health, instance, session groups, usage, memory, schedules, settings, chat, terminal history, Fleet and push. Any PR that changes an API documented here must update this file in the same PR. Check methods, paths, parameters, permissions, fields and errors against the implementation, rather than copying a design proposal.

Collection endpoints follow the [list API standard](list-api-standard.md) for paths, filters, paging, cursors, errors, ordering and cost. This file documents each concrete route.

Paths are relative to the Dashboard base URL. For example, with the default HTTP mount, `/api/instance` is available at `/dashboard/api/instance`. Group IDs are URL-encoded session-group keys such as `telegram%3Aexample`, or `origin` for the single session and the multi-session Origin. Display names are not IDs.

## Runtime Descriptors Asset

`GET /_assets/runtime-descriptors.js` serves the installed Core runtime registry as a JavaScript module. The request takes no parameters and does not require authentication. It returns 200 with `Content-Type: text/javascript; charset=utf-8`, `Cache-Control: no-cache`, and an ETag. A matching `If-None-Match` returns 304. An unresolved Core directory or missing descriptor file returns 404.

Example request in a Dashboard mounted under a reverse-proxy prefix:

```http
GET /dashboard/_assets/runtime-descriptors.js
```

Fleet views load the local module through `/fleet/:name/_assets/runtime-descriptors.js` under the same base prefix.

## Access and Common Results

- **Public**: no login required.
- **Read**: an authenticated browser session or an API session with `read` or `admin` scope. An API key must first be exchanged for an API session through the existing authentication API.
- **Admin**: an authenticated administrator. Browser-cookie writes also require a same-origin request. Read-scope API sessions cannot write or read conversation content, attachments or full terminal history.
- **Local owner**: an administrator logged in with the local password cookie. API keys do not grant deletion or deletion-preview access, even with admin scope.
- **Local only**: answered only by the instance's own Dashboard, never through the Fleet proxy. A request to `/fleet/:name/...` for one of these routes returns 403 `local_endpoint_not_proxyable`. This covers `/api/keys` and everything under it, `/api/fleet/agents` and everything under it, `/api/session-hosts` and its channel options, `/api/instance/name`, and writes to `/api/settings/chat`. Local only says nothing about the credential: called directly on the instance, these routes keep their own access level (for example admin for `/api/keys`, local owner for `/api/session-hosts`).

### API key scopes

An API key's scope is `read`, `admin`, or a custom list of permissions. Read and admin keep the boundaries described above. A custom key may use only the routes its permissions name in the table below; any other route, including routes added later, returns 403 `insufficient_scope` with `required` set to the missing permission, or to `admin` for a route no custom key can use. HEAD and OPTIONS count as GET. Route descriptions in this document that say Admin or Read also admit a custom key holding the route's permission.

| Permission | Routes |
|---|---|
| `instance.read` | `GET /api/instance`, `/api/instance/resources`, `/api/instance/runtime-options`, `/api/instance/core-update`, `/api/instance/avatar`; `GET /api/stream` without `chat`; the signed-in details of `GET /api/health`; `GET /api/settings/timezone`, `/api/settings/pricing`, `/api/settings/chat` |
| `instance.settings` | `PUT /api/instance/defaults`, `PUT /api/instance/name`, `PUT /api/settings/pricing`, `PUT /api/settings/timezone`, `POST /api/instance/actions/recheck-runtime-cli` |
| `instance.ops` | `POST /api/instance/actions/switch-mode`, `switch-runtime`, `upgrade-runtime`; `POST /api/settings/timezone/actions/restart-services` |
| `groups.read` | `GET /api/groups`, `/api/groups/counts`, `/api/groups/activity`, `/api/groups/:id`, `/api/groups/:id/runs`, `events`, `messages`, `backlog`, `usage`, `/api/groups/:id/restarts/:requestId` |
| `groups.control` | `POST /api/groups/:id/actions/restart`, `interrupt`, `chop-chop` |
| `groups.settings` | `PUT /api/groups/:id/config`, `PUT` and `DELETE /api/groups/:id/name`, `POST /api/groups/naming-prompt` |
| `usage.read` | `GET /api/usage/summary`, `/api/usage/series`, `/api/usage/pricing` |
| `memory.list` | `GET /api/memory/entries`, `/api/memory/backlog` |
| `memory.read` | `GET /api/memory/file`, `/api/memory/git` |
| `memory.write` | `PUT /api/memory/file` |
| `schedules.read` | `GET /api/schedules`, `/api/schedules/preview`, `/api/schedules/:id`, `/api/schedules/:id/history` |
| `schedules.write` | `POST /api/schedules`, `PUT` and `DELETE /api/schedules/:id`, `POST /api/schedules/:id/actions/pause`, `resume` |
| `conversations.read` | `GET` under `/api/conversations` (list, conversation, messages, status, activity, questions, attachments, upload configuration); `GET /api/stream?chat=1` |
| `conversations.write` | `POST`, `PUT` and `PATCH` under `/api/conversations` (send, answers, uploads, drafts, pins, read position, rename) |
| `terminal.read` | `GET /api/observer/status`, `GET /api/observer/history/...` |
| `terminal.control` | `/observer/frame`, `/observer/stream`, `/api/observer/leases` and everything under it, `POST /api/observer/agent-size`, `POST /api/observer/install`, `enable`, `disable`, `DELETE /api/observer/install` |
| `fleet.read` | `GET /api/fleet` |

Conversation and terminal permissions still need the remote access switch (`chat_allow_remote`): a custom key holding the permission gets 403 `remote_chat_disabled` while the switch is off, as an admin key does; a key without the permission gets `insufficient_scope` first, as a read key does. No custom key can use `/api/keys`, `PUT /api/settings/chat`, `/api/fleet/agents`, `/api/session-hosts`, deletion or deletion previews, or the `/fleet/:name/...` proxy (the proxy reaches the other machine with the key saved at registration, which may be admin). Fleet shows a remote machine registered with a custom key as read access.

The scope is stored as `read`, `admin`, or the permission names deduplicated, sorted and joined with commas (for example `groups.control,groups.read`). The same string is used by the API, the `api-key.js` CLI and `GET /api/keys`. Every request is judged by the key's current scope: after a change, the next request with an existing token follows it, and open pushes, terminal leases and streams that no longer hold their permission are closed at their next check.

No API key, admin included, can create an admin key, change any key to admin, change an admin key's scope, rotate an admin key (rotation returns a new admin key), or turn remote access on or off (`PUT /api/settings/chat`); these return 403 `local_cookie_required`. Admin keys can still list keys, create, rotate, change, revoke and delete other keys, revoke and delete admin keys, and purge revoked keys. The local password session can do all of these. The CLI writes the local database directly and is not limited by this rule.

Every route that is not Public requires sign-in. There is no setting that turns sign-in off: an `auth.enabled` value left in the Dashboard `config.json` is ignored. Without a configured password nobody can sign in: protected API requests (`/api/...`, including `POST /api/auth/token`, Fleet API paths `/fleet/:name/api/...` and the Observer frame and stream) return 401 `unauthorized`; protected pages redirect (302) to `/login`; and `/login` shows a prompt to run `zylos dashboard reset-password` instead of a password field, with 200 for `GET`/`HEAD` and 503 for `POST`.

The existing auth gate may return HTTP 401 (unauthenticated) or 403 (`insufficient_scope`). Browser writes can return 403 `same_origin_required`. Invalid JSON returns 400 `invalid_json`, and oversized JSON bodies return 413 `payload_too_large`; body limits are route-specific (4 KiB for object actions/timezone/names/keys, 16 KiB for pricing/Fleet config, 64 KiB for schedule forms; chat and memory have their own limits). Removed routes and unsupported API method/path pairs return 404 `not_found` (including a known path called with the wrong method). Login/logout retain HTTP 405 for unsupported methods. JSON failures use the common envelope.

Read APIs return their data object directly. Successful JSON writes return `{ok:true,...result}`. All JSON failures, including Core rejections, use `{ok:false,error:{code:string,message:string}}` and an appropriate non-2xx status. Authentication exchange bootstraps API access with the supplied key; login/logout retain their HTML/redirect protocol. Binary downloads, HTML and upgraded streams retain their own content type. A successful submission is not proof that a session restarted or that an instruction was delivered. Do not automatically repeat a write whose result is unknown.

HTTP handlers select their status explicitly. The common serializer normalizes bodies when the HTTP status is already an error or a write explicitly returns `ok:false`, and adds `ok:true` to successful writes; it does not interpret diagnostic read fields as command outcomes. Numeric internal HTTP `status` fields are removed from write bodies. Command-envelope interpretation is opt-in at these adapter boundaries: instance/default actions, group configuration/actions, group/draft deletion, timezone service restart and scheduler writes. Those adapters recognize Core `{ok:false}` and scheduler `{result:"rejected"|"unknown"}` failures, map their declared codes to HTTP status, and convert scheduler `result:"done"` to write success. Supervisor restart `result:"stale_target"` becomes HTTP 409 `stale_target`, retaining `currentRunId`. Interrupt/chop-chop Core rejections return HTTP 409: `TARGET_MISMATCH` when `runId` is stale, or `STALE_TARGET` when `runId` is current but `sessionId` is stale. The latter sets both `error.code` and `rejectionCode` to `STALE_TARGET`, with message `The target session has changed` and `currentRunId:null`. Unknown command failures map to 502; `control_target_required` maps to 503. Read payload `status`, `result`, `reason`, `code` and `ok` fields otherwise remain data.

Every public absolute timestamp is an ISO 8601 string with a timezone designator (UTC `Z`), or `null` when unknown. This includes `readAt`, `sampledAt`, activity starts, scheduler task/execution times and the equivalent push fields. Durations, counts and opaque continuation values retain their numeric types. Unknown measurements are `null`, rather than zero.

The same ISO projection applies to HTTP and SSE. Server serialization and browser calculation adapters share the explicit catalogue in `public/js/wb/wire-time.js`; zero and empty source clocks become `null`. The declared absolute-time fields include:

| Family | ISO fields (nullable when the source is unknown) |
|---|---|
| Instance / health | `startedAt`, resource `sampledAt`, account `recordedAt` and reset time, runtime-health `cooldownUntil`/`updatedAt`, transition creation/update, blocked `since`, diagnostic `ts`, source-health `updated_at` |
| Groups / activity | `readAt`, `lastActivityAt`, state `since`/`sampledAt`, lifecycle `createdAt`, fences, working/main/subagent times, pending queue `oldestAt`, wait `since`/`lastAt`/`cooldownUntil`, preview `timestamp`, name update, run start/end, event/message timestamps (including event `metadata.pasted_at`), heatmap `start` and inbound times |
| Schedules | `readAt`, task `nextRunAt`/`lastRunAt`/`updatedAt`, execution `executedAt`/`completedAt`, preview `iso` and next-run arrays, returned CLI task time columns |
| Chat / terminal | Conversation creation/update, list `stamp`, message and quote timestamps, activity `now`/`from`/step/subtask/awaiting times, upload/lease `expiresAt`, transcript-session start/update and entry `ts` |
| Fleet / keys / memory | Fleet observation/link/problem times and nested instance fields, key creation/use/revocation, file `mtime`, Git `commit.author_date` and backlog `firstAt` |

The examples below show request methods, URLs and JSON bodies. Supply the appropriate cookie or API-session authorization header; example writes are illustrative and should only be issued with authorization for their effects.

## Operations Interfaces

These are the interfaces and fields intended for operations clients, including Fleet and OpenMax. During 1.0 beta there is no guarantee that APIs will remain unchanged. Starting with the next beta, the aim for this list is to add fields without removing, renaming or changing the types of existing fields, and to avoid major changes where possible. A necessary removal or incompatible change should first be marked **deprecated** here and recorded in CHANGELOG. Interfaces and fields outside this list may continue to change. This is a compatibility policy, not an immutability guarantee.

Use the spelling below as returned: `session_mode` and `sessionMode` intentionally coexist. Both Dashboard mode fields report the effective mode, so an instance without a `session_mode` key reports `"single"`; this intentionally differs from `zylos status --json`, which reports `null` for a missing key. Read responses are data objects, not `{data:...}` wrappers. Nullable observations must not be interpreted as healthy or absent.

| Method / path | Access | Operations fields |
|---|---|---|
| `GET /api/health/ready` | Public | `ready:boolean`, `reason:"supervisor_unavailable"\|null`, `session_mode:"single"\|"multi"\|"unreadable"`, `session_running:boolean\|null`; `runtime_health.claude`, `.codex` and `.agy` each contain `source:"record"\|"missing"\|"unreadable"`, `health:"ok"\|"auth_failed"\|"rate_limited"\|"unavailable"\|"down"\|"recovering"\|null` |
| `GET /api/health` | Public | `ok:boolean`, `service:string`, `bootId:string` identifies this Dashboard process and changes when it restarts |
| `POST /api/auth/token` | Public credential exchange | Bearer `zylos_ak_...` key returns `ok:true`, `token:string` (`zylos_st_...`), `expires_at:string` (ISO), `ttl_seconds:number` (86400), `scope:string` (`read`, `admin` or a custom permission list, see [API key scopes](#api-key-scopes)) |
| `GET /api/instance` | Read | `agent.name:string`, `agent.avatar_version:string|null`, `default_runtime:string`, `session_mode:object` with `sessionMode:"single"\|"multi"\|"unreadable"`; see [instance fields](#get-apiinstance) for additional observations |
| `GET /api/groups/origin` | Read | `presence:"running"\|"starting"\|"not_running"\|"unknown"`, `state.kind:"working"\|"idle"\|"starting"\|"stopping"\|"offline"\|"unknown"`, `flags:object`, `run:{runId:string\|null,sessionId:string\|null,createdAt:string\|null}\|null` |
| `POST /api/groups/origin/actions/interrupt` | Admin | JSON `{runId:string,sessionId?:string\|null}`; result fields described below |
| `POST /api/groups/origin/actions/chop-chop` | Admin | Same target body as interrupt; result fields described below |
| `POST /api/groups/origin/actions/restart` | Admin | JSON `{runId?:string,sessionId?:string\|null}`; result fields described below |
| `GET /api/groups/counts` | Read | `readAt:string` (ISO), `listKnown:boolean`, `running:{total:number,states:object,flags:object}`, `offline:{total:number,waitingSlot:number,startFailed:number}`, `pool:{used:number\|null,capacity:number\|null}\|null` |
| `GET /api/usage/summary` | Read | `tz:string`, `tzFallback:boolean`, `scope:"all_groups"`, `today:object`, `sevenDay:object`; period and runtime fields described below |

Readiness returns **HTTP 503 when not ready**, with `ready:false`, `reason` and all the other listed readiness fields still present in the JSON body. Read this body as observation data even on 503. `session_running` is reserved and always null. A supervisor response establishes readiness in every mode, including before migration. Runtime health is diagnostic and does not itself determine readiness; missing/unreadable health is null. `/api/health` only establishes HTTP liveness. Use `/api/health/ready`, never the retired `?probe=ready` query.

Exchange the API key once and **cache/reuse the 24-hour session token** as `Authorization: Bearer zylos_st_...`. Every exchange creates a new session and compares the presented key against active keys; exchanging on every request adds unnecessary sessions and key verification work. An API key itself does not authorize data requests. Use a read key for observations and an admin key for Origin actions.

Origin detail exposes `presence:"running"|"starting"|"not_running"|"unknown"`, `state.kind:"working"|"idle"|"starting"|"stopping"|"offline"|"unknown"`, `flags:object`, and `run:{runId:string|null,sessionId:string|null,createdAt:string|null}|null`. Origin flags are optional independent entries, not booleans; an absent entry means that flag was not observed. The supported entries are `queued:{count:number,oldestAt:string|null,waitSeconds:number|null}`, `blocked:{reason:"auth_failed"|"rate_limited",runtime:string|null,recoveryAt:string|null}`, `waitingSlot:{position:number}`, `startFailed:{count:number,lastAt:string|null,reason:string|null}`, `unreadable:{reasons:string[]}` and `noResponse:{since:string|null}`. Counts use numeric entries for every running state (`working`, `idle`, `starting`, `stopping`, `unknown`) and every flag (`queued`, `blocked`, `waitingSlot`, `startFailed`, `unreadable`, `noResponse`).

Controls target `origin` in both configured modes; instances without a `session_mode` key retain the empty legacy target. The page's optional `sessionGroup` value follows the public view: `origin` in multi, `null` in single, including native single. A mismatching value returns `TARGET_SCOPE_MISMATCH`. Before interrupt or chop-chop, read Origin and send its current `run.runId`; both actions require a nonempty `runId` in both modes. If `run` or `runId` is null, a target has not been established. Passing the observed `sessionId` additionally binds the session. Restart allows an omitted `runId` (including a stopped Origin); pass the observed identity when targeting a particular run. Refresh after a target rejection. For example: `POST /api/groups/origin/actions/interrupt` with `{"runId":"observed-run","sessionId":"observed-session"}`.

Action results expose `ok:boolean` and, **when applicable to that outcome**, `submission:string`, `requestId:string`, `controlId:number|null`, `currentRunId:string|null`, `rejectionCode:string|null`, and `error.code:string`. Interrupt/chop-chop use `submission:"submitted"|"rejected"|"unknown"`; restart uses `"accepted"|"rejected"|"not_submitted"|"unknown"`. Missing-target validation can return only the common error envelope. A stale run may return HTTP 409 `TARGET_MISMATCH` (controls) or `stale_target` (restart), retaining the current identity when available. `messageKey`, `messageParams` and `message` are UI text and **are not part of this compatibility list**, including `error.message`. Submission is not delivery or restart completion; do not blindly retry an unknown result.

Each usage period contains `since:string`, `until:string` (ISO), `tokens:number`, `inputTokens:number`, `outputTokens:number`, `cacheReadTokens:number`, `cacheHitRate:number|null`, `cost:number`, and `byRuntime:object` with `claude` and `codex` entries containing the same numeric usage fields (without period boundaries). Windows follow the instance time zone. Unknown ratios are null, including an empty window.

For a local fallback, see [`zylos status --json`](../../../docs/status-json.md), including its `{ok,data}` envelope and ISO `readAt`. It does not replace HTTP authentication or action submission.

## Health

### GET /api/health

**Access:** Public. **Parameters:** none.

Returns `ok:boolean` (true), `service:string` (`zylos-dashboard`) and `bootId:string` (unique to this Dashboard process). Authenticated callers additionally receive `startedAt:string`, `uptimeSeconds:number`, `event_loop:object` (event-loop diagnostics) and `source:object` (Core source health). The source object contains `runtime_progress` (JSONL usage; Antigravity reports `fresh:false`, `age_s:null`, `status:"unsupported"`, `capability:"unsupported"`, `reason:"unsupported"`, `detail:"Not supported for this runtime"` because usage collection is not integrated), `collector_liveness` (PM2, system, conversation and supervisor heartbeat), and an empty `platform` object. Legacy statusline health entries are omitted even when their database rows remain. Response varies by `Cookie` and `Authorization`. HTTP 200 means this HTTP service is alive; it does not establish runtime readiness.

**Errors:** 404 `not_found` for the retired `probe` query. Readiness is available only at `/api/health/ready`.

Example: `GET /api/health` → `{"ok":true,"service":"zylos-dashboard","bootId":"example-boot"}`.

### GET /api/health/ready

**Access:** Public. **Parameters:** none.

Returns `ready:boolean`, `reason:string|null`, `session_mode:"single"|"multi"|"unreadable"`, `session_running:boolean|null`, and `runtime_health:object` keyed by `claude`, `codex` and `agy`. Each runtime entry has `source:"record"|"missing"|"unreadable"` and `health:string|null`. A responsive supervisor establishes readiness in every mode, including instances without a `session_mode` key. `session_running` is reserved and always `null`. Runtime health is diagnostic.

**Errors:** HTTP 503 with `{ok:false,error:{code,message},...readiness}` when `ready:false`; `reason` is `supervisor_unavailable`. Unavailable observations remain null.

Example: `GET /api/health/ready` → `{"ok":false,"error":{"code":"supervisor_unavailable","message":"supervisor_unavailable"},"ready":false,"reason":"supervisor_unavailable","session_mode":"multi","session_running":null,"runtime_health":{"claude":{"source":"missing","health":null},"codex":{"source":"missing","health":null},"agy":{"source":"missing","health":null}}}`.

## Instance

### GET /api/instance

**Access:** Read. **Parameters:** none.

| Field | Type | Meaning |
|---|---|---|
| `agent` | object | Configured instance identity, including `name:string`, generated color fields, and `avatar_version:string|null`. The version is a SHA-256 hex digest when configured |
| `tz` | string | Instance time zone used for display and usage calendar windows |
| `session_mode` | object | Core mode and transition state, described below |
| `default_runtime` | string | Configured default runtime |
| `operation_in_progress` | object / null | The default-runtime switch or runtime CLI upgrade this Dashboard is running: `{action:"switch-runtime"\|"upgrade-runtime",runtime:string,started_at:string}` (`started_at` is ISO 8601 UTC), or null when none runs. See [one runtime operation at a time](#one-runtime-operation-at-a-time) |
| `defaults` | object | Runtime-keyed default objects described below |
| `versions` | object | Runtime-keyed `zylos`, `claude`, `codex`, `agy` objects: `{installed:string\|null,latest:string\|null,update:string\|null}`; `update` identifies an available newer version. Antigravity includes `update_check:"unsupported"` |
| `runtimeHealth` | object / null | Runtime-keyed health observations, including health and cooldown evidence |
| `accounts` | object / null | Runtime-keyed weekly account quota objects or null; observations include used percentage, reset time, `recordedAt` and `live` |
| `supervisorPaused` | boolean / null | Whether new supervisor actions are paused |
| `autoRestarts` | object / null | `{count:number}` automatic restarts recorded during the past hour |
| `resources` | object | One current resource sample: `scope:"host"\|"container"\|"mixed"`, `sampledAt:string\|null` (ISO), `cpu_pct:number\|null`, `cpu_count:number\|null`, `cpu_source:"container"\|"host"`, `mem_pct:number\|null`, `mem_used_bytes:number\|null`, `mem_total_bytes:number\|null`, `mem_source:"container"\|"host"`, `disk_pct:number\|null`, `disk_free_bytes:number\|null`, `disk_total_bytes:number\|null` |
| `services` | object / null | PM2 counts `online:number`, `total:number`, plus `channels:Array<{channel:string,service:string,status:string\|null,restarts10m:number,lastSendFailed:boolean\|null,consecutiveFailures:number\|null}>`. Channels come from installed skill frontmatter `type: communication` and `lifecycle.service.name`, and must exist in the PM2 sample. `restarts10m` sums observed counter increases in the last ten minutes, beginning at zero on Dashboard startup. Send fields describe the latest C4 outbound status and failures after the latest successful outbound; null means the C4 read failed. A latest failed outbound more than 24 hours old reports `lastSendFailed:false` and `consecutiveFailures:0`; a newer failure brings the alert back, counting every failure since the latest successful outbound. |

The `defaults` keys are `claude`, `codex` and `agy`. Antigravity has no configurable model/effort override, so its default `model` and `effort` are null. Its rotation threshold follows the one-million-token policy (20% default). Antigravity reports its installed version from `agy --version` when available. Its `latest` and `update` are null and `update_check` is `"unsupported"`. A missing or failed probe retains the last installed version. For `versions.zylos`, `latest` and `update` follow [core-update](#get-apiinstancecore-update): the newest stable release within the installed major version.

Each `defaults[runtime]` contains `model:string|null`, `effort:string|null`, `threshold:number`, `model_thresholds:Record<string,number>` and `session_hot_ttl:object` (effective mode, keepalive seconds and configuration/environment provenance). CPU and memory limits are resolved independently: a limited resource uses its container quota, while an explicitly unlimited resource uses host values and labels that resource’s source `host`. `scope` is `mixed` when the two sources differ, otherwise it is their common source; each resource’s source remains authoritative. An unreadable container limit keeps that resource’s source `container` with unknown measurements rather than implying unlimited host fallback. CPU percentages use the selected CPU capacity (which can be fractional); memory percentages use the selected total bytes. Disk describes the filesystem visible at the instance data directory and is independent of the CPU/memory scope. Unreadable observations remain null. There is no duplicate `system` sample or `runtime_info` object. Origin’s current model, effort, running CLI version and restart-to-apply status belong to group detail; instance versions and defaults describe installed software and configuration. Session context, cost and pool counts belong to the group and usage APIs.

`session_mode` carries Core’s existing status envelope:

| Field | Type / meaning |
|---|---|
| `sessionMode` | `"single"\|"multi"\|"unreadable"`: the effective mode. Without a `session_mode` key the instance runs as `"single"`; `"unreadable"` means the configured mode could not be established. Dashboard versions before this change reported `null` for unreadable, so readers treat `null` and `"unreadable"` alike as unknown |
| `transition` | null or `{runId,sourceMode,targetMode,phase,cutoff,reason,createdAt,updatedAt}`, preserving Core's transition record |
| `globalGate` | null or `{present:boolean,reason:string\|null,runId:string\|null}`; null is unknown, not an absent gate |
| `blocked` | null or `{reason:string,since:string\|null}`; `since` is the matching diagnostic event's ISO timestamp, when known |
| `supervisor` | `"reachable"\|"unreachable"\|"unknown"`; socket reachability is separate from the authoritative transition and gate records |
| `lastCompleted` | null or `{runId,sourceMode,targetMode,updatedAt}` from the most recent completed transition |
| `lastEvents` | array of the last ten matching Core diagnostic events; unavailable diagnostics produce an empty array without hiding authoritative records |
| `supervisorPm2` | optional `{status:string,error:{code:string,message:string}\|null}` alongside an unreachable supervisor |
| `error` | optional `{code:string,message:string}` when mode-status collection failed |

Transition `createdAt`/`updatedAt`, last-completion `updatedAt`, blocked `since`, and diagnostic-event `ts` are ISO timestamps at this boundary; Core storage units are not exposed. If authoritative status collection fails, Dashboard preserves the independently established `sessionMode`, sets `transition`, `globalGate`, `blocked` and `lastCompleted` to null, `lastEvents` to an empty array and `supervisor` to `unknown`, and includes `error`. These null fields do not prove that no transition, gate or block exists. These observations share the same object in GET and instance push; no separate transition endpoint exists.

The overview composes reminders from `supervisorPaused`, runtime health/account limits, `services.channels`, group counts/pool, offline `flag=startFailed`, row `flags.unreadable`, `counts.listKnown` and request failures. It does not receive a second instance-level attention list.

**Errors:** common authentication errors; an unavailable request dependency produces a server error. Individual missing observations can be represented by null fields.

Example: `GET /api/instance`.

### GET /api/instance/resources

**Access:** Read. **Parameters:** `range=6h|24h|7d` (default `6h`).

Returns `range:string`, `since:string`, `until:string`, `bucketSeconds:number`, `current:{cpu_pct:number|null,mem_used_pct:number|null,disk_used_pct:number|null,at:string|null}`, `pm2:{online:number,total:number,at:string|null}|null`, `series:Array<{at:string,cpu:Sample|null,mem:Sample|null,disk:Sample|null}>`, and `cpuPeak:{value:number,at:string}|null`. A `Sample` contains numeric `avg` and `max`. Empty sample buckets are null.

**Errors:** 400 `invalid_range`; common read errors.

Example: `GET /api/instance/resources?range=24h`.

### GET /api/instance/runtime-options

**Access:** Read. **Parameters:** `runtime=claude|codex|agy` (defaults to the saved instance runtime), optional `model` to include its threshold metadata.

Returns `runtime:string`, `current_model:string|null`, `current_effort:string|null`, `models:Array<{id:string,display_name?:string}>`, `efforts_by_model:Record<string,string[]>`, `catalog_strict:boolean|null`, `model_thresholds:Record<string,number>`, `model_threshold_max:Record<string,number>`, `new_session_threshold:number`, `session_hot_ttl:object`, `zylos_version:string`, `runtime_cli:string`, and `cc_version:string|null`. For Antigravity, `current_model` and `current_effort` are null, `models` is empty and `efforts_by_model` is empty because this integration does not support model/effort overrides. `cc_version` carries the selected runtime's installed CLI version, including Antigravity; it is null when unavailable. When `catalog_strict` is true, the catalog is closed and an unlisted current model or effort is shown as unavailable. This field is null when the runtime does not support model overrides. Empty effort options mean capabilities are unknown or the model does not expose effort selection. Threshold values and maxima are percentages. These are configured defaults and available choices, not Origin runtime observations; the response never includes running_model or running_effort and does not collect Origin session evidence.

**Errors:** 400 `INVALID_RUNTIME`; common read errors.

Example: `GET /api/instance/runtime-options?runtime=codex`.

### PUT /api/instance/defaults

**Access:** Admin. **Parameters:** one JSON change at a time:

| `kind` | Other fields | Effect |
|---|---|---|
| `model` | `model:string`, optional `runtime:"claude"\|"codex"`, optional `confirmed:true` | Save the selected runtime's default model and request immediate restarts for running sessions that inherit it |
| `effort` | `effort:string`, optional `runtime` | Change default effort within the model's supported options. With an explicit runtime, it applies at the next start |
| `threshold` | `runtime:"claude"\|"codex"\|"agy"`, `model:string`, `value:number\|string` | Set this model's rotation threshold as an integer from 10 through 95 |
| `session-hot-ttl` | `minutes:number\|string` | Set idle reclaim time for group sessions and Origin (Origin only in native single mode), within the limits reported by runtime options; pre-migration instances remain read-only |

Returns `ok:boolean`, optional `runtime:string`, `model:string`, `value:number`, `previous:string|null`, `requires_restart:boolean`, `minutes:number`, `seconds:number`, plus optional localized result metadata `message:string`, `messageKey:string`, `messageParams:object`. An explicit runtime model save reports immediate restart outcomes in `data.groups` using the same group result as the default runtime action below. Its `requires_restart` is false because Dashboard has already submitted the affected runs. Model and effort requests without an explicit runtime retain the Origin action contract via `requires_restart`. Without `runtime`, an instance whose runtime does not support model overrides (Antigravity) returns `INVALID_RUNTIME` for model and effort changes.

**Errors:** 400 `INVALID_DEFAULT`, `INVALID_RUNTIME`, `invalid_model`, `invalid_effort`, `invalid_value`; 409 `already_set`, `duplicate_request`, `environment_override`, `multi_session_required`, `CONFIRMATION_REQUIRED` (model save leaves the default unchanged if a restart may be needed and confirmation is missing); 503 `unknown_model_capabilities`; 500 `set_failed`; common write errors. Action failures select their HTTP response status; numeric internal `status` fields are omitted from the JSON write body.

Example: `PUT /api/instance/defaults` with `{"kind":"threshold","runtime":"claude","model":"opus","value":80}`.

### PUT /api/instance/name

**Access:** Admin; local only (see Access). **Parameters:** JSON `{name:string}` (1–32 ASCII letters, digits, underscores, dots or hyphens).

Returns `{ok:true,self:{name:string}}`. The new name is persisted in instance configuration and subsequent instance/fleet publications.

**Errors:** 400 `invalid_name`, `reserved_name` or `duplicate_name`; 500 `failed_to_save_config`; common write errors.

Example: `PUT /api/instance/name` with `{"name":"my-agent"}`.

### GET /api/instance/avatar

**Access:** Read (custom keys need `instance.read`), including the Fleet GET proxy. **Parameters:** none. HEAD returns the same headers without the image body.

Returns the local machine's stored image bytes with the original `Content-Type` and `Cache-Control: no-store`.

**Errors:** 404 `avatar_not_found` when the avatar is unset or the image file is missing. Common read errors also apply.

Example: `GET /fleet/worker/api/instance/avatar`.

### PUT /api/instance/avatar

**Access:** Admin, including the Fleet write proxy (`PUT /fleet/<agent>/api/instance/avatar`). The machine name stays local-only (see `PUT /api/instance/name`).

**Body:** Raw PNG, JPEG or WebP bytes with matching `Content-Type` (`image/png`, `image/jpeg` or `image/webp`), up to 512 KiB. The client crops and scales the image to 256×256 before upload. Dashboard checks the format signature and stores the submitted bytes.

Returns `{ok:true,avatar_version:string}`. The version is also published by `GET /api/instance` under `agent.avatar_version` and by `GET /api/fleet` on the machine's status row.

**Errors:** 400 `invalid_image` for a mismatched or missing signature, 413 `payload_too_large`, 415 `unsupported_image_type` for a missing or unsupported content type. Common write errors also apply.

Example: `PUT /api/instance/avatar` with `Content-Type: image/png` and the PNG file as the request body.

### POST /api/instance/actions/switch-mode

**Access:** Admin. **Parameters:** JSON `{mode:"single"|"multi"}`. Core owns transition validation and admission.

Returns `{ok:true,...CoreResult}` on success, with optional `data:object`, `message:string` and transition/result metadata. Core failures are mapped to the common error envelope and HTTP status. Completion and acceptance are distinct; refresh the instance after an accepted transition.

**Errors:** invalid mode, unavailable supervisor, transition conflicts and Core rejection codes in the returned envelope; common write errors.

Example: `POST /api/instance/actions/switch-mode` with `{"mode":"multi"}`.

### One runtime operation at a time

`POST /api/instance/actions/switch-runtime` (including its unconfirmed check without `confirmed:true`) and `POST /api/instance/actions/upgrade-runtime` share one slot in the Dashboard process: at most one of them runs at a time. The slot is taken just before the action runs and released when it ends, whatever the outcome (success, failure, timeout or an unexpected error). A request naming no supported runtime is rejected as before and never takes the slot. While the slot is taken, both routes run no command and return HTTP 409 `operation_in_progress` in the common envelope (`error.code:"operation_in_progress"`), with `messageKey:"result.operation_in_progress"` and `operation` set to the running record. `GET /api/instance` and the `instance` stream event report the same record in `operation_in_progress`; taking and releasing the slot each publish an `instance` event. The record lives only in the Dashboard process: a Dashboard restart clears it, and `zylos runtime` or CLI upgrades run outside Dashboard are neither seen nor refused. The 2-second identical-request dedup is unchanged.

### POST /api/instance/actions/switch-runtime

**Access:** Admin. **Parameters:** JSON `{runtime:"claude"|"codex"|"agy", confirmed?:true}`. Pass `confirmed: true` after the user accepts interruption. Omit it when there are no affected running sessions. Core refuses an unconfirmed operation if its observations show an affected session or cannot establish that there are none.

Returns `{ok:true,...CoreResult}` on success. `data.result` is `saved` or `unchanged`, and `data.baseline` is the saved default. `data.groups` includes a `restart` result for each affected group when Core assesses immediate replacement. Its `status` is `accepted`, `not_restarted` or `unknown`. An unsuccessful or uncertain submission includes its `reason` and leaves the configuration saved. Each restart is bound to the run observed immediately before saving and is admitted independently. This also applies to default model saves. On Save, Dashboard rereads the running groups and their overrides before building the confirmation. A session that starts after the confirmation list is read can be restarted even if the dialog did not list it. Acceptance records a restart request before the replacement run is ready. Dashboard and its existing connections continue running, and the instance stream publishes the new default. Failures use the common envelope. `AUTH_FAILED`, `AUTH_NOT_CONFIRMED`, `INSTRUCTIONS_UNAVAILABLE` and `RUNTIME_SETUP_INCOMPLETE` results display the original error details. `AUTH_FAILED` means rejected or missing credentials. `AUTH_NOT_CONFIRMED` means the probe could not confirm authentication.

**Errors:** HTTP 403 `AUTH_FAILED` (explicit credential rejection or logged-out status for any runtime) or `AUTH_NOT_CONFIRMED` (probe could not confirm authentication); HTTP 503 `INSTRUCTIONS_UNAVAILABLE` (the instruction file could not be rebuilt or is missing) or `RUNTIME_SETUP_INCOMPLETE` (runtime setup is missing, out of date, or could not be checked; for Codex, a failed hook trust rebuild includes the validation reason and rebuild error in `error.message`); HTTP 409 `operation_in_progress` (another switch or CLI upgrade is running; see [one runtime operation at a time](#one-runtime-operation-at-a-time)); invalid runtime, supervisor/transition rejection codes, and common write errors. The two authentication errors retain distinct `error.message` remedies: replace credentials/log in for `AUTH_FAILED` (agy: `zylos runtime agy --save-apikey <key>`); check network/proxy and retry for `AUTH_NOT_CONFIRMED`.

Example with one affected Origin run: `POST /api/instance/actions/switch-runtime` with `{"runtime":"codex","confirmed":true}`. HTTP 409 `CONFIRMATION_REQUIRED` leaves the default unchanged when confirmation is missing.

### GET /api/instance/core-update

**Access:** Read. **Parameters:** none.

Returns `{current:string|null,latest:string|null,hasUpdate:boolean,checkedAt:string|null}`. `current` is the installed Zylos Core version. `latest` is the newest stable Core release tag within the installed major version (prereleases and other major versions are excluded), using the instance's configured upstream sources. `hasUpdate` is true only when `latest` is newer than `current`. `checkedAt` is the ISO time of the last successful check.

The value comes from the Dashboard's existing version check, which runs at startup and every 12 hours; this request never contacts GitHub itself. Before the first successful check, `latest` and `checkedAt` are null and `hasUpdate` is false. A failed later check keeps the previous result. The Dashboard does not upgrade Core; run `zylos upgrade --self` on the host.

**Errors:** common read errors.

Example: `GET /api/instance/core-update` → `{"current":"1.4.0","latest":"1.5.2","hasUpdate":true,"checkedAt":"2026-11-20T04:00:00.000Z"}`.

### POST /api/instance/actions/upgrade-runtime

**Access:** Admin. **Parameters:** JSON `{runtime:"claude"|"codex"|"agy"}` (required); the named runtime's CLI is upgraded, regardless of the instance default runtime.

Returns `ok:boolean`, optional `message:string`, `output:string`, `requires_restart:boolean` and localization fields. Restart applies the installed CLI to a session.

**Runtime behavior:** Claude runs `claude update` and Codex runs `codex update`, each with a one-minute timeout. Antigravity runs `agy update` with a five-minute timeout and background auto-update disabled. Executable lookup honors the runtime's `<ID>_BIN` override, then uses PATH. For Antigravity, an `HTTPS_PROXY` entry in the instance `.env` wins over the process value. An empty entry removes the inherited value. Success includes `messageKey:"result.runtime_updated"` and `messageParams:{runtime:string}` with the display name. The Antigravity deadline response includes `messageKey:"result.runtime_upgrade_incomplete"` and `messageParams:{runtime:string,minutes:number}`. When the result is unknown (no reply arrives, the reply carries `unknown:true`, or it is a 5xx other than `upgrade_failed` and `deadline_exceeded`), the browser says the result is being checked, calls `recheck-runtime-cli` and rereads `GET /api/instance` to show the installed version. `upgrade_failed` and `deadline_exceeded` are shown as failures. A missing or unknown `runtime` returns 400 `runtime_unsupported` without executing a command.

**Errors:** 400 `runtime_unsupported`; 504 `deadline_exceeded` (Antigravity did not complete; verify the installed version before retrying); 502 `upgrade_failed`; 409 `duplicate_request`; 409 `operation_in_progress` (another switch or CLI upgrade is running; see [one runtime operation at a time](#one-runtime-operation-at-a-time)); common write errors.

Example: `POST /api/instance/actions/upgrade-runtime` with `{"runtime":"codex"}`.

### POST /api/instance/actions/recheck-runtime-cli

**Access:** Admin, including supported Fleet proxy access. **Parameters:** No request body.

Refreshes installed versions for Zylos and all registered runtimes using the same reader as scheduled refreshes. Concurrent refreshes share the pending result. The response is `200 {"ok":true}`. A refresh can preserve the last known value for an unavailable executable or failed probe. Read updated values with `GET /api/instance`.

**Errors:** Common write errors, including 403 `insufficient_scope` and `same_origin_required`, or 500 `internal_error` if the refresh fails.

Example request: `POST /api/instance/actions/recheck-runtime-cli` with an empty body.

## Session Groups

### List Row Fields

Lists contain presentation observations only. Running rows have exactly these fields:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable API identity; `origin` represents the single session |
| `displayName` | string | Effective human-readable name or fallback |
| `channel` | string / null | Channel namespace; Origin has no channel |
| `runtime`, `model` | string / null | Current runtime and model observations |
| `state` | `{kind:string,since:string\|null,stale?:boolean,sampledAt?:string,lastState?:"busy"\|"idle"}` | Mutually exclusive primary state and its known start; stale observations retain the last busy/idle classification for less than 60 seconds. Older samples become unknown while retaining sampledAt/lastState for an explicitly historical hint |
| `duration` | number / null | State duration in seconds; a tolerated stale idle sample retains its last recorded idle duration |
| `flags` | object | Independent conditions, below |
| `mainAgent` | `busy` / `idle` / `unknown` | Main Agent observation for instruction callers; UI does not display it |
| `contextPct` | number / null | Current session context percentage |
| `lastActivityAt` | string / null | Time of the latest received C4 message, or the first visible message if the group has never received one. Null when neither exists |
| `runtimeOverridden`, `modelOverridden` | boolean / null | Explicit runtime and model override observations; null when the evidence cannot establish the answer |
| `currentAction` | `{tool:string\|null,message:string\|null,receivedAt:string\|null}` | First current tool name, latest received message excerpt (at most 120 characters), and its ISO timestamp; absent observations remain null |

Offline rows include `id`, `displayName`, `channel`, `lastActivityAt`, `flags`, `runtimeOverridden` and `modelOverridden`. An offline row with a runtime override also carries its configured `runtime`. The ID remains necessary to open detail or perform a group action. The compact action contains no tool arguments, tool detail or raw message. Lists do not include `sessionGroup`, stored `name` metadata, `side`, `presence`, `live`, `working`, `wait`, `queue`, `target`, `launchConfig`, `c4`, `tools` or any other raw observations.

In single-session mode, Origin receives messages from every channel group. Its pending queue count and oldest timestamp aggregate all C4 delivery queues, and its latest received-message preview is selected across those groups. The Origin row's `queued` flag, the queued-row count in `counts.running.flags.queued`, `currentAction.message`/`receivedAt`, and detail `queue`/`preview` use these same collected observations. Detail `raw` is read from the same source group as the selected preview. The queued-row count counts Origin once when its pending message count is positive. Multi-session mode keeps each group's own queue and received-message scope.

| Primary state | Meaning |
|---|---|
| `working` | Process is present and the main Agent, a child Agent or a command is working |
| `idle` | Process is present with none of those activities |
| `starting` | Process launch is in progress |
| `stopping` | Present process has a stop/restart/reclaim fence |
| `offline` | Confirmed no process; represented by offline-list membership |
| `unknown` | Process/activity state cannot be established; belongs to the running side |

`mainAgent` and primary state answer different questions: a child-only workload is `working` with `mainAgent:"idle"`.

| Flag key | Value fields and types | Meaning |
|---|---|---|
| `queued` | `count:number`, `oldestAt:string\|null`, `waitSeconds:number\|null` | Messages are waiting |
| `blocked` | `reason:"auth_failed"\|"rate_limited"`, `runtime:string`, `recoveryAt:string\|null` | Work or queued input is blocked by runtime health; positive Core Unix seconds become ISO recovery time, while zero, negative or unreadable values produce null |
| `waitingSlot` | `position:number` | Offline, queued, and waiting for capacity |
| `startFailed` | `count:number`, `lastAt:string\|null`, `reason:string\|null` | Launch failed within the past 30 minutes |
| `unreadable` | `reasons:string[]` | One or more source observations could not be read |
| `noResponse` | `since:string` | The existing supervisor reminder for the current run has not been followed by a main-agent response; ISO reminder time |

Flags are independent: a working row can carry both `queued` and `blocked`. Missing keys mean that condition was not established. A main-agent response clears `noResponse`; a new run never inherits an earlier run’s reminder. Child-agent activity alone does not clear it. Historical group names and flags remain available through the offline list.

### GET /api/groups/counts

**Access:** Read. **Parameters:** none.

Returns `readAt:string`, `listKnown:boolean`, `running:{total:number,states:Record<PrimaryState,number>,flags:Record<Flag,number>}`, `offline:{total:number,waitingSlot:number,startFailed:number}`, and `pool:{used:number|null,capacity:number|null}|null`. Running state counts include working, idle, starting, stopping and unknown. `running.flags.noResponse` counts the independent no-response flag, including a row also flagged with an error. All count/pool observations are numeric or null; there are no rows, mode or capacity-provenance records. Session mode comes only from `/api/instance`. Pool capacity provenance is not exposed by instance or counts.

**Errors:** 502 `GROUP_CATALOG_UNREADABLE`; common read errors. Other source availability is represented by nullable observations. In counts, `listKnown` additionally requires a readable C4 catalog.

Example: `GET /api/groups/counts`.

### GET /api/groups

**Access:** Read. Supports these optional query parameters. Filters combine with AND before paging.

| Parameter | Values and behavior |
|---|---|
| `side` | `running` or `offline` |
| `flag` | `queued`, `blocked`, `waitingSlot`, `startFailed`, `unreadable`, or `noResponse`; matches a key present in the row's flags |
| `runtime` | `claude`, `codex`, or `agy`; matches the current runtime on the running side. Starting rows have no current runtime |
| `runtimeOverridden` | `true` or `false`; matches an explicit runtime selection, even if it equals the default. Override-only groups with no C4 messages can appear on the offline side |
| `modelOverridden` | `true` or `false`; matches a launch model override, a desired model override for the current runtime, or a stored model override for that runtime |
| `q` | Case-insensitive substring of the group ID/address or display name. Trimmed to a term of at most 64 characters; a blank term applies no filter |
| `include` | `total` adds the total match count |
| `limit` | Integer from 1 through 100, default 50 |
| `cursor` | Opaque continuation returned by the previous page |

Returns `{items:Array<RunningRow|OfflineRow>,nextCursor:string|null,total?:number,readAt:string,listKnown:boolean}`. Origin sorts first when it matches. Other groups sort descending by `lastActivityAt` (null sorts as zero), then ascending by ID. Received messages count when their direction is inbound and their channel is neither empty, `void`, nor `control`. Outgoing replies do not update the sort time. Pass the cursor unchanged with the same filters and `q`; after `invalid_cursor`, reload the first page. `listKnown` is false if the live list is incomplete or an override filter depends on unreadable evidence.

**Errors:** 400 `invalid_parameter` with `error.param` for an unknown, repeated, or invalid query parameter; 400 `invalid_cursor`; 503 `unavailable` for an unreadable catalog or sort observations; common read errors.

Example: `GET /api/groups?side=running&runtime=codex&modelOverridden=false&limit=8&include=total`.

### GET /api/groups/activity

**Access:** Read. **Parameters:** `range=60m|6h` (default `6h`); `ids` (required), a comma-separated list of 1–100 group IDs (`origin` for Origin). Only the requested groups are read and returned; unknown IDs are skipped and absent from `groups`. Clients with more than 100 loaded groups send several requests.

Returns `{range:string,cellSeconds:number,start:string,groups:Record<string,{cells:string[],inbound:string[]}>,inboundError?:"inbound_unreadable"}`. Cells are activity classifications (`none`, `idle`, `busy`, `waiting`, `error`); inbound entries are message ISO timestamps. This heatmap retains historical activity classifications, which are separate from the current primary-state vocabulary. If inbound timestamps cannot be read, the response includes `inboundError:"inbound_unreadable"` while retaining the event classifications.

In single-session mode, `groups.origin` combines current `origin` and historical null-group events, including turn transitions before the window needed to seed its first cell. Its inbound markers include all external channel groups feeding the sole session; internal and outbound messages are excluded. Multi-session heatmaps retain each group's own event and inbound scope.

After switching from multi-session to single-session mode, inbound markers within the selected window (up to six hours) also include messages handled by other groups before the switch, because single-session mode reads all external inbound messages.

**Errors:** 400 `invalid_range`; 400 `INVALID_IDS` when `ids` is missing, contains an empty entry or has more than 100 entries; source read failures and common read errors.

Example: `GET /api/groups/activity?range=6h&ids=origin,telegram%3Aexample`.

### GET /api/groups/:id

**Access:** Read. **Parameters:** encoded group ID; optional `include=raw,config`. Omit the parameter to request neither part. Either name can be selected independently, once. The Origin Operations Interface retains its default of both parts and accepts an empty `include=` to omit them.

Returns the complete group observation, including the applicable list fields plus `sessionGroup:string|null`, `name:object|null`, `side:"running"|"offline"`, `presence:string`, `live:object|null`, `fence:object|null`, `working:object|null`, `queue:object|null`, `wait:object|null`, `target:object|null`, `launchConfig:object|null`, `createdAt:string|null`, `c4:object|null`, `tools:array`, and other source observations. `readAt:string` is the snapshot’s ISO observation timestamp. `runtimeInfo` is the group-specific object `{runtime:string|null,model:string|null,effort:string|null,runningVersion:string|null,installedVersion:string|null,update:string|null,pendingRestart:boolean}`. Its runtime/model/effort and running version are observed group values; unavailable strings remain null. `installedVersion` is the installed version for that runtime; `update` is an available newer version string or null, using the same version comparison as `versions[runtime]`. `pendingRestart` is true only on the running side when known evidence identifies a newer installed CLI or a desired runtime/model/effort that differs from the current observation. False does not establish that unknown values match. This group-specific object does not appear in `/api/instance`.

Detail also includes `currentAction:{tool:string|null,message:string|null,receivedAt:string|null}` using the same bounded, sanitized projection as a running list row. Optional `include` extras do not change this field.

`effective` contains `{runtime:string|null,model:string|null,effort:string|null,runtimeOverridden:boolean|null,modelOverridden:boolean|null}`. Effective runtime, model and effort describe the actual ready run. They are null while a run is starting and describe the desired configuration when offline. The runtime override flag reports whether the group explicitly selects a runtime, even when that selection equals the instance default. The model override flag uses launch, desired and stored override evidence for the runtime; an active session without a readable launch configuration reports null. The Origin Operations Interface retains the launch override mode for an active run. Top-level override fields and `effective` use the same observations. Unknown evidence yields null. `run` is `{runId:string|null,sessionId:string|null,createdAt:string|null}|null`.

When requested, `raw:string|null` contains sanitized first-message content and `config:object|null` contains Core runtime/model read envelopes. An optional read failure returns its field as null and `rawError` or `configError` as `{code:string,message:string}`; it does not fail the whole detail request. Unrequested extras and their error fields are omitted. The address remains stable across lifecycle changes.

`config.modelOverrides` is a read-only `Array<{runtime:string,model:string,effort:string}>|null` from the same group snapshot. It contains only the requested group's saved model and effort pairs, including pairs for runtimes other than the selected one. A runtime missing from a successful array follows the instance default. An empty array means no pairs are saved, and `null` means the snapshot could not read the overrides. For example, the field may be `[{"runtime":"codex","model":"gpt-5","effort":"high"}]` when the selected runtime is Claude.

Group IDs other than Origin are namespaced. The retired paths `/api/groups/running`, `/api/groups/offline`, `/api/groups/search`, and `/api/groups/runtime-overrides` return 404 `not_found`.

**Errors:** 400 `SESSION_GROUP_INVALID` or `invalid_parameter` with `error.param` for invalid query parameters; 404 `not_found`; 502 `GROUP_CATALOG_UNREADABLE` when an unknown group cannot be checked against the catalog or a historical key cannot be verified; common read errors. Detail for a current valid key remains readable when unrelated catalog collection fails. Individual Core configuration errors can also appear inside their configuration envelopes.

Group observation reads (detail, usage, runs, messages, events, backlog and restart status) also accept historical imported group IDs outside the current write grammar, such as `telegram:运维群-测试`, only when a healthy instance C4 catalog contains that exact group with C4 evidence. They reuse the same request snapshot catalog as detail; status-only rows, queue-only rows, usage/event history and filesystem presence do not prove membership. IDs are decoded exactly once and must retain a valid namespace, a nonempty local name of at most 95 characters and total length at most 128. Control characters, DEL, slash, backslash and dot-only traversal names (`.` or `..`) are rejected before catalog lookup. A literal percent in an existing name is allowed after decoding; no second decode occurs. Malformed URL encoding returns 400 `SESSION_GROUP_INVALID`.

Unknown historical IDs return 400 `SESSION_GROUP_INVALID`; an unreadable catalog returns 502 `GROUP_CATALOG_UNREADABLE`. Current valid IDs retain each route's existing empty-data/not-found behavior without requiring the catalog solely for validation. This read exception does not change config, name, action or deletion validation. Deletion preview is part of Core's deletion operation and retains the same strict target grammar as deletion. Optional raw/config readers retain their own field-level failures.

Example historical observation: `GET /api/groups/telegram%3A%E8%BF%90%E7%BB%B4%E7%BE%A4-%E6%B5%8B%E8%AF%95/runs?limit=3`.

Conversation status is an optional consumer of this detail. A newly created chat group absent from the snapshot returns `not_found`. The Origin Operations Interface retains `GROUP_NOT_FOUND`. Chat remains usable without a status reading and retries on the existing status cadence.

Example: `GET /api/groups/telegram%3Aexample`.

### GET /api/groups/:id/usage

**Access:** Read. **Parameters:** encoded group ID.

Returns the [usage summary](#usage-summary-fields) with `scope:"group"` and `group:string`. Historical records without group attribution count toward `origin`, except Other: samples of runtimes zylos starts itself (no group, no run, marked as a child) count toward no group, including `origin` (see [usage summary](#usage-summary-fields)). An otherwise valid ID with no usage returns zero counts/cost and null cache rate.

**Errors:** 400 `SESSION_GROUP_INVALID`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; 500 `internal_error` when the usage query fails; common read errors.

Example: `GET /api/groups/origin/usage`.

### GET /api/groups/:id/runs

**Access:** Read. **Parameters:** encoded ID; optional `limit:integer` (1–100, default 50), `cursor:string`, and `level=plain|technical` (default `plain`).

Returns `{items, nextCursor, totalRuns, totalEvents, unattributed}`. Rows are `{runId, startAt, endAt, n, endReason}`, ordered by start time descending, then run ID ascending. `nextCursor` is signed, opaque and null at the end. `level` changes the event counts, not run membership or bounds. Counts exclude the crashes caused by an automatic restart. `endReason` distinguishes the current run (`running`), reclaim/restart/rotation/crash reasons and `unknown`. Single-session Origin reads null-group runs; multi-session Origin reads its own group.

**Errors:** 400 `invalid_parameter` with `error.param`, `invalid_cursor`, or `SESSION_GROUP_INVALID`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; 503 `unavailable` when runs cannot be read; common read errors.

Example: `GET /api/groups/origin/runs?limit=3`.

### GET /api/groups/:id/messages

**Access:** Read. **Parameters:** encoded ID; optional `limit:integer` (1–100, default 50), `cursor:string`, and `direction=before|after` (default `before`; `after` requires a cursor).

Returns `{items, nextCursor, afterCursor}`. An unanchored request selects the newest page; items are always ordered by ascending C4 message ID. Each item contains only `{id, direction, channel, timestamp}` and internal-channel messages are excluded. Single-session Origin reads null-group messages; other groups, including multi-session Origin, read their own group. `nextCursor` reads older rows and is null after the last older page or on an `after` request. `afterCursor` reads newer rows and is returned even for an empty page.

**Errors:** 400 `invalid_parameter` with `error.param`, `invalid_cursor`, or `SESSION_GROUP_INVALID`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; 503 `unavailable` when C4 cannot be read; common read errors.

Example: `GET /api/groups/origin/messages?limit=20`.

### GET /api/groups/:id/events

Single-session Origin reads current hook records stored as `session_group:"origin"` together with historical null-group records. Other groups and multi-session Origin retain their own group scope.

**Access:** Read. **Parameters:** encoded ID; optional `runId`, `filter=all|tools|lifecycle|subagents` (default `all`), `level=plain|technical` (default `plain`), `limit:integer` (1–100, default 50), `cursor:string`, and `direction=before|after` (default `before`; `after` requires a cursor). `tools` selects tool events only; automatic restart records remain in `lifecycle`. `subagents` selects start and stop events. `all` includes unlabelled types only at `technical` level.

Returns `{items, nextCursor, afterCursor}` with the same direction semantics as group messages. Items are always ordered by `event_seq` ascending, then `id` ascending. The store allocates `event_seq` across all groups, but the schema does not enforce its uniqueness; `id` is the unique tie-breaker. Event rows are sanitized and include `id`, `event_seq`, `timestamp`, `runtime`, `session_id`, `session_group`, `run_id`, `event_type`, `category`, `summary`, `duration_ms`, `metadata`, `source` and `confidence`, with nullable source fields. A `post_tool_failure` associated with an automatic restart in the same run in the preceding 10 seconds includes `interrupted:true`; other rows omit the field. Associated crash reports are excluded before pagination, whether or not the restart is on the same page. Cursors are signed and scoped to the group and filters; a Dashboard restart invalidates them.

**Errors:** 400 `invalid_parameter` with `error.param`, `invalid_cursor`, or `SESSION_GROUP_INVALID`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; 503 `unavailable` when events cannot be read; common read errors.

Plain `all` and `tools` select both hook and transcript tool events; each event's runtime adapter determines which source supplies activity. Plain `all` includes the `input_dequeue` and `dashboard_interrupt` turn boundaries; they are not displayed as activity rows. Plain event rows include `activity`: `null`, `{kind:"commentary",text:string}` for text identified directly by an adapter, or `{kind:"tool",label:{key,arg?,count?,more?},status,start:boolean,duration:number|null}`. `start` distinguishes a call from a result and `duration` is in milliseconds. A plain row may also carry `commentaryRole`: `"candidate"` marks text with `activity: null`, `"tool"` marks an eligible step start (not a subtask launch), and `"boundary"` marks a turn boundary. The browser displays candidate text only when a later eligible step in the loaded events is in the same turn. Final replies are shown as C4 message rows. The technical view omits both `activity` and `commentaryRole`. Codex may attach `metadata.command_activity` (`first`: null or `{key,arg?}`, `count`: integer, `allReads`: boolean) to a final tool result, with no command text or output.

Example: `GET /api/groups/origin/events?filter=tools&limit=20`.

### GET /api/groups/:id/backlog

**Access:** Read. **Parameters:** encoded ID.

Returns `count:number|null`, `firstAt:string|null`, `syncing:boolean|null`, and optional `reason:"backlog_failed"`. These are messages not yet included in scoped memory, not the pending delivery queue. The existing backlog reader may cache for 30 seconds. Historical names use a read-only C4 database snapshot with the same checkpoint coverage and delivered-frontier rules as Core. Their `count` and `firstAt` remain available; `syncing` is null with `reason:"backlog_failed"` because Core sync-marker paths require the current strict group grammar.

**Errors:** 400 `SESSION_GROUP_INVALID`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; unavailable backlog evidence is returned as null fields and `reason`; common read errors.

Example: `GET /api/groups/origin/backlog`.

### PUT /api/groups/:id/config

**Access:** Admin. **Parameters:** encoded ID; one JSON change:

- `{kind:"runtime",value:"claude"|"codex"|"inherit"}` changes or resets runtime override.
- `{kind:"model",runtime:"claude"|"codex",model:string,effort:string}` sets a complete pair.
- `{kind:"model",runtime:"claude"|"codex",reset:true}` restores the runtime's default model/effort.

Include optional `confirmed:boolean` on any change. Only `true` passes `--yes` to Core. An effective engine or active model/effort change that could interrupt a running group requires confirmation before it is stored. Saving a stopped group does not start it.

Returns `{ok:true,data?:object,...metadata}` on success. If Core tried to restart the affected run after saving, `data.restart` has `status:"accepted"|"not_restarted"|"unknown"` and an optional `reason:string`. A refused or uncertain restart leaves the change saved. The restart is bound to the run Core observes before the write. Dashboard checks for a changed run it knows about while the confirmation is open. Core can observe a newer run between confirmation and the write. The caller uses this restart result directly. For a combined edit, Dashboard sends two writes and puts the effective change last. For an engine switch, it first stores the target engine's model. If the effective engine stays the same, it stores the engine preference before writing the active model. The writes commit separately. If Core reports a restart on the first write because the effective engine changed concurrently, Dashboard leaves the remaining edit unsaved.

**Errors:** 400 `SESSION_GROUP_INVALID`, `SESSION_GROUP_TOO_LONG`, `INVALID_ARGUMENT`, `MODEL_PAIR_REQUIRED`, `MODEL_CONFIG_INVALID` and other Core validation rejections; 404 `SESSION_GROUP_NOT_FOUND`; 409 `CONFIRMATION_REQUIRED` if confirmation is missing and the change may interrupt a running group or its running state cannot be verified; 500 `CONFIG_STORE_FAILED`; 502 `RESULT_UNKNOWN`; common write errors. `RESULT_UNKNOWN` means the result could not be established. Read the group detail before deciding whether any retry is needed.

Example: `PUT /api/groups/telegram%3Aexample/config` with `{"kind":"runtime","value":"inherit","confirmed":true}`.

### PUT /api/groups/:id/name

**Access:** Admin. **Parameters:** encoded ID; JSON `{name:string}` (1–40 characters after trimming, without control characters or line/paragraph separators).

Returns `{ok:true,data:{sessionGroup:string,displayName:string|null,source:string|null}}` with saved name/source metadata. A manual name is recorded with source `human`. Origin is not a renameable conversation.

**Errors:** 400 `KEY_INVALID`, `NAME_INVALID`, `NAME_SET_BY_HUMAN`; 500 `internal_error`; common write errors.

Example: `PUT /api/groups/telegram%3Aexample/name` with `{"name":"Project team"}`.

### DELETE /api/groups/:id/name

**Access:** Admin. **Parameters:** encoded ID; no body.

Returns `{ok:true,data:{sessionGroup:string,displayName:string|null,source:string|null}}` after clearing the saved display name, restoring the fallback name.

**Errors:** 400 `KEY_INVALID`, `NAME_INVALID`, `NAME_SET_BY_HUMAN`; 500 `internal_error`; common write errors.

Example: `DELETE /api/groups/telegram%3Aexample/name`.

### POST /api/groups/naming-prompt

**Access:** Admin, including through Fleet. Local read-only credentials are rejected before forwarding; remote read-only credentials remain subject to the target’s admin gate. **Parameters:** none; any JSON body is ignored.

Queues one C4 control that asks Origin to name recently active unnamed groups. The mode comes from this instance's `.zylos/config.json`: configured single and multi target session group `origin`; instances without a `session_mode` key keep the legacy empty target. The control text is the Dashboard naming prompt with the installed `group-name.js` path. Returns `{ok:true,controlId:number,sessionGroup:'origin'|null}` once C4 has queued it. Queued is the whole result: the response does not wait for delivery or naming, and nothing reports the names chosen.

**Errors:** Command failures use the common `{ok:false,error:{code,message}}` envelope and non-2xx status, retaining `sessionGroup` and, for uncertain outcomes, `unknown:true`. C4 rejection retains its code: `CONTROL_TARGET_REQUIRED` returns 503; an unrecognized rejection (including `ENQUEUE_REJECTED`) returns 502. `RESULT_UNKNOWN` returns 502 when the send command fails or Core's answer cannot be read; do not repeat automatically. `message` is a fixed English sentence such as `Send command failed (exit 1)`; it never carries the command line, prompt, paths or stack, which are written to the Dashboard service log instead. GET and HEAD return 404 `not_found`. Common write errors.

Example: `POST /api/groups/naming-prompt`.

### POST /api/groups/:id/actions/interrupt

**Access:** Admin. **Parameters:** encoded ID; JSON `{runId:string,sessionId?:string|null}` binding the request to observed identity. Non-Origin requires `runId`; Origin delegates to Core's session action handling.

Returns `ok:boolean`, `controlId:number|null`, `submission:string`, optional `rejectionCode:string|null`, `currentRunId:string|null`, `unknown?:boolean`, and `steps:object[]`. Core may add `data` or `error`. A submitted Escape is not a delivery acknowledgement.

**Errors:** 400 `SESSION_GROUP_INVALID`, `TARGET_REQUIRED`, `INVALID_ARGUMENT`; 409 `not_multi`, `TARGET_MISMATCH` for stale `runId`, or `STALE_TARGET` for stale `sessionId` with current `runId` (`error.code` and `rejectionCode` are `STALE_TARGET`, message `The target session has changed`, `currentRunId:null`); result `RESULT_UNKNOWN` or Core rejection codes; common write errors.

Example: `POST /api/groups/telegram%3Aexample/actions/interrupt` with `{"runId":"observed-run","sessionId":"observed-session"}`.

### POST /api/groups/:id/actions/chop-chop

**Access:** Admin. **Parameters:** same identity body as interrupt.

Returns a Core nudge result envelope with `ok:boolean`, optional `steps:object[]`, `unknown:boolean`, `submission:string`; failures use `error:{code,message}` and non-2xx HTTP status. Steps describe submitted controls; a partial/unknown result is not safe to repeat blindly.

**Errors:** same target/mode/access errors as interrupt; Core nudge rejection codes.

Example: `POST /api/groups/telegram%3Aexample/actions/chop-chop` with `{"runId":"observed-run"}`.

### POST /api/groups/:id/actions/restart

**Access:** Admin. **Parameters:** same identity body as interrupt. For a stopped Origin, an empty body requests a wake. A run-bound request for an absent target returns `already_stopped` without waking it.

Returns the supervisor result with `ok:boolean`, `requestId?:string`, `submission:"accepted"|"rejected"|"unknown"|"not_submitted"`, optional `completion:string`, `unknown?:boolean`; failures use `error:{code,message}` and non-2xx HTTP status. Each group can have one pending manual restart. Requests for different groups are admitted independently. Origin uses the same public address and Core's Origin action implementation. Query the restart resource to establish progress.

**Errors:** same target/mode/access errors as interrupt; `INSTANCE_ROOT_MISMATCH`; supervisor rejection/unavailable result codes.

Example: `POST /api/groups/telegram%3Aexample/actions/restart` with `{"runId":"observed-run"}`.

### GET /api/groups/:id/restarts/:requestId

**Access:** Read. **Parameters:** encoded group ID and UUID-shaped restart request ID.

Returns `requestId:string`, `completion:string` (supervisor lookup result, or `unknown`), and `group:{id:string,runId:string|null,sessionId:string|null,ready:boolean,state:object}`. This works for any group, including Origin; group identity and current state are observations, not proof that a particular restart caused them.

**Errors:** 400 `SESSION_GROUP_INVALID`, `INVALID_REQUEST_ID`; 404 `not_found` for groups and `GROUP_NOT_FOUND` for Origin; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; common read errors.

Example: `GET /api/groups/origin/restarts/00000000-0000-4000-8000-000000000001`.

### GET /api/groups/:id/deletion-preview

**Access:** Local owner. Fleet refuses group and draft deletion previews and deletes with 403 `remote_deletion_forbidden` before obtaining upstream credentials or making a request. **Parameters:** encoded ID; no body.

Returns Core's deletion preview: `ok:boolean`, `sessionGroup:string`, `draft:boolean`, `cutoffId:number` (message boundary), `operationId:string`, `pending:boolean`, `messages:number`, `attachments:number`, `files:number`, and target/boundary metadata. HTTP 200 has `pending:false`; when a deletion is already in flight, HTTP 202 has `pending:true` and the existing operation's ID and cutoff. Preserve the operation ID and cutoff for the confirmed delete.

**Errors:** 403 `local_cookie_required`, `origin_deletion_forbidden`; 400 `invalid_deletion_target`; 502 `deletion_result_unknown` / `deletion_unavailable`; Core target/preview errors.

Example: `GET /api/groups/telegram%3Aexample/deletion-preview`.

### DELETE /api/groups/:id

**Access:** Local owner, same origin. **Parameters:** encoded ID; JSON `{confirmed:true,operationId:string,cutoffId:integer}` from a fresh preview. Operation IDs are nonempty and at most 128 characters; cutoff is a nonnegative safe integer. Origin cannot be deleted.

HTTP 202 means deletion remains pending: draining returns `{ok:true,pending:true,operationId:string,reason:"draining"}`; waiting for usage finalization uses `reason:"usage_pending"`. These pending results contain neither `counts` nor `countsEstimated`. Retrying the same confirmed operation after it finishes returns HTTP 200 with `ok:true`, `pending:false`, `operationId:string`, `counts:object`, `countsEstimated:boolean`, `retainedMessages:number` and `groupDataRetained:boolean`. Counts and retained-target metadata appear only in the completed result.

**Errors:** 400 `deletion_confirmation_required`, `invalid_deletion_target`; 403 `local_cookie_required`, `same_origin_required`, `origin_deletion_forbidden`; 409 for transition/ownership/fence conflicts and `DELETION_PREVIEW_STALE`; 502 `deletion_result_unknown` / `deletion_unavailable`; Core deletion errors.

Example: `DELETE /api/groups/telegram%3Aexample` with `{"confirmed":true,"operationId":"from-preview","cutoffId":100}`.

## Usage

### Usage Summary Fields

Instance and group summaries share the following schema. Tokens include input and output; input includes cached input. Cache rate is weighted by input volume, not an average of request percentages. Historical records without a group belong to Origin, except Other: samples of runtimes zylos starts itself (no group, no run, marked as a child) belong to no group: they count in instance-wide totals (the instance summary and `/api/usage/series`, whose `totals.otherCost` names them), never in a group summary. Costs sum stored priced requests; consult pricing results for models whose cost could not be priced. After a switch from multi-session to single-session mode, historical usage belonging to other groups remains in the instance summary and is not reassigned to Origin; Origin usage can therefore be smaller than the instance summary.

| Field | Type | Meaning |
|---|---|---|
| `tz`, `tzFallback` | string, boolean | Resolved instance zone; invalid/missing zones use UTC and flag fallback |
| `scope` | `all_groups` / `group` | Aggregation scope |
| `group` | string, optional | Present only for per-group reads |
| `today`, `sevenDay` | UsagePeriod | Current local day / seven local calendar days including today |

A `UsagePeriod` contains `since:string`, `until:string`, `tokens:number`, `inputTokens:number`, `outputTokens:number`, `cacheReadTokens:number`, `cacheHitRate:number|null` (0–1; null with no input), `cost:number` (USD), and `byRuntime:Record<string,UsageTotals>`. `UsageTotals` has the same numeric/rate/cost fields, without bounds or another runtime breakdown. Both known runtimes are present with zero counts if no records exist. The sum of each group's `cost` plus Other's cost equals the instance `cost` for the same time window (Other's cost is `totals.otherCost` of `/api/usage/series`); Other's token counts are not returned separately; cache rates must be recomputed from summed cache/input tokens.

### GET /api/usage/summary

**Access:** Read. **Parameters:** none.

Returns the [usage summary](#usage-summary-fields) with `scope:"all_groups"`. Window boundaries use the instance time zone.

**Errors:** common read errors, including 500 `internal_error` for unavailable queries.

Example: `GET /api/usage/summary`.

### GET /api/usage/series

**Access:** Read. **Parameters:** `range=24h|7d|30d` (default `7d`). Existing `month` and `custom` selections are also supported; custom requires ISO `since` and `until`, increasing and at most 366 days apart.

Returns `range:string`, `since:string`, `until:string`, `tz:string`, `tzFallback:boolean`, `bucket:"hour"|"day"`, `buckets:string[]`, `scope:"all_groups"`, and:

| Field | Type | Meaning |
|---|---|---|
| `totals` | object | `tokens`, `inputTokens`, `cacheReadTokens`, `cacheHitRate`, `cost`, `costByRuntime`, `otherCost`, `messages:{in,out}`, `rotations`, `tools`; unavailable items nullable. `otherCost` is the part of `cost` spent by runtimes zylos starts itself (Other), counted in no group |
| `costByRuntime`, `tokensByRuntime` | `{runtime:string,at:string,value:number}[]` | Bucketed runtime cost/token series |
| `cache` | `{at:string,inputTokens:number,cacheReadTokens:number,value:number\|null}[]` | Bucket-aligned weighted cache rates |
| `messages` | `{at:string,in:number\|null,out:number\|null}[]` | Inbound/outbound message buckets |
| `messagesReason`, `messagesSampledAt` | string / null | Message query unavailability and observation time |
| `rotations` | `{at:string,value:number}[]` / null | Session-rotation event buckets |
| `tools` | `{name:string,count:number}[]` / null | Top ten tools with stable ordering |
| `runtimeEventsUnknown` | boolean | Range exceeds retained runtime-event history |
| `projects` | object | Project distribution with `items`, `totalTokens`, `totalOutput`, `totalCost`; items include name, output tokens, cost, percentage |

Hourly buckets are fixed epoch hours; daily buckets follow local calendar boundaries, including DST. Cache data is included here and requires no separate metric API request. Runtime events are retained for seven rolling days; wider ranges return null for rotations/tools instead of implying zero.

**Errors:** 400 `invalid_range`; 500 `internal_error` when the usage query fails; common read errors.

Example: `GET /api/usage/series?range=30d`.

### GET /api/usage/pricing

**Access:** Read. **Parameters:** none; always covers the latest seven local calendar days.

Returns range/boundary/time-zone fields as above, `models:Array<{runtime:string,model:string|null,cost:number}>` for stored priced costs, and `unmatched:Array<{runtime:string,model:string|null,tokens:number}>` for usage without matching cost evidence. Legacy token rows with a corresponding legacy cost row are not listed as unmatched.

**Errors:** common read errors, including 500 `internal_error`.

Example: `GET /api/usage/pricing`.

## Memory

Read-scope callers can list entries and read the backlog. File bodies and Git metadata require admin access. PUT requires admin and browser same origin. Paths are relative to the memory root; absolute paths, traversal, symlinks and unsupported text files are rejected.

| Method/path | Parameters and result | Errors / example |
|---|---|---|
| `GET /api/memory/entries` | A list under the list API standard, one directory level per request so a large memory tree opens folded and loads as folders are opened. Filters (bound to the cursor): `dir` (a directory relative to the memory root; default the root, or `session-groups` with `view=groups`) and `view=all|shared|groups` (default `all`; `shared` leaves out `session-groups/`, `groups` covers only `session-groups/`). Also `q`, `limit=1..100` (default 50) and `cursor`. Returns `{items,nextCursor}`. Each item has `path` (relative to the memory root), `name` and `type`: `file` rows add `size_bytes`, `mtime` and `renderable` (a supported text file within the size limit); `group` rows (a valid session-group directory directly under `session-groups/`) add `sessionGroup`, `displayName` (or null) and `backlog:{count,syncing}` or null, read only for the groups on the page from the same 30-second per-group cache as `GET /api/memory/backlog`, so badges match the backlog card; `directory` rows are other folders, and a folder directly under `session-groups/` whose name is not a session group adds `diagnostic:"invalid_session_group"`. Git's directory, symbolic links and in-flight save files are never listed. Order: folders first: session groups by their latest received message, newest first (list API standard 6.2, or the first message when none was received, 6.3), then groups with no message, then other folders by path; then files by `mtime` DESC; the path breaks ties. A file saved while a client pages moves to the top of the files (standard 5.2) and may be read twice; clients keep one row per `path`. With `q` the list is the shallowest matches in the subtree of `dir`, depth first by name: an entry matches when its path below `dir` (or a group's display name) contains `q`, case-insensitive, and a matching folder stands for everything under it, so its contents are not listed. For example `GET /api/memory/entries?view=groups&q=tel` returns the matching group rows only (their files are not searched), and `GET /api/memory/entries?q=state` returns `state.md` at the root and the `state.md` file inside each group, because no folder on the way matches. | 400 `invalid_parameter` (with `error.param`) for an unknown, repeated or invalid parameter, including `dir` outside the memory root, through a link or into `.git`, `dir` naming a file, and a `view` that does not cover `dir`; 400 `invalid_cursor` for a cursor that is forged, from other filters or `q`, or from before a Dashboard restart (reload the first page); 404 `not_found` when `dir` does not exist; 503 `unavailable` when the directory cannot be read, or when C4 cannot be read for the group order of the `session-groups` level without `q` (a search, the root, other folders and the files inside a group do not read C4). Example: `GET /api/memory/entries?dir=session-groups%2Ftelegram%3Adm-1001&limit=50`. |
| `GET /api/memory/file` | Required `path`. Returns `{path,name,size_bytes,mtime,sha256,markdown,text}`. `mtime` is ISO; `sha256` is the optimistic-write version. | 400 `invalid_memory_path`, 404 `memory_file_not_found`, 413 `memory_file_too_large`, 415 `unsupported_memory_file` (not a supported text file name, or not valid UTF-8), 500 `memory_browser_failed`. Example: `GET /api/memory/file?path=state.md`. |
| `PUT /api/memory/file` | Required `path`; JSON `{text:string,sha256:string}`. Returns `{ok:true,...file}` after Core's lock, conflict check and atomic save. | 400 `invalid_memory_write` (body, text or sha256 invalid), `memory_write_empty`, `invalid_memory_path`; 404 `memory_file_not_found`; 409 `memory_conflict` (with current file), `memory_sync_busy`; 413 `memory_file_too_large`; 415 `unsupported_memory_file`; 503 `memory_write_unavailable`, `memory_lock_timeout`; 502 `memory_write_unknown`; 500 `memory_write_failed` or `memory_browser_failed`. Example body: `{"text":"# Current work\n","sha256":"<64 hex characters>"}`. |
| `GET /api/memory/git` | Required `path` (empty root allowed). Returns `{path,commit:null|{hash,short_hash,author_name,author_date,subject}}`. Missing Git history yields `commit:null`. | 400 `invalid_memory_path`, 404 `memory_file_not_found`, 500 `memory_browser_failed`. Example: `GET /api/memory/git?path=state.md`. |
| `GET /api/memory/backlog` | A list under the list API standard: `q` (matches the session-group ID or display name, case-insensitive), `limit=1..100` (default 50), `cursor`. Returns `{items,nextCursor,summary,originSync?,budgets}`. Each item has `sessionGroup,displayName,c4,count,firstAt,aged,syncing,threshold` and optional failure `reason`. In multi mode no group is listed and no per-group backlog is read: `items` is empty and `originSync` carries the backlog; group rows of `GET /api/memory/entries` and group details keep each group's own count. In single mode the shared 30-second backlog cache supplies the machine-wide Origin backlog. It appears as a row with `sessionGroup: "origin"` and the regular Sync threshold when `count` is above 0, `syncing` is true or the read reports a `reason`; they are ordered in memory before `q` and paging apply. Order: groups waiting over six hours (`aged`) first; then `count` DESC with unknown counts after known ones; then `firstAt` ASC with unknown last; then `sessionGroup` ASC. Page fields describe all listed groups whatever `q` and the cursor: `summary:{groups,waiting,aged,syncing,unknown,threshold}` (group counts; `threshold` is the sync threshold most groups share, or null), multi mode's cross-group `originSync:{count,pendingSummaries,firstAt,aged,syncing,threshold,lastSyncAt}` and `budgets`. | 400 `invalid_parameter` (with `error.param`) for an unknown, repeated or invalid parameter; 400 `invalid_cursor` for a cursor that is forged, from another search or from before a Dashboard restart (reload the first page); 503 `unavailable` when the backlog cannot be read. Example: `GET /api/memory/backlog?q=telegram&limit=50`. |

Backlog `count`, `firstAt`, `syncing` and `threshold` can be null when unknown; `budgets` is an object or null. Its `limits` map keeps byte numbers for reference INDEX files; `identity.md` and `references.md` have `{maxChars,maxTokens}` startup display limits. `warnings` has byte numbers for INDEX files and `{chars,estimatedTokens}` for startup files (80% of both limits). `checks` maps the two startup filenames to `{chars,estimatedTokens,sizeBytes,maxChars,maxTokens,warnThreshold:{chars,estimatedTokens},status:"ok"|"warning"|"over",budgetUsagePct}` or null when unreadable. Measurements read the current text, independent of runtime; usage is the larger fraction of the two dimensions. These are reporting fields and never prevent writes. Historical C4 groups accepted by group observation reads retain their count and oldest time. Historical groups cannot participate in per-group sync, so `aged:false`, `syncing:null` and `reason:"backlog_failed"` avoid implying an overdue sync. Syncable groups become `aged:true` when the oldest message is over six hours old. Unsafe names have unknown backlog fields. Multi-mode `originSync` is a separate cross-group observation: `count` and `pendingSummaries` are the raw messages and unread group summaries Origin has not taken in yet, `firstAt` the oldest of them, `aged` true once that is over six hours old, `syncing` the Origin Sync lock, `threshold` the cross-group sync threshold, and `lastSyncAt` (Unix seconds) when Origin last moved any group's cross-group cursor, null when never or unreadable.

## Schedules

All reads allow read scope; all writes require admin and browser same origin. A schedule ID is an ASCII letter/digit followed by at most 127 letters, digits, `_` or `-`. Writes go through the scheduler CLI and return `{ok:true,data}`. A rejected CLI result becomes an HTTP error; an unknown outcome is HTTP 502 `scheduler_cli_failed` and must not be automatically repeated.

| Method/path | Parameters and result | Errors / example |
|---|---|---|
| `GET /api/schedules` | Collection under the [list API standard](list-api-standard.md). Filters: `status=all|enabled|paused|failed|completed` (default all; `enabled` is pending or running) and `target=<session-group ID>|origin`; `q` matches the task name only (trimmed, at most 64 characters, case-insensitive substring); `limit=1..100` (default 50), `cursor`, `include=total`. Filters and `q` are bound to the cursor. **Order:** by section — enabled, failed, paused, completed — then enabled tasks by `next_run_at` ascending and the other sections by `updated_at` descending, then task ID ascending; the cursor holds (section, that key, ID). **Target:** a task's delivery target is resolved as at dispatch: its `session_component` (or `reply_channel` when that is empty) is mapped to the namespace of the first session group of that component in the group snapshot, plus `session_group_name` when set; a task with neither column is `origin`. `target` selects tasks whose target is that group ID, in SQL before paging. Returns `{items,nextCursor,total?}` plus page fields `available,readAt,tz,kpi,daily7d,timelineTasks,counts`: `kpi`, `daily7d` and `counts` cover all tasks whatever the filters; `timelineTasks` lists every enabled task with a run in the next 24 hours as `{id,name,priority,nextRuns:{in24h}}`. Rows contain `id,name,promptSummary,promptTruncated,type,status,cron,intervalSeconds,nextRunAt,lastRunAt,updatedAt,priority,requireIdle,missThreshold,recent,nextRuns,target,reply,reenable`; `recent` (last 12 results) is read only for the rows of the page. Without a scheduler database: `{available:false,items:[],nextCursor:null}`. | 400 `invalid_parameter` (with `error.param`), `invalid_cursor`; 503 `unavailable` (scheduler database, or the group snapshot for a group `target`). Example: `GET /api/schedules?status=completed&q=report&limit=50`. |
| `GET /api/schedules/preview` | `kind=cron|every|at`, `value`; optional `reenable=1`, `locale=en|zh`. Returns `{valid,runs?,text?,iso?,error?}`; invalid input is an HTTP error. | 400 `invalid_preview`, `invalid_cron`, `invalid_duration`, `invalid_time`, `reschedule_not_future`; 503 preview/timezone unavailable. Example: `GET /api/schedules/preview?kind=every&value=1h`. |
| `GET /api/schedules/:id` | Full task including `prompt`, recent executions and resolved delivery target; returns `{task}`. | 400 `invalid_task`; 404 `task_not_found`. Example: `GET /api/schedules/daily-report`. |
| `GET /api/schedules/:id/history` | Collection under the [list API standard](list-api-standard.md): `limit=1..100` (default 50), `cursor`. **Order:** `executed_at` descending, then execution ID descending; a cursor is valid only for the same task. Returns `{items,nextCursor}`; rows contain `id,status,executedAt,completedAt,duration,error`. | 400 `invalid_task` for malformed URL encoding, `invalid_parameter` (with `error.param`), `invalid_cursor`; 404 `not_found` (no such task or no scheduler database); 503 `unavailable`. Example: `GET /api/schedules/daily-report/history?limit=20`. |
| `POST /api/schedules` | JSON `{name?,prompt,schedule:{kind:"cron"|"every"|"at",value},priority?,requireIdle?,missThreshold?}`. Routing/delivery fields are not accepted by this form. | 400 invalid form/schedule; CLI validation errors. Example body: `{"name":"Report","prompt":"Summarize progress","schedule":{"kind":"every","value":"1h"}}`. |
| `PUT /api/schedules/:id` | Same editable fields, all optional. A supplied schedule replaces the schedule. | 404 missing task, 409 conflicting task state. Example body: `{"name":"Weekly report"}`. |
| `DELETE /api/schedules/:id` | No body. Removes the named task through Core. | 404 missing task; CLI rejection/unknown errors. Example: `DELETE /api/schedules/daily-report`. |
| `POST /api/schedules/:id/actions/pause` | No body. Pauses the named task. | 404 missing task; 409 invalid current state. Example: `POST /api/schedules/daily-report/actions/pause`. |
| `POST /api/schedules/:id/actions/resume` | No body. Resumes the named task. | 404 missing task; 409 invalid current state. Example: `POST /api/schedules/daily-report/actions/resume`. |

Schedule `nextRunAt`, `lastRunAt`, `updatedAt`, history `executedAt`/`completedAt`, every `runs[]`/`in24h[]` entry and `readAt` are ISO strings (or null where the source is unknown). Scheduler CLI write results project task `created_at`, `updated_at`, `next_run_at`, `last_run_at` and completion/failure fields to ISO too. `duration` is a millisecond duration and `intervalSeconds` is a duration in seconds. Cursor fields are opaque continuation values, not display timestamps.

## Settings and Credentials

| Method/path | Access, input and result | Errors / example |
|---|---|---|
| `GET /api/settings/pricing` | Read. Returns `{active,runtimes:{claude,codex}}`; `active` is the saved instance default. Runtime objects contain built-in model names, effective model prices, priority prices where applicable, configured prices and fast-mode metadata. Prices use input/output/cacheRead/cacheCreation per million tokens. | Common read errors. Example: `GET /api/settings/pricing`. |
| `PUT /api/settings/pricing` | Admin. JSON `{runtimes:{claude?:{modelPrices?,fastModeMultiplier?},codex?:{modelPrices?,priorityModelPrices?}}}`. Returns `{ok:true,active,runtimes}`. Claude multiplier can be null to restore default. Prices must be finite nonnegative numbers; built-in models cannot be removed. | 400 `invalid_pricing` / `invalid_request`; 500 save failure. Example body: `{"runtimes":{"claude":{"fastModeMultiplier":2}}}`. The single-runtime request format is removed. |
| `GET /api/settings/timezone` | Read. Returns `{tz,writable,read_only_reason,restart_services,restart_status}`. `tz` is an IANA name or null; the service list is advisory. | Common read errors. Example: `GET /api/settings/timezone`. |
| `PUT /api/settings/timezone` | Admin. JSON `{tz:string}`. Saves instance `.env` without restarting services; returns `{ok:true,tz,previous,changed,...restartAdvice}`. | 400 `invalid_timezone`, `timezone_unavailable_on_host`; 503 `tz_env_read_error` when `.env` cannot be read; 500 `tz_write_failed` when saving `.env` fails. A body that cannot be read also uses the `invalid_timezone` code rather than the common ones: invalid JSON returns 400 `invalid_timezone` and a body over 4 KiB returns 413 `invalid_timezone`. Example body: `{"tz":"Asia/Singapore"}`. |
| `POST /api/settings/timezone/actions/restart-services` | Admin. JSON confirmation required by the timezone restart action. Restarts only services identified as belonging to this instance. Returns `{ok:true,restarted,failed,restart_services,restart_status}`; failures carry the same fields. A confirmed service that is no longer running when its turn comes is skipped: it appears in neither `restarted` nor `failed`, and the request still returns 200. | 400 `confirmation_required` (body is not exactly `{tz,confirm:true,services}`, `tz` is not a valid time zone name, or `services` is empty, longer than the number of restartable services, or contains unknown or repeated names), `invalid_timezone` (`tz` is not in Dashboard's list of selectable time zones), `timezone_unavailable_on_host`; 409 `timezone_changed` when the saved timezone no longer equals `tz`; 503 `service_discovery_unavailable` (`restart_status:"unknown"`) or `tz_env_read_error`; 502 `restart_failed` when at least one service failed to restart (`failed` names them); 500 `restart_failed` for an unexpected failure (`restart_status:"unknown"`). Example body: `{"tz":"Asia/Singapore","confirm":true,"services":["scheduler"]}`. |
| `GET /api/settings/chat` | Read, including Fleet read proxies. Returns `{chat_allow_remote:boolean}`. This is the sole source of the remote chat/terminal visibility setting. | Common read errors. Example: `GET /api/settings/chat`. |
| `PUT /api/settings/chat` | Local password session only; local only (see Access). JSON `{chat_allow_remote:boolean}`. Returns `{ok:true,chat_allow_remote}`; disabling revokes remote chat/terminal access. | 403 `local_cookie_required` for any API key, admin included; 400 `invalid_chat_settings`; 500 `chat_settings_write_failed`. Example body: `{"chat_allow_remote":false}`. |
| `POST /api/auth/token` | Public credential exchange; requires `Authorization: Bearer <API key>`. Returns `{ok:true,token,expires_at,ttl_seconds,scope}`. The API key is not itself a data-access bearer token. | 401 `invalid_api_key`. Example: `POST /api/auth/token` with the key header. |
| `GET /api/keys` | Admin; local only (see Access). A list under the list API standard: `q` (matches the key name, case-insensitive), `limit=1..100` (default 50), `cursor`, `include=total`. Returns `{items,nextCursor,total?,counts:{active,revoked}}`; each item is `{name,scope,created_at,last_used_at,revoked_at,status:"active"|"revoked"}` (key material and hashes are never returned). Order: active keys before revoked ones, then `created_at` DESC, then key ID DESC. `total` counts the keys matching `q`; `counts` covers every key, whatever the search. | 400 `invalid_parameter` (with `error.param`) for an unknown, repeated or invalid parameter; 400 `invalid_cursor` for a cursor that is forged, from another search or from before a Dashboard restart (reload the first page); 503 `unavailable` when the key table cannot be read; common access errors. Example: `GET /api/keys?q=ci&limit=8&include=total`. |
| `POST /api/keys` | Admin; local only (see Access). JSON `{name,scope}`; `scope` is `read` (default), `admin` or a comma-separated permission list (see [API key scopes](#api-key-scopes)) and is stored normalized. Returns `{ok:true,key,plaintext_key}`. The key is shown once; the list is read again with `GET /api/keys`. | 400 `invalid_name`, `invalid_scope` (empty list or unknown name) or `duplicate_name` when the name already exists at validation; 403 `local_cookie_required` when an API key asks for `admin`; 409 `name_taken` if a concurrent insert wins the database unique constraint. Example body: `{"name":"restarter","scope":"groups.read,groups.control"}`. |
| `PATCH /api/keys/:name` | Admin; local only (see Access). JSON `{scope}` in the same form as creation. Changes an active key's scope and returns `{ok:true,key}`; the key's existing tokens follow on their next request. | 400 `invalid_name`, `invalid_scope`; 403 `local_cookie_required` when an API key changes a key to or from `admin`; 404 `unknown_key` (no active key of that name). Example: `PATCH /api/keys/restarter` with `{"scope":"groups.read,groups.control,groups.settings"}`. |
| `POST /api/keys/:name/rotate` | Admin; local only (see Access). Returns `{ok:true,key,plaintext_key}` with replacement material once; the scope is kept. | 403 `local_cookie_required` when an API key rotates an admin key; 404 `unknown_key`. Example: `POST /api/keys/reader/rotate`. |
| `DELETE /api/keys/:name` | Admin; local only (see Access). `permanent=1` permanently removes an already revoked key and returns `{ok:true,deleted}`; otherwise revokes it and returns `{ok:true}`. | 404 `unknown_key`; 409 `must_revoke_first`. Example: `DELETE /api/keys/reader`. |
| `POST /api/keys/purge-revoked` | Admin; local only (see Access). Returns `{ok:true,purged}`. | Common write errors. Example: `POST /api/keys/purge-revoked`. |
| `GET /login`, `POST /login` | Public password login form and submission (`application/x-www-form-urlencoded`, password, optional remember). Success redirects and sets the scoped secure session cookie. Failure renders HTML. | Invalid credentials/rate limit are rendered on the form. Example: `GET /login`. |
| `POST /logout` | Browser session logout; clears cookie and redirects. | Always clears the session, including when Origin is missing or mismatched; no same-origin precondition. Example: `POST /logout`. |

## Conversations

**Access:** Admin for all conversation content, metadata, attachment and chat push routes below. The remote chat switch must be enabled for API-session access. All conversation content and attachment reads require admin scope at both the local and destination instances; read keys receive 403. Writes also require admin and browser same origin. `GET /api/settings/chat` remains read-scoped because it exposes only the access setting. Local password sessions can read their own instance independently of the remote switch. Conversation IDs are opaque and must be URL-encoded; query parameters are validated per route. Take `items[].id` from `GET /api/conversations` (or `conversation.id` from draft creation). For example, Origin has ID `g:6F726967696E`, encoded as `g%3A6F726967696E`; the group key `origin` is not a chat conversation ID. Use the returned ID for subsequent conversation requests, with the same `tab` where supported. Message IDs come from `items[].id` in that conversation’s `/messages` response.

| Method/path | Contract and minimal example |
|---|---|
| `GET /api/conversations` | Optional `tab` (`mine` by default or `external`), `q`, `limit` (1–100, default 50), and `cursor`. Returns `{items,nextCursor,tz,deletionAllowed}`. Example `GET /api/conversations?tab=mine&q=work&limit=20`. |
| `PUT /api/conversations/pins` | Optional `tab` (`mine` by default or `external`). JSON `{ids:string[]}` replaces the complete order for that tab and returns `{ok:true,ids}`. Use `[]` to clear the order. An identical replacement is idempotent. Example `PUT /api/conversations/pins?tab=mine` with `{"ids":["g:64617368626F6172643A776F726B"]}`. |
| `GET /api/conversations/:id` | Returns reconciliation receipt plus conversation metadata. Example: `GET /api/conversations/g%3A6F726967696E`. |
| `POST /api/conversations/drafts` | JSON `{displayName?}` → `{ok:true,conversation}` (201). Example body: `{}`. |
| `PATCH /api/conversations/:id` | JSON `{displayName}` → `{ok:true,conversation}`. Example body: `{"displayName":"Work"}`. |
| `POST /api/conversations/:id/send` | JSON `{content,retry?,attachments?,quote?}` → `{ok:true,...receipt}`. Uncertain delivery is not safe to repeat automatically. Example body: `{"content":"Hello"}`. |
| `GET /api/conversations/:id/messages` | `tab`, `limit`, `cursor`, `direction` (`before` by default or `after`), `recheckIds`, and first-page `anchor=read` for `mine`. Returns paged messages, `nextCursor`, `afterCursor`, and `tz`. The read anchor also returns `readUpTo` and `unreadCount`. Example `GET /api/conversations/g%3A6F726967696E/messages?anchor=read`. |
| `PUT /api/conversations/:id/read` | JSON `{upTo:number}` advances the recorded read position for a `mine` conversation, including Origin. Returns `{ok:true,readUpTo}`. The ID must belong to that conversation's message page. Example `PUT /api/conversations/g%3A6F726967696E/read` with `{"upTo":123}`. |
| `GET /api/conversations/:id/status` | Optional `tab`; required `ids` is a comma-separated list of 1–100 distinct positive message IDs from `/messages` → `{items:Array<{id,direction,status,delivery_action,deliveryState}>}`. Example: after `/messages` returns an item with `id:123`, `GET /api/conversations/g%3A6F726967696E/status?ids=123`. |
| `GET /api/conversations/:id/activity` | `tab,subtask` → current conversation activity. `steps` can include `{kind:"commentary",at,text}`. A tool label summarizing several commands can include `count` and `more` (`files` or `commands`); labels do not carry command lines or output. Example: `GET /api/conversations/g%3A6F726967696E/activity`. |
| `GET /api/conversations/:id/questions` | Optional `limit=1..100` (default 50), `cursor`. Returns `{items,nextCursor}` with interactive questions for the stored conversation. Example: `GET /api/conversations/g%3A6F726967696E/questions`. |
| `POST /api/conversations/:id/answers` | JSON control answer payload validated against the stored question/control; returns `{ok:true,...receipt}`. Example: JSON `{interruptId,action,retry?}`, using the stored question/control action from the question response. |
| `GET /api/conversations/:id/uploads/config` | Returns `{maxUploadBytes:number,maxAttachments:number}` for a writable conversation. Example: `GET /api/conversations/g%3A6F726967696E/uploads/config`. |
| `POST /api/conversations/:id/uploads` | Multipart file upload → `{ok:true,id,name,size,mime,kind}` (201). Example: multipart field `file` containing one supported file. |
| `GET /api/conversations/:id/attachments/:attachmentId` | Streams authorized file bytes with safe content type/disposition. Example: `GET /api/conversations/g%3A6F726967696E/attachments/<id>`. |
| `GET /api/conversations/drafts/:id/deletion` | Local-owner-only draft deletion preview. Here `:id` is the bare `conversation.localId` returned by `POST /api/conversations/drafts`, also available as `items[].localId` on draft rows in the conversation list. Do not pass the `d:`-prefixed conversation ID. Example: with `localId:"550e8400-e29b-41d4-a716-446655440000"`, `GET /api/conversations/drafts/550e8400-e29b-41d4-a716-446655440000/deletion`. |
| `DELETE /api/conversations/drafts/:id` | Local-owner-only; `:id` is the same bare `localId` used for the preview. JSON `{confirmed:true,operationId,cutoffId}` from the preview. Returns `{ok:true,...deletionResult}`. Example: `DELETE /api/conversations/drafts/550e8400-e29b-41d4-a716-446655440000` with the preview's confirmation values. Passing `d:<uuid>` returns 404 `chat_conversation_not_found`. |

`GET /api/conversations`, `GET /api/conversations/:id/messages`, `GET /api/conversations/:id/status`, and `GET /api/conversations/:id/activity` read the optional `X-Zylos-Locale` request header. The exact value `en` selects English. An omitted header or any other value selects Chinese (`zh`). The locale controls server-generated preview text in list and message responses, including attachment labels and quoted-message previews. List searches also match unnamed conversations against the localized fallback title.

The list follows the [Dashboard List API Standard](list-api-standard.md). It returns the newest received message time as the row's ISO 8601 `stamp`, with the conversation ID as a unique ascending tie-breaker. If a conversation has never received a message, its first visible message sets the time. The latest visible non-internal message supplies `preview` and `previewDirection` even if an outbound reply left the sort time unchanged. Received internal relays and tasks can set the sort time. Drafts in `mine` retain their own time. Legacy history with an empty session group stays accessible by its `l:` message route but is omitted from the collection.

The unfiltered first `mine` page puts Origin first. Each tab inserts its own complete pin order on its first page before the ordinary time-ordered rows. Pins have a zero-based `pinOrder`. Origin and pins do not use a slot or affect the cursor. Search trims and matches `q` case-insensitively against display names and session group IDs, up to 64 characters. It never searches message content. For nonempty `q`, all matches, including pins and Origin, take part in normal ordering, paging and limits. Matching pins retain `pinOrder`. Cursors must be reused with the same tab and trimmed query. After `invalid_cursor`, request the first page with those filters.

`PUT /api/conversations/pins` uses chat admin and browser same-origin checks. Pass unique IDs of established conversations belonging to the selected tab. Origin, drafts, missing conversations, IDs from another tab, and duplicates are rejected as `invalid_chat_pin` (400). Malformed encoded IDs can return `invalid_chat_conversation` (400). Invalid write parameters return `invalid_chat_parameters` (400). Validation failures preserve the old order.

`mine` list rows carry a boolean `unread`. It compares the last read position with the newest visible message other than a Dashboard inbound message written by the owner. After upgrading, existing messages start as read. An accepted send with a stored message ID advances the sender's read position to that ID. `PUT /api/conversations/:id/read` requires admin and browser same origin, including when proxied through Fleet. A valid lower position leaves the position unchanged. An invalid or unrelated message ID returns 400 `invalid_parameter` with `error.param: "upTo"`. An ID outside the `mine` conversation set returns 404 `not_found`.

The read anchor returns messages on both sides of the saved position, with up to half the page after it and earlier messages filling any remaining space. It uses the saved ID even if that message was removed. `unreadCount` counts only messages that can make the conversation unread and is capped at 100. `nextCursor` reads earlier messages and `afterCursor` reads later messages. A first page without an anchor uses normal timeline paging and leaves out `readUpTo` and `unreadCount`. `anchor=read` is only valid without a cursor and in `mine`.

The list, messages, status and activity use the common error envelope with 400 `invalid_parameter` (includes `error.param`), 400 `invalid_cursor`, 404 `not_found`, or 503 `unavailable` as applicable. Existing access and other write error codes still apply. Authenticated requests to the retired `/api/chat/*` path family return 404. Chat settings stay at `/api/settings/chat`. Attachment downloads are binary. The existing `chat_messages_changed` hint also reports changes to the relevant tab's ordering, pins and read positions so clients can fetch current data.

## Terminal Observer and History

**Access:** Read for observer status; Admin for every terminal-history route and live terminal resource. Read-scope callers can read observer status when remote access is enabled. All four terminal-history reads require admin at both the local and destination instances; read keys receive 403. Administration, terminal-size changes and leases require admin and browser same origin. `/observer/frame` and `/observer/stream` are lease-bound terminal resources, not read-key data APIs. Install/enable/disable/uninstall retain their existing coordinator semantics.

| Method/path | Contract and minimal example |
|---|---|
| `GET /api/observer/status` | Optional `session_group` (default Origin); returns installation/enable state, target/runtime/startup status and agent size. Example: `GET /api/observer/status?session_group=origin`. |
| `POST /api/observer/agent-size` | JSON size and optional `sessionGroup`; optional query `session_group`. Returns `{ok:true,...sizeResult}`. Example body: `{"cols":120,"rows":40,"sessionGroup":"origin"}`. |
| `POST /api/observer/install` | Installs/enables observer; returns `{ok:true,...publicStatus}`. Example body: `{}`. |
| `POST /api/observer/enable` | Enables installed observer; returns `{ok:true,...publicStatus}`. Example body: `{}`. |
| `POST /api/observer/disable` | Revokes leases/streams, disables observer; returns `{ok:true,...publicStatus}`. Example body: `{}`. |
| `DELETE /api/observer/install` | Uninstalls and revokes access; returns `{ok:true,...publicStatus}`. Example: `DELETE /api/observer/install`. |
| `POST /api/observer/leases` | Optional JSON `{sessionGroup}`; returns `{ok:true,...lease}` (201). The lease binds identity and target. Managed Origin/group targets support `claude`, `codex` and `agy` with the same validated tmux target and run identity checks. Example body: `{"sessionGroup":"origin"}`. |
| `POST /api/observer/leases/:id/renew` | Renews the same principal's lease → `{ok:true,...lease}`. Example: `POST /api/observer/leases/<id>/renew`. |
| `POST /api/observer/leases/:id/release` | Releases owned lease → `{ok:true,released:true}`; missing owned lease is idempotent. Example: `POST /api/observer/leases/<id>/release`. |
| `GET /observer/frame` | HTML terminal frame; `X-Observer-Lease` header required. HEAD is supported. Example: `GET /observer/frame` with lease header. |
| `GET /observer/stream` | WebSocket upgrade with the observer protocol and lease credentials. Query parameters are rejected. Example: connect to `/observer/stream` using the issued lease. |
| `GET /api/observer/history/sessions` | Optional `session_group` (default Origin), `limit` and `cursor` → `{items,nextCursor,runtime,current}`. Rows contain `id`, `kind`, `title` and ISO `updatedAt` or null, ordered by `updatedAt` descending then ID ascending, even across runtimes. `current` is a session ID or null and may refer to a later page. Example: `GET /api/observer/history/sessions?session_group=telegram%3Ateam`. |
| `GET /api/observer/history/entries` | Same group, required `session`, optional `internal=true\|false` (default false), `direction=before\|after` (default before), `limit` and `cursor`. First page opens at the newest entries or at `anchor=<entry-id>`. Returns `{items,nextCursor,afterCursor,updates}`. Example: `GET /api/observer/history/entries?session_group=origin&session=<id>`. |
| `GET /api/observer/history/content` | Same group, required `session,entry,field`, optional text `offset` → UTF-16 text chunk `{text,offset,next,total}` or binary bytes. Example: `GET /api/observer/history/content?session_group=origin&session=<id>&entry=o:0&field=text`. |
| `GET /api/observer/history/search` | Same group, required `session,q` (2–200 chars), optional `limit=1..200`, `before` and `internal=1` to include internal entries → `{matches:Array<{entry,snippet}>,before,hasMore}`. Example: `GET /api/observer/history/search?session_group=origin&session=<id>&q=hello`. |

Both lists use `limit=1..100` (default 50) and signed cursors bound to the group and, for entries, the session and `internal` filter. Unknown, repeated or invalid parameters return 400 `invalid_parameter` with `error.param`; invalid cursors return 400 `invalid_cursor` and the affected list silently retries without the cursor. An unreadable dependency returns 503 `unavailable`. There is no alternate legacy list format.

Entries are ordered oldest to newest within a page by transcript order: numeric source-record position and then the entry ID's numeric block index (an unnumbered block sorts first). The stable entry ID encodes both parts; a cursor is not a row offset. `nextCursor` reads older entries and is null when there are no more. `afterCursor` is always a signed position, including at the newest boundary or in an empty session. Pass it as `cursor` with `direction=after`; fewer than `limit` items means the reader has caught up for now. Forward reads also return `updates` for late replacements of already visible tool or outbound entries. `anchor` cannot be combined with `cursor`. The session list rescans discovery per request and the entry route still reads the scoped transcript; this change does not add an index or cache.

All four history routes validate group scope as in group detail. In single mode only Origin is valid; offline groups are available in multi mode using imported attribution and transcript files without acquiring a terminal lease. Entries, content and search use the session's recorded runtime. Antigravity scopes return an empty list because native transcript reading is not integrated. Unknown or out-of-scope sessions return 404 `not_found` for entries and 404 `session_not_found` for content/search. Content and search retain their original group errors (400 `invalid_session_group`, 502 `group_catalog_unreadable`). Search is a find-in-transcript operation, like Ctrl+F, not a collection list; it retains its own match and continuation format. Content retrieves text chunks or binary data, not a list.

Missing/disabled observer history returns 404. Rejected `/observer/stream` upgrades use the common JSON error envelope (including 401 `unauthorized`, 403 `same_origin_required` and 404 `not_found`); terminal stream failures close the connection after upgrade.

## Fleet

`GET /api/fleet` is a read-scoped status API. Configuration and probe routes are admin and local only (see Access). A remote request is authorized both on the local proxy and the destination. Fleet checks the remote `GET /api/instance` field `versions.zylos.installed` before opening its page or reading its other APIs. Versions before `1.0.0-beta.16` and peers that answer `/api/instance` with 404 show `health_reason: "version_unsupported"`. Direct Fleet page and API requests for these peers return 502 `version_unsupported`. An instance response whose version is missing, empty or unparsable, or whose body cannot be read, is a `bad_payload` failure and does not change an earlier version check. After a complete successful read, `timeout`, `conn_refused`, `unreachable` and `bad_payload` failures keep the last state and data until reads have kept failing for 30 seconds, counted from the first failure since that success; the first failure after that marks the machine `OFFLINE`. `last_seen` remains the time of the last complete successful read. `auth_failed`, `version_unsupported` and failures of a machine never read successfully apply immediately.

| Method/path | Contract and minimal example |
|---|---|
| `GET /api/fleet` | Read. Returns `{items,nextCursor,total?,summary,updated_at}` with self and remote status records. Ordered with this machine first, then by unique name (English collation with a binary tie-breaker). Accepts `q` for name search and `name` for an exact match (zero or one row). For example, `GET /api/fleet?limit=8`. |
| `GET /api/fleet/agents` | Local admin. Returns `{items,nextCursor,total?,self:{name}}` ordered by unique name (English collation with a binary tie-breaker). `q` searches names. A row contains `{name,base_url,key_masked,access,connection,latency}`. `access` is `"admin"` with a cached admin session, otherwise `"read"`. `connection.kind` is `unknown`, `pending`, `auth`, `version`, `down` (with `reason`), or `ok` (with `latency` in milliseconds or null). `latency.samples` contains `{at,ms}` probe samples. For example, `GET /api/fleet/agents?limit=8&include=total`. |
| `POST /api/fleet/agents` | JSON `{name,base_url,read_api_key}` → `{ok:true,agent:{name,base_url,key_masked,access}}` (200). Input is validated, then the destination is probed before saving; a failed probe does not reject the addition. `access` is `"admin"` or `"read"` when the probe established that API-session scope, or `"unknown"` when the probe failed (including invalid credentials or an unreachable destination). Validation returns 400 `invalid_name`, `reserved_name`, `duplicate_name`, `invalid_url` or `missing_read_api_key`; save failure returns 500 `failed_to_save_config`. Example body: `{"name":"worker","base_url":"https://worker.example/dashboard","read_api_key":"<key>"}`. |
| `POST /api/fleet/agents/test` | JSON `{base_url,read_api_key}` → `{ok:true,reachable:true,scope,version}`. Validation returns 400 `invalid_url` or `missing_read_api_key`. A failed destination probe returns HTTP 502 with `{ok:false,reachable:false,error:{code,message}}`; the code is `auth_failed`, `version_unsupported` or `unreachable`. Example: same destination/key as an add request. |
| `DELETE /api/fleet/agents/:name` | Removes the configured remote → `{ok:true}`. Returns 400 `invalid_name` for an undecodable name, 404 `unknown_agent` when no remote has that name, and 500 `failed_to_save_config` when saving fails. For example, `DELETE /api/fleet/agents/worker`. |
| `GET /fleet/:name/*` | Proxies allowed read routes/assets using configured credentials. Reads of local-only routes return 403 `local_endpoint_not_proxyable`, and deletion previews return 403 `remote_deletion_forbidden` (see the write row). Example: `GET /fleet/worker/api/settings/chat`. |
| `PUT`, `PATCH`, `POST`, `DELETE /fleet/:name/*` | Only explicit object-write allowlist entries are proxyable, with admin and browser same origin. Allowed writes include group display names, the machine avatar and marking a Mine conversation read. Three refusals apply: a local-only route (see Access; reads and writes alike) returns 403 `local_endpoint_not_proxyable`; group and draft deletion and deletion previews (`/api/groups/:id`, `/api/groups/:id/deletion-preview`, `/api/conversations/drafts/:id`, `/api/conversations/drafts/:id/deletion`; any `DELETE`, and any method on the preview/deletion paths) return 403 `remote_deletion_forbidden`; any other write outside the allowlist returns 403 `not_allowed_via_fleet`. Example: `POST /fleet/worker/api/schedules/report/actions/pause`. |

Both Fleet lists accept `limit` (1–100, default 50), `cursor`, `q` (trimmed, case-insensitive name substring, up to 64 characters), and `include=total` (matching row count). A bad parameter returns 400 `invalid_parameter` with `error.param`. An invalid cursor returns 400 `invalid_cursor`. An unavailable source returns 503 `unavailable`. The client starts from page one if a cursor expires after a restart.

`summary` covers the whole fleet even when filters are active. It contains `count`, `counts:{busy,idle,stuck,offline}`, and `daily_cost` and `weekly_cost` (numbers, or null when no machine reports that tier). The Fleet wall reloads its current page after a `fleet` event and plays start/finish cues for machines on that page. Wall rows carry the current `link` observation and an `avatar_version` (string or null). A remote row uses the last version reported by the peer's instance API. Unset avatars and older peers without the field report null. Probe sample history is returned on the configured-machine list.

Fleet rejects unknown agents with 404, invalid memory path queries with 400 `invalid_memory_path`, and upstream failures with 502/504. Suffix handling depends on the path:

- Encoded slash `%2F` (case-insensitive), undecodable percent encoding, and paths whose decoded/normalized suffix reaches a local-only endpoint (including through `..`) return 403 `local_endpoint_not_proxyable`.
- `/fleet/peer//api/...` bypasses API proxy dispatch and falls through to page serving: GET returns 404 plain text `not found`; POST returns 405 plain text `method not allowed`.
- Encoded `%2e%2e` reaching another route is not rejected as `local_endpoint_not_proxyable`; a write outside the explicit proxy allowlist returns 403 `not_allowed_via_fleet` with message "This change can't be made when opening another agent from the fleet".
- Encoded backslash `%5C` is forwarded unchanged in an otherwise allowed API request.

Other forbidden routes return 403. Same-version peers return the common JSON error envelope, which the proxy relays unchanged. Attachment, observer WebSocket and SSE relays keep their streaming content types.

## Push

### GET /api/stream

**Access:** Read for the ordinary stream. Chat subscriptions additionally use the existing chat-access rules (local owner or permitted remote chat access). The ordinary stream does not check the request method: `GET`, `HEAD` and `OPTIONS` need read access, and any other method (for example `POST`) opens the same stream after passing the common write check (admin scope, and same origin for browser cookies). A chat subscription (a request with the `chat` parameter) accepts only `GET`; any other method, including `HEAD` and `OPTIONS`, returns 404 `not_found`.

**Parameters:** no parameters for ordinary instance events. Chat opt-in requires admin at both instances and uses `chat=1`, optional `chat_tab=mine|external` (default mine) and `chat_conversation` (an encoded conversation ID); repeated subscription parameters and legacy `chat_ids` are invalid; invalid subscriptions are rejected rather than treated as an ordinary stream. Response is `text/event-stream`, not JSON.

Opening the stream samples current session state immediately. While at least one Dashboard stream is connected, session observations refresh every 2.5 seconds and are shared by Origin, group and Fleet projections. Closing the last stream stops periodic session reads. HTTP instance reads still sample on demand. Fleet reads use the shared observation cache while a stream is connected and force a fresh local observation when no stream is connected.

| SSE event | Data | Meaning |
|---|---|---|
| `instance` | Same object as `GET /api/instance` | Instance overview changed; also sent when the ordinary stream opens |
| `groups` | Same object as `GET /api/groups/counts` | Counts or running-list observations changed; fetch lists if needed |
| `fleet` | `{summary,updated_at}` as in `GET /api/fleet` | Remote or local Fleet changed. Fetch the current page if it is open. |
| `history_changed` | Existing history invalidation payload | Imported events changed |
| `metric_update` | Existing metric-update payload | A collector published a metric sample |
| `chat_*` | Existing chat subscription event payloads | Conversation data/activity invalidation |
| `auth_expired` | Existing expiry payload | Authorization expired; reconnect after authentication |

Fleet shows instance and group summaries only. It does not fetch Origin group detail, read Origin session metadata, or expose `model`, `effort`, `context_pct` or `new_session_threshold` on Fleet records. These observations remain in group detail and runtime settings. Single-session cards show only the actual state pill. Fleet records do not include current-action text or feeds; aggregate `BUSY` retains the Working label without implying a thinking or tool-activity observation. A known runtime authentication failure remains an error for a running-list row whose activity state is unknown. Its independent no-response count comes from `counts.running.flags.noResponse`; problem durations use `flags.noResponse.since`. Error precedence still keeps the summary categories mutually exclusive, so its no-response category can be smaller than the independent no-response count.

The self Fleet record's `daily_cost` and `weekly_cost` (in `GET /api/fleet`) are the `today.cost` and `sevenDay.cost` of `GET /api/usage/summary` at the time they are read. The self record may reuse them for up to 30 seconds. A new instance-local day or a time-zone change reads them again immediately. `GET /api/usage/summary` and group usage reads are not cached.

Multi-session Fleet `group_summary` optionally includes `attention`, projected from the same observations as Overview. Supported kinds are `channel_send_failed`, `channel_restarting`, `start_failed`, `rate_limited` and `data_unreadable`. Items carry only applicable bounded text fields (`group`, `displayName`, `runtime`, `channel`, `service`, `reasonCode`, `source`), nonnegative `count`/`count30m`, and `until:string|null` (ISO UTC recovery time; null means unknown). Channel items have no group link. Group unreadability includes the group name/key and diagnostic reason; clients render reason text through text nodes. Existing running/counts/problems semantics remain unchanged, and older remote summaries without `attention` remain valid. Offline start failures use the existing filtered offline resource, including pagination; a failed read remains a diagnostic observation.

If the group catalog cannot be read, ordinary stream and Fleet retain known rows and publish counts with `listKnown:false`; they do not drop unrelated updates. Direct counts, offline and search reads retain their explicit catalog errors.

The ordinary stream does not emit `state_change` or `fleet_state`. Chat connection-limit exhaustion returns an explicit HTTP 429; it does not silently fall back to the ordinary stream.

The Dashboard reconnects an established conversation stream directly with its existing backoff after a database generation change or transport closure. An admission-status probe is needed only when a conversation stream fails before opening; a confirmed HTTP 429 selects the ordinary stream while the conversation subscription is retried later. Database absence alone keeps the existing stream open; restoration to a new generation resumes live updates through one application reconnect.

A `chat_ready` catchup hint remains pending when a metadata read is superseded by reselecting the same conversation. The existing polling scheduler immediately retries that hint for the still-selected subscription; a changed conversation or instance does not inherit it.

**Errors:** 400 `invalid_chat_subscription`, `invalid_chat_tab` or `invalid_chat_conversation`; 403 chat-access refusal; 429 `chat_connection_limit`; common read errors. After headers are sent, authentication failure is delivered through stream lifecycle/events rather than a new JSON response.

Example: `GET /api/stream` with `Accept: text/event-stream`.

## Implementation Navigation

- HTTP dispatch, instance projection and object action routing: [src/index.js](../src/index.js).
- Group states, flags, membership and pagination: [groups-api.js](../src/lib/workbench/groups-api.js).
- Group config/actions/runs/backlog/deletion: adjacent Workbench modules.
- Usage windows, attribution and pricing: [usage-api.js](../src/lib/workbench/usage-api.js), [cost-query.js](../src/lib/workbench/cost-query.js), [usage-series.js](../src/lib/workbench/usage-series.js).
- Readiness and push: [readiness.js](../src/lib/readiness.js), [sse.js](../src/lib/sse.js), [chat/stream.js](../src/lib/chat/stream.js).

Retired state/system/metric/Workbench group and usage paths are absent from the public API and return 404; callers must use the object APIs above. Fleet mixed-version reads do not fall back to retired state paths.

### Session hosting

`GET /api/session-hosts` returns the local session hosting settings. All
session hosting routes require the local Dashboard admin login cookie and are
unavailable through the Fleet proxy. `POST` also requires a same-origin request.

```json
{
  "items": [
    {"source_group":"multica:issue-12","target_group":"telegram:topic-1","attached_by":"telegram:topic-1","attached_at":"2025-10-09T08:53:20.000Z"}
  ],
  "nextCursor": null,
  "allowlist": ["multica"]
}
```

Each active relationship lists its source, effective target, initiating group
and creation time. The timestamp is an ISO 8601 UTC string or null. The
allowlist holds channel names whose attach notifications are muted. Relationships
are ordered by `source_group` ascending (binary order, unique primary key).
`q` searches the source or target group by case-insensitive substring (trimmed,
up to 64 characters). Use `limit` (1–100, default 50), `cursor`, and
`include=total` for the matching count, for example
`GET /api/session-hosts?limit=8&include=total`. A bad parameter returns 400
`invalid_parameter` with `error.param`, and an invalid cursor returns 400
`invalid_cursor`. If the store cannot be read, this list returns 503 `unavailable`.

`GET /api/session-hosts/channels` takes no parameters and lists the channel
component names registered in the local C4 database. Names appear once, in
alphabetical order. Channels already on the notification allowlist are included.

```json
{"channels":["dashboard","multica","telegram"]}
```

An unauthenticated request returns HTTP 401. An API session cannot replace the
local admin login cookie and returns HTTP 403. An unavailable C4 store returns
HTTP 502 from the channel options route.

`POST /api/session-hosts` accepts a JSON object with one of these actions.

| Action | Additional field |
|---|---|
| `detach` | `group`, the source session group |
| `allow` or `disallow` | `channel`, the component name |

For example, `{"action":"detach","group":"multica:issue-12"}` ends the
relationship. The response is `{changed,allowlist}`, with a boolean `changed` and the current channel list. A change to the notification allowlist sends an owner
notice. Invalid input returns HTTP 400, failed access checks return 403,
and an unavailable C4 store returns 502.
