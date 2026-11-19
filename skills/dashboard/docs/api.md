# Dashboard API Reference

## Module Responsibilities

This reference describes Dashboard HTTP routes, including health, instance, session groups, usage, memory, schedules, settings, chat, terminal history, Fleet and push. Any PR that changes an API documented here must update this file in the same PR. Check methods, paths, parameters, permissions, fields and errors against the implementation, rather than copying a design proposal.

Paths are relative to the Dashboard base URL. For example, with the default HTTP mount, `/api/instance` is available at `/dashboard/api/instance`. Group IDs are URL-encoded session-group keys such as `telegram%3Aexample`, or `origin` for the single session and the multi-session Origin. Display names are not IDs.

## Access and Common Results

- **Public**: no login required.
- **Read**: an authenticated browser session or an API session with `read` or `admin` scope. An API key must first be exchanged for an API session through the existing authentication API.
- **Admin**: an authenticated administrator. Browser-cookie writes also require a same-origin request. Read-scope API sessions cannot write or read conversation content, attachments or full terminal history.
- **Local owner**: an administrator logged in with the local password cookie. API keys do not grant deletion or deletion-preview access, even with admin scope.
- **Local only**: answered only by the instance's own Dashboard, never through the Fleet proxy. A request to `/fleet/:name/...` for one of these routes returns 403 `local_endpoint_not_proxyable`. This covers `/api/keys` and everything under it, `/api/fleet/agents` and everything under it, `/api/instance/name`, and writes to `/api/settings/chat`.

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
| `GET /api/health/ready` | Public | `ready:boolean`, `reason:"supervisor_unavailable"\|"session_not_running"\|null`, `session_mode:"single"\|"multi"\|"unreadable"`, `session_running:boolean\|null`; `runtime_health.claude` and `.codex` each contain `source:"record"\|"missing"\|"unreadable"`, `health:"ok"\|"auth_failed"\|"rate_limited"\|"unavailable"\|"down"\|"recovering"\|null` |
| `GET /api/health` | Public | `ok:boolean`, `service:string`, `bootId:string` identifies this Dashboard process and changes when it restarts |
| `POST /api/auth/token` | Public credential exchange | Bearer `zylos_ak_...` key returns `ok:true`, `token:string` (`zylos_st_...`), `expires_at:string` (ISO), `ttl_seconds:number` (86400), `scope:"read"\|"admin"` |
| `GET /api/instance` | Read | `agent.name:string`, `default_runtime:string`, `session_mode:object` with `sessionMode:"single"\|"multi"\|"unreadable"`; see [instance fields](#get-apiinstance) for additional observations |
| `GET /api/groups/origin` | Read | `presence:"running"\|"starting"\|"not_running"\|"unknown"`, `state.kind:"working"\|"idle"\|"starting"\|"stopping"\|"offline"\|"unknown"`, `flags:object`, `run:{runId:string\|null,sessionId:string\|null,createdAt:string\|null}\|null` |
| `POST /api/groups/origin/actions/interrupt` | Admin | JSON `{runId:string,sessionId?:string\|null}`; result fields described below |
| `POST /api/groups/origin/actions/chop-chop` | Admin | Same target body as interrupt; result fields described below |
| `POST /api/groups/origin/actions/restart` | Admin | JSON `{runId?:string,sessionId?:string\|null}`; result fields described below |
| `GET /api/groups/counts` | Read | `readAt:string` (ISO), `listKnown:boolean`, `running:{total:number,states:object,flags:object}`, `offline:{total:number,waitingSlot:number,startFailed:number}`, `pool:{used:number\|null,capacity:number\|null}\|null` |
| `GET /api/usage/summary` | Read | `tz:string`, `tzFallback:boolean`, `scope:"all_groups"`, `today:object`, `sevenDay:object`; period and runtime fields described below |

Readiness returns **HTTP 503 when not ready**, with `ready:false`, `reason` and all the other listed readiness fields still present in the JSON body. Read this body as observation data even on 503. `session_running` is observed only in single mode and is null in multi mode. Runtime health is diagnostic and does not itself determine readiness; missing/unreadable health is null. `/api/health` only establishes HTTP liveness. Use `/api/health/ready`, never the retired `?probe=ready` query.

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

Returns `ready:boolean`, `reason:string|null`, `session_mode:"single"|"multi"|"unreadable"`, `session_running:boolean|null`, and `runtime_health:object` keyed by `claude`, `codex` and `agy`. Each runtime entry has `source:"record"|"missing"|"unreadable"` and `health:string|null`. A responsive supervisor establishes readiness unless an instance without a `session_mode` key (from before session modes) has its session confirmed absent; `session_running` is reported only for such instances and is `null` otherwise. Runtime health is diagnostic, not an admission gate.

**Errors:** HTTP 503 with `{ok:false,error:{code,message},...readiness}` when `ready:false`; `reason` is `supervisor_unavailable` or `session_not_running`. Unavailable observations remain null.

Example: `GET /api/health/ready` → `{"ok":false,"error":{"code":"supervisor_unavailable","message":"supervisor_unavailable"},"ready":false,"reason":"supervisor_unavailable","session_mode":"multi","session_running":null,"runtime_health":{"claude":{"source":"missing","health":null},"codex":{"source":"missing","health":null},"agy":{"source":"missing","health":null}}}`.

## Instance

### GET /api/instance

**Access:** Read. **Parameters:** none.

| Field | Type | Meaning |
|---|---|---|
| `agent` | object | Configured instance identity, including `name:string` and generated color fields |
| `tz` | string | Instance time zone used for display and usage calendar windows |
| `session_mode` | object | Core mode and transition state, described below |
| `default_runtime` | string | Configured default runtime |
| `defaults` | object | Runtime-keyed default objects described below |
| `versions` | object | Runtime-keyed `zylos`, `claude`, `codex`, `agy` objects: `{installed:string\|null,latest:string\|null,update:string\|null}`; `update` identifies an available newer version |
| `runtimeHealth` | object / null | Runtime-keyed health observations, including health and cooldown evidence |
| `accounts` | object / null | Runtime-keyed weekly account quota objects or null; observations include used percentage, reset time, `recordedAt` and `live` |
| `supervisorPaused` | boolean / null | Whether new supervisor actions are paused |
| `autoRestarts` | object / null | `{count:number}` automatic restarts recorded during the past hour |
| `resources` | object | One current resource sample: `scope:"host"\|"container"\|"mixed"`, `sampledAt:string\|null` (ISO), `cpu_pct:number\|null`, `cpu_count:number\|null`, `cpu_source:"container"\|"host"`, `mem_pct:number\|null`, `mem_used_bytes:number\|null`, `mem_total_bytes:number\|null`, `mem_source:"container"\|"host"`, `disk_pct:number\|null`, `disk_free_bytes:number\|null`, `disk_total_bytes:number\|null` |
| `services` | object / null | PM2 counts `online:number`, `total:number`, plus `channels:Array<{channel:string,service:string,status:string\|null,restarts10m:number,lastSendFailed:boolean\|null,consecutiveFailures:number\|null}>`. Channels come from installed skill frontmatter `type: communication` and `lifecycle.service.name`, and must exist in the PM2 sample. `restarts10m` sums observed counter increases in the last ten minutes, beginning at zero on Dashboard startup. Send fields describe the latest C4 outbound status and failures after the latest successful outbound; null means the C4 read failed. |

The `defaults` keys are `claude`, `codex` and `agy`. Antigravity has no configurable model/effort override, so its default `model` and `effort` are null. Its rotation threshold follows the one-million-token policy (40% maximum). Installed Antigravity versions come from `agy --version`; unavailable versions are null and latest/update remain null until update discovery supports this runtime.

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

**Access:** Read. **Parameters:** `runtime=claude|codex|agy` (default active runtime), optional `model` to include its threshold metadata.

Returns `runtime:string`, `current_model:string|null`, `current_effort:string|null`, `models:Array<{id:string,display_name?:string}>`, `efforts_by_model:Record<string,string[]>`, `model_thresholds:Record<string,number>`, `model_threshold_max:Record<string,number>`, `new_session_threshold:number`, `session_hot_ttl:object`, `zylos_version:string`, `runtime_cli:string`, and `cc_version:string|null`. For Antigravity, `current_model` and `current_effort` are null, `models` is empty and `efforts_by_model` is empty because this integration does not support model/effort overrides. `cc_version` carries the selected runtime's installed CLI version, including Antigravity; it is null when unavailable. Empty effort options mean capabilities are unknown or the model does not expose effort selection. Threshold values and maxima are percentages. These are configured defaults and available choices, not Origin runtime observations; the response never includes running_model or running_effort and does not collect Origin session evidence.

**Errors:** 400 `INVALID_RUNTIME`; common read errors.

Example: `GET /api/instance/runtime-options?runtime=codex`.

### PUT /api/instance/defaults

**Access:** Admin. **Parameters:** one JSON change at a time:

| `kind` | Other fields | Effect |
|---|---|---|
| `model` | `model:string`, optional `runtime:"claude"\|"codex"` | Change the selected runtime's default model |
| `effort` | `effort:string`, optional `runtime` | Change default effort within the model's supported options |
| `threshold` | `runtime`, `model:string`, `value:number\|string` | Set this model's rotation threshold, from 10 through its reported maximum |
| `session-hot-ttl` | `minutes:number\|string` | Set idle reclaim time for group sessions and Origin (Origin only in native single mode), within the limits reported by runtime options; pre-migration instances remain read-only |

Returns `ok:boolean`, optional `runtime:string`, `model:string`, `value:number`, `previous:string|null`, `requires_restart:boolean`, `minutes:number`, `seconds:number`, plus optional localized result metadata `message:string`, `messageKey:string`, `messageParams:object`. Specifying a runtime changes its defaults without requiring the active session to restart; callers should use the returned `requires_restart` value.

**Errors:** 400 `INVALID_DEFAULT`, `INVALID_RUNTIME`, `invalid_model`, `invalid_effort`, `invalid_value`; 409 `already_set`, `duplicate_request`, `environment_override`, `multi_session_required`; 503 `unknown_model_capabilities`; 500 `set_failed`; common write errors. Action failures select their HTTP response status; numeric internal `status` fields are omitted from the JSON write body.

Example: `PUT /api/instance/defaults` with `{"kind":"threshold","runtime":"claude","model":"opus","value":80}`.

### PUT /api/instance/name

**Access:** Admin; local only (see Access). **Parameters:** JSON `{name:string}` (1–32 ASCII letters, digits, underscores, dots or hyphens).

Returns `{ok:true,self:{name:string}}`. The new name is persisted in instance configuration and subsequent instance/fleet publications.

**Errors:** 400 `invalid_name`, `reserved_name` or `duplicate_name`; 500 `failed_to_save_config`; common write errors.

Example: `PUT /api/instance/name` with `{"name":"my-agent"}`.

### POST /api/instance/actions/switch-mode

**Access:** Admin. **Parameters:** JSON `{mode:"single"|"multi"}`. Core owns transition validation and admission.

Returns `{ok:true,...CoreResult}` on success, with optional `data:object`, `message:string` and transition/result metadata. Core failures are mapped to the common error envelope and HTTP status. Completion and acceptance are distinct; refresh the instance after an accepted transition.

**Errors:** invalid mode, unavailable supervisor, transition conflicts and Core rejection codes in the returned envelope; common write errors.

Example: `POST /api/instance/actions/switch-mode` with `{"mode":"multi"}`.

### POST /api/instance/actions/switch-runtime

**Access:** Admin. **Parameters:** JSON `{runtime:"claude"|"codex"|"agy"}` plus any authentication-confirmation fields required by Core's runtime-switch flow.

Returns `{ok:true,...CoreResult}` on success, with optional `data` and `message`; failures use the common envelope. `AUTH_FAILED` and `AUTH_NOT_CONFIRMED` results display the original authentication error details; neither is a successful switch. `AUTH_FAILED` means rejected or missing credentials; `AUTH_NOT_CONFIRMED` means the probe could not confirm authentication.

**Errors:** HTTP 403 `AUTH_FAILED` (explicit credential rejection or logged-out status for any runtime) or `AUTH_NOT_CONFIRMED` (probe could not confirm authentication); invalid runtime, supervisor/transition rejection codes, and common write errors. The two authentication errors retain distinct `error.message` remedies: replace credentials/log in for `AUTH_FAILED` (agy: `zylos runtime agy --save-apikey <key>`); check network/proxy and retry for `AUTH_NOT_CONFIRMED`.

Example: `POST /api/instance/actions/switch-runtime` with `{"runtime":"codex"}`.

### POST /api/instance/actions/upgrade

**Access:** Admin. **Parameters:** JSON `{}`.

Returns `ok:boolean`, optional `message:string`, `detached:boolean` and localization fields. `detached:true` means the upgrade process was launched; it does not prove completion.

**Errors:** 409 `already_up_to_date`, `duplicate_request`; 502 upgrade outcome unknown/failed; common write errors.

Example: `POST /api/instance/actions/upgrade` with `{}`.

### POST /api/instance/actions/upgrade-runtime

**Access:** Admin. **Parameters:** JSON `{}`; operates on the current default runtime.

Returns `ok:boolean`, optional `message:string`, `output:string`, `requires_restart:boolean` and localization fields. Restart applies the installed CLI to a session.

**Runtime behavior:** Claude runs `claude update`, Codex runs `codex update`, and Antigravity runs `agy update` non-interactively (5-minute timeout, background auto-update disabled). For Antigravity only, `HTTPS_PROXY` follows session launch precedence: an entry in the instance `.env` wins over the Dashboard process environment, otherwise the process value is used. An empty `.env` entry disables the inherited value; if neither provides a nonempty value the child variable is absent. This uses the existing session dotenv reader. Claude/Codex upgrade environments are unchanged. An unknown runtime returns `runtime_unsupported` without executing a command. Antigravity success and failure messages name Antigravity; successful responses request a session restart. This action uses the instance default runtime, not a session-group override. A lost HTTP reply or an upstream 5xx without a confirmed upgrade outcome is displayed as an unknown Antigravity result; check the installed version before retrying because the update may still be running.

**Errors:** 400 `runtime_unsupported`; 504 `deadline_exceeded` (Antigravity did not complete; verify the installed version before retrying); 502 `upgrade_failed`; 409 `duplicate_request`; common write errors.

Example: `POST /api/instance/actions/upgrade-runtime` with `{}`.

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
| `lastActivityAt` | string / null | Latest recorded C4 activity |
| `currentAction` | `{tool:string\|null,message:string\|null,receivedAt:string\|null}` | First current tool name, latest received message excerpt (at most 120 characters), and its ISO timestamp; absent observations remain null |

Offline rows have exactly `id`, `displayName`, `channel`, `lastActivityAt` and `flags`. The ID remains necessary to open detail or perform a group action. The compact action contains no tool arguments, tool detail or raw message. Lists do not include `sessionGroup`, stored `name` metadata, `side`, `presence`, `live`, `working`, `wait`, `queue`, `target`, `launchConfig`, `c4`, `tools` or any other raw observations. Search adds `side` to distinguish running and offline results.

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

**Errors:** 502 `GROUP_CATALOG_UNREADABLE`; common read errors. Other source availability is represented by nullable observations. In counts, `listKnown` additionally requires a readable C4 catalog; running and offline responses expose the snapshot’s live-list availability directly. Offline and search still reject an unreadable C4 catalog even when the live list is known.

Example: `GET /api/groups/counts`.

### GET /api/groups/running

**Access:** Read. **Parameters:** none; this list is not paginated.

Returns `{readAt:string,listKnown:boolean,rows:RunningRow[]}` with only the running fields listed above. Confirmed offline rows are excluded. Its practical size follows the session pool.

**Errors:** common read errors.

Example: `GET /api/groups/running`.

### GET /api/groups/offline

**Access:** Read. **Parameters:** optional `q:string` (trimmed, at most 64 characters), `flag:queued|blocked|waitingSlot|startFailed|unreadable|noResponse` (one flag), `cursor:string` (opaque cursor from the previous page), `limit:integer` (1–200, default 50).

Returns `{readAt:string,listKnown:boolean,rows:OfflineRow[],nextCursor:string|null}` with only the five offline fields above. Rows are ordered by descending last activity and then ID. Text matches group ID/address and display name. A flag matches only when that key exists in the row’s flags; text and flag filters combine with AND before pagination. Pass the cursor unchanged with the same filters to continue.

**Errors:** 400 `INVALID_LIMIT`, `INVALID_QUERY`, `INVALID_FLAG`, `INVALID_CURSOR`; 502 `GROUP_CATALOG_UNREADABLE`; common read errors.

Example: `GET /api/groups/offline?flag=startFailed&q=team&limit=20`.

### GET /api/groups/search

**Access:** Read. **Parameters:** `q:string`, matched against ID/address and name; empty or more than 64 characters returns no results.

Returns `{rows:Array<RunningRow|OfflineRow>,truncated:boolean}`, at most 50 results across both sides. Search alone adds `side:"running"|"offline"` to each result; all other fields follow its side’s list schema.

**Errors:** 502 `GROUP_CATALOG_UNREADABLE`; common read errors.

Example: `GET /api/groups/search?q=team`.

### GET /api/groups/activity

**Access:** Read. **Parameters:** `range=60m|6h` (default `6h`).

Returns `{range:string,cellSeconds:number,start:string,groups:Record<string,{cells:string[],inbound:string[]}>,inboundError?:"inbound_unreadable"}`. Cells are activity classifications (`none`, `idle`, `busy`, `waiting`, `error`); inbound entries are message ISO timestamps. This heatmap retains historical activity classifications, which are separate from the current primary-state vocabulary. If inbound timestamps cannot be read, the response includes `inboundError:"inbound_unreadable"` while retaining the event classifications.

In single-session mode, `groups.origin` combines current `origin` and historical null-group events, including turn transitions before the window needed to seed its first cell. Its inbound markers include all external channel groups feeding the sole session; internal and outbound messages are excluded. Multi-session heatmaps retain each group's own event and inbound scope.

After switching from multi-session to single-session mode, inbound markers within the selected window (up to six hours) also include messages handled by other groups before the switch, because single-session mode reads all external inbound messages.

**Errors:** 400 `invalid_range`; source read failures and common read errors.

Example: `GET /api/groups/activity?range=6h`.

### GET /api/groups/:id

**Access:** Read. **Parameters:** encoded group ID; optional `include=raw,config` (default both). An empty `include=` requests neither extra; either name can be selected independently.

Returns the complete group observation, including the applicable list fields plus `sessionGroup:string|null`, `name:object|null`, `side:"running"|"offline"`, `presence:string`, `live:object|null`, `fence:object|null`, `working:object|null`, `queue:object|null`, `wait:object|null`, `target:object|null`, `launchConfig:object|null`, `createdAt:string|null`, `c4:object|null`, `tools:array`, and other source observations. `readAt:string` is the snapshot’s ISO observation timestamp. `runtimeInfo` is the group-specific object `{runtime:string|null,model:string|null,effort:string|null,runningVersion:string|null,installedVersion:string|null,update:string|null,pendingRestart:boolean}`. Its runtime/model/effort and running version are observed group values; unavailable strings remain null. `installedVersion` is the installed version for that runtime; `update` is an available newer version string or null, using the same version comparison as `versions[runtime]`. `pendingRestart` is true only on the running side when known evidence identifies a newer installed CLI or a desired runtime/model/effort that differs from the current observation. False does not establish that unknown values match. This group-specific object does not appear in `/api/instance`.

Detail also includes `currentAction:{tool:string|null,message:string|null,receivedAt:string|null}` using the same bounded, sanitized projection as a running list row. Optional `include` extras do not change this field.

`effective` contains `{runtime:string|null,model:string|null,effort:string|null,runtimeOverridden:boolean|null,modelOverridden:boolean|null}`. For a running or starting process, effective values and override flags describe the actual launch; runtime override compares that runtime with the current baseline and model override reads the launch’s override mode. Offline flags/values describe current desired configuration. Top-level override fields and `effective` use the same observations. Unknown evidence yields null. `run` is `{runId:string|null,sessionId:string|null,createdAt:string|null}|null`.

When requested, `raw:string|null` contains sanitized first-message content and `config:object|null` contains Core runtime/model read envelopes. An optional read failure returns its field as null and `rawError` or `configError` as `{code:string,message:string}`; it does not fail the whole detail request. Unrequested extras and their error fields are omitted. The address remains stable across lifecycle changes.

Bare keys `counts`, `running`, `offline`, `search`, `activity`, `naming-prompt` and `runtime-overrides` are reserved API namespace segments and cannot address a group detail. Use namespaced group keys rather than those bare names.

**Errors:** 400 `SESSION_GROUP_INVALID`, `INVALID_INCLUDE`; 404 `GROUP_NOT_FOUND`; 502 `GROUP_CATALOG_UNREADABLE` when an unknown group cannot be checked against the catalog or a historical key cannot be verified; common read errors. Detail for a current valid key remains readable when unrelated catalog collection fails. Individual Core configuration errors can also appear inside their configuration envelopes.

Group observation reads (detail, usage, runs, messages, events, backlog and restart status) also accept historical imported group IDs outside the current write grammar, such as `telegram:运维群-测试`, only when a healthy instance C4 catalog contains that exact group with C4 evidence. They reuse the same request snapshot catalog as detail; status-only rows, queue-only rows, usage/event history and filesystem presence do not prove membership. IDs are decoded exactly once and must retain a valid namespace, a nonempty local name of at most 95 characters and total length at most 128. Control characters, DEL, slash, backslash and dot-only traversal names (`.` or `..`) are rejected before catalog lookup. A literal percent in an existing name is allowed after decoding; no second decode occurs. Malformed URL encoding returns 400 `SESSION_GROUP_INVALID`.

Unknown historical IDs return 400 `SESSION_GROUP_INVALID`; an unreadable catalog returns 502 `GROUP_CATALOG_UNREADABLE`. Current valid IDs retain each route's existing empty-data/not-found behavior without requiring the catalog solely for validation. This read exception does not change config, name, action or deletion validation. Deletion preview is part of Core's deletion operation and retains the same strict target grammar as deletion. Optional raw/config readers retain their own field-level failures.

Example historical observation: `GET /api/groups/telegram%3A%E8%BF%90%E7%BB%B4%E7%BE%A4-%E6%B5%8B%E8%AF%95/runs?limit=3`.

Conversation status is an optional consumer of this detail. A newly created chat group can be absent from the snapshot: `GROUP_NOT_FOUND` means no reading yet, with a retry on the existing status cadence. Chat remains usable without a status reading; other HTTP errors retain their existing failure semantics.

Example: `GET /api/groups/telegram%3Aexample?include=`.

### GET /api/groups/:id/usage

**Access:** Read. **Parameters:** encoded group ID.

Returns the [usage summary](#usage-summary-fields) with `scope:"group"` and `group:string`. Historical records without group attribution count toward `origin`, except Other: samples of runtimes zylos starts itself (no group, no run, marked as a child) count toward no group, including `origin` (see [usage summary](#usage-summary-fields)). An otherwise valid ID with no usage returns zero counts/cost and null cache rate.

**Errors:** 400 `SESSION_GROUP_INVALID`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; 500 `internal_error` when the usage query fails; common read errors.

Example: `GET /api/groups/origin/usage`.

### GET /api/groups/:id/runs

**Access:** Read. **Parameters:** encoded ID, optional `before:string` (ISO run-start cursor), `limit:integer` (1–1000, default 3), `types:string` (comma-separated event types).

Returns `runs:Array<{runId:string,startAt:string,endAt:string,n:number,endReason:string}>`, `totalRuns:number`, `totalEvents:number`, and `unattributed:number`. `types` filters counts, not whether runs exist. `endReason` distinguishes the current run (`running`), reclaim/restart/rotation/crash reasons and `unknown`.

**Errors:** 400 `SESSION_GROUP_INVALID`, `INVALID_ARGUMENT`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; common read errors.

Example: `GET /api/groups/origin/runs?limit=3`.

### GET /api/groups/:id/messages

**Access:** Read. **Parameters:** encoded ID, optional `since` / `until` message-time bounds (ISO timestamps; defaults epoch through now).

Returns `{messages:Array<{id:number,direction:string,channel:string,timestamp:string}>}`. It excludes internal-channel messages and returns metadata rather than message bodies. Legacy single-mode Origin reads use the legacy null attribution.

**Errors:** 400 `SESSION_GROUP_INVALID`, `INVALID_ARGUMENT`; 502 `READ_FAILED`, `GROUP_CATALOG_UNREADABLE` (when historical membership cannot be verified); common read errors.

Example: `GET /api/groups/origin/messages?since=2026-11-01T00%3A00%3A00Z`.

### GET /api/groups/:id/events

Single-session Origin reads current hook records stored as `session_group:"origin"` together with historical null-group records, within the same run, ordering and pagination filters. Other groups and multi-session Origin retain their own group scope. The same single-session alias applies to current working and duration observations and history diagnostics: single Origin includes events:origin plus legacy unassigned diagnostics; another group and multi Origin remain scoped.

**Access:** Read. **Parameters:** encoded ID; optional `since`, `until`, `types` (comma-separated), `session_id`, `run_id`, `runtime`, `after_seq`, `limit` (default 100, maximum 1000), `offset` (default 0), `order=asc|desc` (default asc); diagnostic-gap filters `stream`, `gap_limit` (default 100), `gap_offset` (default 0).

Returns `events:object[]` (sanitized runtime-event records), `count:number`, and `gaps:object[]` (sanitized import diagnostics). Event records include `id`, `event_seq`, `timestamp`, `runtime`, `session_id`, `session_group`, `run_id`, `event_type`, `category`, `summary`, `duration_ms`, `metadata`, `source` and `confidence`, with nullable source fields. Filtering does not modify stored attribution.

**Errors:** 400 `SESSION_GROUP_INVALID`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; source/database failures and common read errors.

Example: `GET /api/groups/origin/events?order=desc&limit=20`.

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

Returns `{ok:true,data?:object,...metadata}` on success; Core failures use the common error envelope and a non-2xx status. `RESULT_UNKNOWN` means the result could not be established; read the group detail before deciding whether any retry is needed.

**Errors:** 400 `SESSION_GROUP_INVALID`, `SESSION_GROUP_TOO_LONG`, `INVALID_ARGUMENT`, `MODEL_PAIR_REQUIRED`, `MODEL_CONFIG_INVALID` and other Core validation rejections; 404 `SESSION_GROUP_NOT_FOUND`; 500 `CONFIG_STORE_FAILED`; 502 `RESULT_UNKNOWN`; common write errors.

Example: `PUT /api/groups/telegram%3Aexample/config` with `{"kind":"runtime","value":"inherit"}`.

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

### GET /api/groups/runtime-overrides

**Access:** Read. **Parameters:** optional `q:string` (name/address search), `after:string` (Core's opaque pagination boundary).

Returns `runtime:Array<{sessionGroup:string,runtime:string,name:object|null}>`, `nextAfter:string|null`, and `runtimeTotal:number` when querying the unfiltered list. Search results need not include a total. Only explicit runtime overrides are listed; row `runtime` is `claude`, `codex` or `agy`.

**Errors:** 502 `override_list_failed`; common read errors.

Example: `GET /api/groups/runtime-overrides?q=team`.

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

**Access:** Admin. **Parameters:** same identity body as interrupt.

Returns the supervisor result with `ok:boolean`, `requestId?:string`, `submission:"accepted"|"rejected"|"unknown"|"not_submitted"`, optional `completion:string`, `unknown?:boolean`; failures use `error:{code,message}` and non-2xx HTTP status. Origin uses the same public address and Core's Origin action implementation. Query the restart resource to establish progress.

**Errors:** same target/mode/access errors as interrupt; `INSTANCE_ROOT_MISMATCH`; supervisor rejection/unavailable result codes.

Example: `POST /api/groups/telegram%3Aexample/actions/restart` with `{"runId":"observed-run"}`.

### GET /api/groups/:id/restarts/:requestId

**Access:** Read. **Parameters:** encoded group ID and UUID-shaped restart request ID.

Returns `requestId:string`, `completion:string` (supervisor lookup result, or `unknown`), and `group:{id:string,runId:string|null,sessionId:string|null,ready:boolean,state:object}`. This works for any group, including Origin; group identity and current state are observations, not proof that a particular restart caused them.

**Errors:** 400 `SESSION_GROUP_INVALID`, `INVALID_REQUEST_ID`; 404 `GROUP_NOT_FOUND`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; common read errors.

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

Read-scope callers can inspect the tree and backlog. File bodies and Git metadata require admin access. PUT requires admin and browser same origin. Paths are relative to the memory root; absolute paths, traversal, symlinks and unsupported text files are rejected.

| Method/path | Parameters and result | Errors / example |
|---|---|---|
| `GET /api/memory/tree` | No parameters. Returns `root:{name,path,type,children}`, recursively ordered directories/files with relative paths and file metadata, and `sessionGroups:{sessionGroup,displayName}[]`: one entry per valid session-group directory under `session-groups/`, with its display name or null. | 500 `memory_browser_failed` when the memory directory cannot be read (including when it is missing). Example: `GET /api/memory/tree`. |
| `GET /api/memory/file` | Required `path`. Returns `{path,name,size_bytes,mtime,sha256,markdown,text}`. `mtime` is ISO; `sha256` is the optimistic-write version. | 400 `invalid_memory_path`, 404 `memory_file_not_found`, 413 `memory_file_too_large`, 415 `unsupported_memory_file` (not a supported text file name, or not valid UTF-8), 500 `memory_browser_failed`. Example: `GET /api/memory/file?path=state.md`. |
| `PUT /api/memory/file` | Required `path`; JSON `{text:string,sha256:string}`. Returns `{ok:true,...file}` after Core's lock, conflict check and atomic save. | 400 `invalid_memory_write` (body, text or sha256 invalid), `memory_write_empty`, `invalid_memory_path`; 404 `memory_file_not_found`; 409 `memory_conflict` (with current file), `memory_sync_busy`; 413 `memory_file_too_large`; 415 `unsupported_memory_file`; 503 `memory_write_unavailable`, `memory_lock_timeout`; 502 `memory_write_unknown`; 500 `memory_write_failed` or `memory_browser_failed`. Example body: `{"text":"# Current work\n","sha256":"<64 hex characters>"}`. |
| `GET /api/memory/git` | Required `path` (empty root allowed). Returns `{path,commit:null|{hash,short_hash,author_name,author_date,subject}}`. Missing Git history yields `commit:null`. | 400 `invalid_memory_path`, 404 `memory_file_not_found`, 500 `memory_browser_failed`. Example: `GET /api/memory/git?path=state.md`. |
| `GET /api/memory/backlog` | No parameters. Returns `{groups,originSync?,hasOlder,budgets}`. Each group has `sessionGroup,displayName,c4,count,firstAt,aged,syncing,threshold` and optional failure `reason`; multi mode adds cross-group `originSync`. | 503 `backlog_failed`. Example: `GET /api/memory/backlog`. |

Backlog `count`, `firstAt`, `syncing` and `threshold` can be null when unknown; `budgets` is an object or null. Its `limits` map keeps byte numbers for reference INDEX files; `identity.md` and `references.md` have `{maxChars,maxTokens}` startup display limits. `warnings` has byte numbers for INDEX files and `{chars,estimatedTokens}` for startup files (80% of both limits). `checks` maps the two startup filenames to `{chars,estimatedTokens,sizeBytes,maxChars,maxTokens,warnThreshold:{chars,estimatedTokens},status:"ok"|"warning"|"over",budgetUsagePct}` or null when unreadable. Measurements read the current text, independent of runtime; usage is the larger fraction of the two dimensions. These are reporting fields and never prevent writes. Historical C4 groups accepted by group observation reads retain their count and oldest time. Historical groups cannot participate in per-group sync, so `aged:false`, `syncing:null` and `reason:"backlog_failed"` avoid implying an overdue sync. Syncable groups become `aged:true` when the oldest message is over six hours old. Unsafe names have unknown backlog fields. Multi-mode `originSync` is a separate cross-group observation.

## Schedules

All reads allow read scope; all writes require admin and browser same origin. A schedule ID is an ASCII letter/digit followed by at most 127 letters, digits, `_` or `-`. Writes go through the scheduler CLI and return `{ok:true,data}`. A rejected CLI result becomes an HTTP error; an unknown outcome is HTTP 502 `scheduler_cli_failed` and must not be automatically repeated.

| Method/path | Parameters and result | Errors / example |
|---|---|---|
| `GET /api/schedules` | `status=all|enabled|paused|failed|completed` (default all), `q`, `cursor`, `limit=1..100` (default30). Returns availability, task rows, summary counts, timeline bands, timezone and paging metadata. Task rows contain `id,name,promptSummary,promptTruncated,type,status,cron,intervalSeconds,nextRunAt,lastRunAt,updatedAt,priority,requireIdle,missThreshold,recent,nextRuns,target,reply,reenable`. | 400 `invalid_status`, `invalid_limit`, `invalid_cursor`. Example: `GET /api/schedules?status=completed&limit=30`. |
| `GET /api/schedules/preview` | `kind=cron|every|at`, `value`; optional `reenable=1`, `locale=en|zh`. Returns `{valid,runs?,text?,iso?,error?}`; invalid input is an HTTP error. | 400 `invalid_preview`, `invalid_cron`, `invalid_duration`, `invalid_time`, `reschedule_not_future`; 503 preview/timezone unavailable. Example: `GET /api/schedules/preview?kind=every&value=1h`. |
| `GET /api/schedules/:id` | Full task including `prompt`, recent executions and resolved delivery target; returns `{task}`. | 400 `invalid_task`; 404 `task_not_found`. Example: `GET /api/schedules/daily-report`. |
| `GET /api/schedules/:id/history` | Optional `before`, `beforeId`, `limit` for stable history pagination. Returns `{rows,next}` with execution status, start/completion, duration and error; an absent task/database returns an empty page (200). | 400 `invalid_task` for malformed URL encoding, `invalid_cursor` / `invalid_limit`; 503 `scheduler_unreadable`. Example: `GET /api/schedules/daily-report/history?limit=20`. |
| `POST /api/schedules` | JSON `{name?,prompt,schedule:{kind:"cron"|"every"|"at",value},priority?,requireIdle?,missThreshold?}`. Routing/delivery fields are not accepted by this form. | 400 invalid form/schedule; CLI validation errors. Example body: `{"name":"Report","prompt":"Summarize progress","schedule":{"kind":"every","value":"1h"}}`. |
| `PUT /api/schedules/:id` | Same editable fields, all optional. A supplied schedule replaces the schedule. | 404 missing task, 409 conflicting task state. Example body: `{"name":"Weekly report"}`. |
| `DELETE /api/schedules/:id` | No body. Removes the named task through Core. | 404 missing task; CLI rejection/unknown errors. Example: `DELETE /api/schedules/daily-report`. |
| `POST /api/schedules/:id/actions/pause` | No body. Pauses the named task. | 404 missing task; 409 invalid current state. Example: `POST /api/schedules/daily-report/actions/pause`. |
| `POST /api/schedules/:id/actions/resume` | No body. Resumes the named task. | 404 missing task; 409 invalid current state. Example: `POST /api/schedules/daily-report/actions/resume`. |

Schedule `nextRunAt`, `lastRunAt`, `updatedAt`, history `executedAt`/`completedAt`, every `runs[]`/`in24h[]` entry and `readAt` are ISO strings (or null where the source is unknown). Scheduler CLI write results project task `created_at`, `updated_at`, `next_run_at`, `last_run_at` and completion/failure fields to ISO too. `duration` is a millisecond duration and `intervalSeconds` is a duration in seconds. Cursor fields are opaque continuation values, not display timestamps.

## Settings and Credentials

| Method/path | Access, input and result | Errors / example |
|---|---|---|
| `GET /api/settings/pricing` | Read. Returns `{active,runtimes:{claude,codex}}`; runtime objects contain built-in model names, effective model prices, priority prices where applicable, configured prices and fast-mode metadata. Prices use input/output/cacheRead/cacheCreation per million tokens. | Common read errors. Example: `GET /api/settings/pricing`. |
| `PUT /api/settings/pricing` | Admin. JSON `{runtimes:{claude?:{modelPrices?,fastModeMultiplier?},codex?:{modelPrices?,priorityModelPrices?}}}`. Returns `{ok:true,active,runtimes}`. Claude multiplier can be null to restore default. Prices must be finite nonnegative numbers; built-in models cannot be removed. | 400 `invalid_pricing` / `invalid_request`; 500 save failure. Example body: `{"runtimes":{"claude":{"fastModeMultiplier":2}}}`. The single-runtime request format is removed. |
| `GET /api/settings/timezone` | Read. Returns `{tz,writable,read_only_reason,restart_services,restart_status}`. `tz` is an IANA name or null; the service list is advisory. | Common read errors. Example: `GET /api/settings/timezone`. |
| `PUT /api/settings/timezone` | Admin. JSON `{tz:string}`. Saves instance `.env` without restarting services; returns `{ok:true,tz,previous,changed,...restartAdvice}`. | 400 `invalid_timezone`, `timezone_unavailable_on_host`; 503 `tz_env_read_error` when `.env` cannot be read; 500 `tz_write_failed` when saving `.env` fails. A body that cannot be read also uses the `invalid_timezone` code rather than the common ones: invalid JSON returns 400 `invalid_timezone` and a body over 4 KiB returns 413 `invalid_timezone`. Example body: `{"tz":"Asia/Singapore"}`. |
| `POST /api/settings/timezone/actions/restart-services` | Admin. JSON confirmation required by the timezone restart action. Restarts only services identified as belonging to this instance. Returns `{ok:true,restarted,failed,restart_services,restart_status}`; failures carry the same fields. A confirmed service that is no longer running when its turn comes is skipped: it appears in neither `restarted` nor `failed`, and the request still returns 200. | 400 `confirmation_required` (body is not exactly `{tz,confirm:true,services}`, `tz` is not a valid time zone name, or `services` is empty, longer than the number of restartable services, or contains unknown or repeated names), `invalid_timezone` (`tz` is not in Dashboard's list of selectable time zones), `timezone_unavailable_on_host`; 409 `timezone_changed` when the saved timezone no longer equals `tz`; 503 `service_discovery_unavailable` (`restart_status:"unknown"`) or `tz_env_read_error`; 502 `restart_failed` when at least one service failed to restart (`failed` names them); 500 `restart_failed` for an unexpected failure (`restart_status:"unknown"`). Example body: `{"tz":"Asia/Singapore","confirm":true,"services":["scheduler"]}`. |
| `GET /api/settings/chat` | Read, including Fleet read proxies. Returns `{chat_allow_remote:boolean}`. This is the sole source of the remote chat/terminal visibility setting. | Common read errors. Example: `GET /api/settings/chat`. |
| `PUT /api/settings/chat` | Admin; local only (see Access). JSON `{chat_allow_remote:boolean}`. Returns `{ok:true,chat_allow_remote}`; disabling revokes remote chat/terminal access. | 400 `invalid_chat_settings`; 500 `chat_settings_write_failed`. Example body: `{"chat_allow_remote":false}`. |
| `POST /api/auth/token` | Public credential exchange; requires `Authorization: Bearer <API key>`. Returns `{ok:true,token,expires_at,ttl_seconds,scope}`. The API key is not itself a data-access bearer token. | 401 `invalid_api_key`. Example: `POST /api/auth/token` with the key header. |
| `GET /api/keys` | Admin; local only (see Access). Returns key metadata; key material is omitted. | Common access errors. Example: `GET /api/keys`. |
| `POST /api/keys` | Admin; local only (see Access). JSON `{name,scope:"read"|"admin"}`; returns `{ok:true,key,plaintext_key,...keyMetadata}`. The key is shown once. | 400 `invalid_name`, `invalid_scope` or `duplicate_name` when the name already exists at validation; 409 `name_taken` if a concurrent insert wins the database unique constraint. Example body: `{"name":"reader","scope":"read"}`. |
| `POST /api/keys/:name/rotate` | Admin; local only (see Access). Returns `{ok:true,key,plaintext_key,...keyMetadata}` with replacement material once. | 404 `unknown_key`. Example: `POST /api/keys/reader/rotate`. |
| `DELETE /api/keys/:name` | Admin; local only (see Access). `permanent=1` permanently removes an already revoked key; otherwise revokes it. Returns `{ok:true,...}`. | 404 `unknown_key`; 409 `must_revoke_first`. Example: `DELETE /api/keys/reader`. |
| `POST /api/keys/purge-revoked` | Admin; local only (see Access). Returns `{ok:true,purged,...keyMetadata}`. | Common write errors. Example: `POST /api/keys/purge-revoked`. |
| `GET /login`, `POST /login` | Public password login form and submission (`application/x-www-form-urlencoded`, password, optional remember). Success redirects and sets the scoped secure session cookie. Failure renders HTML. | Invalid credentials/rate limit are rendered on the form. Example: `GET /login`. |
| `POST /logout` | Browser session logout; clears cookie and redirects. | Always clears the session, including when Origin is missing or mismatched; no same-origin precondition. Example: `POST /logout`. |

## Chat

**Access:** Admin for all conversation content, metadata, attachment and chat push routes below. The remote chat switch must be enabled for API-session access. All conversation content and attachment reads require admin scope at both the local and destination instances; read keys receive 403. Writes also require admin and browser same origin. `GET /api/settings/chat` remains read-scoped because it exposes only the access setting. Local password sessions can read their own instance independently of the remote switch. Conversation IDs are opaque and must be URL-encoded; query parameters are validated per route. Take `items[].id` from `GET /api/chat/conversations` (or `conversation.id` from draft creation). For example, Origin has ID `g:6F726967696E`, encoded as `g%3A6F726967696E`; the group key `origin` is not a chat conversation ID. Use the returned ID for subsequent conversation requests, with the same `tab` where supported. Message IDs come from `items[].id` in that conversation’s `/messages` response.

| Method/path | Contract and minimal example |
|---|---|
| `GET /api/chat/conversations` | `tab=mine|external`, `limit`, `cursor`. Returns `{items,nextCursor,tz,deletionAllowed,...}`. Example: `GET /api/chat/conversations?tab=mine`. |
| `GET /api/chat/conversations/:id` | Returns reconciliation receipt plus conversation metadata. Example: `GET /api/chat/conversations/g%3A6F726967696E`. |
| `POST /api/chat/drafts` | JSON `{displayName?}` → `{ok:true,conversation}` (201). Example body: `{}`. |
| `PATCH /api/chat/conversations/:id` | JSON `{displayName}` → `{ok:true,conversation}`. Example body: `{"displayName":"Work"}`. |
| `POST /api/chat/conversations/:id/send` | JSON `{content,retry?,attachments?,quote?}` → `{ok:true,...receipt}`. Uncertain delivery is not safe to repeat automatically. Example body: `{"content":"Hello"}`. |
| `GET /api/chat/conversations/:id/messages` | `tab,limit,cursor,direction,recheckIds` → paged messages and `tz`. Example: `GET /api/chat/conversations/g%3A6F726967696E/messages?limit=30`. |
| `GET /api/chat/conversations/:id/status` | Optional `tab`; required `ids` is a comma-separated list of 1–100 distinct positive message IDs from `/messages` → `{items:Array<{id,direction,status,delivery_action,deliveryState}>}`. Example: after `/messages` returns an item with `id:123`, `GET /api/chat/conversations/g%3A6F726967696E/status?ids=123`. |
| `GET /api/chat/conversations/:id/activity` | `tab,subtask` → current conversation activity. Example: `GET /api/chat/conversations/g%3A6F726967696E/activity`. |
| `GET /api/chat/conversations/:id/questions` | Optional `limit=1..100` (default 50), `cursor`. Returns `{items,nextCursor}` with interactive questions for the stored conversation. Example: `GET /api/chat/conversations/g%3A6F726967696E/questions`. |
| `POST /api/chat/conversations/:id/answers` | JSON control answer payload validated against the stored question/control; returns `{ok:true,...receipt}`. Example: JSON `{interruptId,action,retry?}`, using the stored question/control action from the question response. |
| `GET /api/chat/conversations/:id/uploads/config` | Returns `{maxUploadBytes:number,maxAttachments:number}` for a writable conversation. Example: `GET /api/chat/conversations/g%3A6F726967696E/uploads/config`. |
| `POST /api/chat/conversations/:id/uploads` | Multipart file upload → `{ok:true,id,name,size,mime,kind}` (201). Example: multipart field `file` containing one supported file. |
| `GET /api/chat/conversations/:id/attachments/:attachmentId` | Streams authorized file bytes with safe content type/disposition. Example: `GET /api/chat/conversations/g%3A6F726967696E/attachments/<id>`. |
| `GET /api/chat/drafts/:id/deletion` | Local-owner-only draft deletion preview. Here `:id` is the bare `conversation.localId` returned by `POST /api/chat/drafts`, also available as `items[].localId` on draft rows in the conversation list. Do not pass the `d:`-prefixed conversation ID. Example: with `localId:"550e8400-e29b-41d4-a716-446655440000"`, `GET /api/chat/drafts/550e8400-e29b-41d4-a716-446655440000/deletion`. |
| `DELETE /api/chat/drafts/:id` | Local-owner-only; `:id` is the same bare `localId` used for the preview. JSON `{confirmed:true,operationId,cutoffId}` from the preview. Returns `{ok:true,...deletionResult}`. Example: `DELETE /api/chat/drafts/550e8400-e29b-41d4-a716-446655440000` with the preview's confirmation values. Passing `d:<uuid>` returns 404 `chat_conversation_not_found`. |

Chat validation uses HTTP 400 (`invalid_chat_parameters`, invalid conversation/control IDs), missing resources 404, forbidden writes 403, conflicting state 409, upload limits 413 and upstream/unknown outcomes 502. All JSON failures use the common error envelope. Attachment downloads are binary; SSE uses the Push contract below.

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
| `GET /api/observer/history/sessions` | Optional `session_group` (default Origin); in single mode a non-Origin selection returns 400 `invalid_session_group`. Existing historical keys follow the same C4-catalog membership rules as group detail (unreadable catalog: 502 `group_catalog_unreadable`, unknown/unsafe key: 400 `invalid_session_group`) → `{runtime,current,sessions}`. Each list request refreshes discovery and file metadata (including appended titles/bytes/timestamps and Codex event ordering), reusing parsed metadata; entries/content/search retain scoped snapshots. Example: `GET /api/observer/history/sessions?session_group=telegram%3Ateam`. |
| `GET /api/observer/history/entries` | Same group, required `session`, optional `before|after|around`, `limit=1..200`, `internal=0|1` → entries, updates and older/newer cursors. Example: `GET /api/observer/history/entries?session_group=origin&session=<id>`. |
| `GET /api/observer/history/content` | Same group, required `session,entry,field`, optional text `offset` → UTF-16 text chunk `{text,offset,next,total}` or binary bytes. Example: `GET /api/observer/history/content?session_group=origin&session=<id>&entry=o:0&field=text`. |
| `GET /api/observer/history/search` | Same group, required `session,q` (2–200 chars), optional `limit=1..200`, `before` and `internal=1` to include internal entries → `{matches:Array<{entry,snippet}>,before,hasMore}`. Example: `GET /api/observer/history/search?session_group=origin&session=<id>&q=hello`. |

Antigravity scopes return `{runtime:"agy",current:null,sessions:[]}` because native transcript reading and collection are not integrated. Requests for an unavailable native session retain HTTP 404 `session_not_found`; they never fall back to Claude history.

All four history routes use the same selected group. In single mode only Origin is valid; selecting any non-Origin group returns HTTP 400 `invalid_session_group` from group-detail validation, including groups that have readable history in multi mode. History supports offline groups through imported runtime-event attribution and transcript files, without acquiring a live terminal lease. A session outside the selected group returns 404. Missing/disabled observer history returns 404; invalid group/target/cursor/size returns 400; state conflicts return 409; inaccessible dependencies return 503. Rejected `/observer/stream` upgrades use the common JSON error envelope (including 401 `unauthorized`, 403 `same_origin_required` and 404 `not_found`); terminal stream failures close the connection after upgrade.

## Fleet

`GET /api/fleet` is a read-scoped status API. Configuration and probe routes are admin and local only (see Access). A remote request is authorized both on the local proxy and the destination; no old-version fallback exists.

| Method/path | Contract and minimal example |
|---|---|
| `GET /api/fleet` | Returns self/remote status records and update metadata. Example: `GET /api/fleet`. |
| `GET /api/fleet/agents` | Returns `{self,agents}` configuration with credential material redacted. Each agent has `{name,base_url,key_masked,access}`; `access` is `"admin"` when the poller has a cached admin session, otherwise `"read"` (including before a successful probe). Example: `GET /api/fleet/agents`. |
| `POST /api/fleet/agents` | JSON `{name,base_url,read_api_key}` → `{ok:true,agent:{name,base_url,key_masked,access}}` (200). Input is validated, then the destination is probed before saving; a failed probe does not reject the addition. `access` is `"admin"` or `"read"` when the probe established that API-session scope, or `"unknown"` when the probe failed (including invalid credentials or an unreachable destination). Validation returns 400 `invalid_name`, `reserved_name`, `duplicate_name`, `invalid_url` or `missing_read_api_key`; save failure returns 500 `failed_to_save_config`. Example body: `{"name":"worker","base_url":"https://worker.example/dashboard","read_api_key":"<key>"}`. |
| `POST /api/fleet/agents/test` | JSON `{base_url,read_api_key}` → `{ok:true,reachable:true,scope,version}`. Validation returns 400 `invalid_url` or `missing_read_api_key`. A failed destination probe returns HTTP 502 with `{ok:false,reachable:false,error:{code,message}}`; the code is `auth_failed`, `version_unsupported` or `unreachable`. Example: same destination/key as an add request. |
| `DELETE /api/fleet/agents/:name` | Removes the configured remote → `{ok:true,self,agents}`. Returns 400 `invalid_name` for an undecodable name, 404 `unknown_agent` when no remote has that name, and 500 `failed_to_save_config` when saving fails. Example: `DELETE /api/fleet/agents/worker`. |
| `GET /fleet/:name/*` | Proxies allowed read routes/assets using configured credentials. Reads of local-only routes return 403 `local_endpoint_not_proxyable`, and deletion previews return 403 `remote_deletion_forbidden` (see the write row). Example: `GET /fleet/worker/api/settings/chat`. |
| `PUT`, `PATCH`, `POST`, `DELETE /fleet/:name/*` | Only explicit object-write allowlist entries are proxyable, with admin and browser same origin; group display-name writes are allowed. Three refusals apply: a local-only route (see Access; reads and writes alike) returns 403 `local_endpoint_not_proxyable`; group and draft deletion and deletion previews (`/api/groups/:id`, `/api/groups/:id/deletion-preview`, `/api/chat/drafts/:id`, `/api/chat/drafts/:id/deletion`; any `DELETE`, and any method on the preview/deletion paths) return 403 `remote_deletion_forbidden`; any other write outside the allowlist returns 403 `not_allowed_via_fleet`. Example: `POST /fleet/worker/api/schedules/report/actions/pause`. |

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

Opening the stream samples current session state immediately. While at least one Dashboard stream is connected, session observations refresh every 2.5 seconds and are shared by Origin, group and Fleet projections. Closing the last stream stops periodic session reads. HTTP instance and Fleet reads still sample on demand.

| SSE event | Data | Meaning |
|---|---|---|
| `instance` | Same object as `GET /api/instance` | Instance overview changed; also sent when the ordinary stream opens |
| `groups` | Same object as `GET /api/groups/counts` | Counts or running-list observations changed; fetch lists if needed |
| `fleet` | Existing fleet payload | Remote/local fleet changed |
| `history_changed` | Existing history invalidation payload | Imported events changed |
| `metric_update` | Existing metric-update payload | A collector published a metric sample |
| `chat_*` | Existing chat subscription event payloads | Conversation data/activity invalidation |
| `auth_expired` | Existing expiry payload | Authorization expired; reconnect after authentication |

Fleet shows instance and group summaries only. It does not fetch Origin group detail, read Origin session metadata, or expose `model`, `effort`, `context_pct` or `new_session_threshold` on Fleet records. These observations remain in group detail and runtime settings. Single-session cards show only the actual state pill. Fleet records do not include current-action text or feeds; aggregate `BUSY` retains the Working label without implying a thinking or tool-activity observation. A known runtime authentication failure remains an error for a running-list row whose activity state is unknown. Its independent no-response count comes from `counts.running.flags.noResponse`; problem durations use `flags.noResponse.since`. Error precedence still keeps the summary categories mutually exclusive, so its no-response category can be smaller than the independent no-response count.

The self Fleet record's `daily_cost` and `weekly_cost` (in `GET /api/fleet` and the `fleet` event) are the `today.cost` and `sevenDay.cost` of `GET /api/usage/summary` at the time they are read. The self record may reuse them for up to 30 seconds; a new instance-local day or a time-zone change reads them again immediately. `GET /api/usage/summary` and group usage reads are not cached.

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
