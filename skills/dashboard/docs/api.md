# Dashboard API Reference

## Module Responsibilities

This reference describes Dashboard HTTP routes, including health, instance, session groups, usage, memory, schedules, settings, chat, terminal history, Fleet and push. Any PR that changes an API documented here must update this file in the same PR. Check methods, paths, parameters, permissions, fields and errors against the implementation, rather than copying a design proposal.

Paths are relative to the Dashboard base URL. For example, with the default HTTP mount, `/api/instance` is available at `/dashboard/api/instance`. Group IDs are URL-encoded session-group keys such as `telegram%3Aexample`, or `origin` for the single session and the multi-session Origin. Display names are not IDs.

## Access and Common Results

- **Public**: no login required.
- **Read**: an authenticated browser session or an API session with `read` or `admin` scope. An API key must first be exchanged for an API session through the existing authentication API.
- **Admin**: an authenticated administrator. Browser-cookie writes also require a same-origin request. Read-scope API sessions cannot write.
- **Local owner**: an administrator logged in with the local password cookie. API keys do not grant deletion or deletion-preview access, even with admin scope.

The existing auth gate may return HTTP 401 (unauthenticated) or 403 (`insufficient_scope`). Browser writes can return 403 `same_origin_required`. Invalid JSON returns 400 `invalid_json`, and oversized JSON bodies return 413 `payload_too_large`; body limits are route-specific (4 KiB for object actions/timezone/names/keys, 16 KiB for pricing/Fleet config, 64 KiB for schedule forms; chat and memory have their own limits). Removed routes return 404 `not_found`; unsupported methods return 405 `method_not_allowed`. JSON failures use the common envelope.

Read APIs return their data object directly. Successful JSON writes return `{ok:true,...result}`. All JSON failures, including Core rejections, use `{ok:false,error:{code:string,message:string}}` and an appropriate non-2xx status. Authentication exchange bootstraps API access with the supplied key; login/logout retain their HTML/redirect protocol. Binary downloads, HTML and upgraded streams retain their own content type. A successful submission is not proof that a session restarted or that an instruction was delivered. Do not automatically repeat a write whose result is unknown.

Unless stated otherwise, timestamps are ISO strings or `null`. Existing snapshot `readAt`, resource `sampledAt`, and activity `start` are Unix milliseconds; `createdAt` in raw lifecycle evidence can be Unix seconds. These observation fields retain their source units. Unknown measurements are `null`, rather than zero.

The examples below show request methods, URLs and JSON bodies. Supply the appropriate cookie or API-session authorization header; example writes are illustrative and should only be issued with authorization for their effects.

## Health

### GET /api/health

**Access:** Public. **Parameters:** none.

Returns `ok:boolean` (true), `service:string` (`zylos-dashboard`) and `bootId:string` (unique to this Dashboard process). Authenticated callers additionally receive `startedAt:string`, `uptimeSeconds:number`, `event_loop:object` (event-loop diagnostics) and `source:object` (Core source health). Response varies by `Cookie` and `Authorization`. HTTP 200 means this HTTP service is alive; it does not establish runtime readiness.

**Errors:** 404 `not_found` for the retired `probe` query. Readiness is available only at `/api/health/ready`.

Example: `GET /api/health` → `{"ok":true,"service":"zylos-dashboard","bootId":"example-boot"}`.

### GET /api/health/ready

**Access:** Public. **Parameters:** none.

Returns `ready:boolean`, `reason:string|null`, `session_mode:"single"|"multi"|null`, `session_running:boolean|null`, and `runtime_health:object` keyed by runtime. Each runtime entry has `source:"record"|"missing"|"unreadable"` and `health:string|null`. A responsive supervisor establishes readiness unless the single-mode session is confirmed absent. Runtime health is diagnostic, not an admission gate.

**Errors:** HTTP 503 with `{ok:false,error:{code,message},...readiness}` when `ready:false`; `reason` is `supervisor_unavailable` or `session_not_running`. Unavailable observations remain null.

Example: `GET /api/health/ready` → `{"ok":false,"error":{"code":"supervisor_unavailable","message":"supervisor_unavailable"},"ready":false,"reason":"supervisor_unavailable","session_mode":"multi","session_running":null,"runtime_health":{"claude":{"source":"missing","health":null},"codex":{"source":"missing","health":null}}}`.

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
| `versions` | object | Runtime-keyed `zylos`, `claude`, `codex` objects: `{installed:string\|null,latest:string\|null,update:string\|null}`; `update` identifies an available newer version |
| `runtimeHealth` | object / null | Runtime-keyed health observations, including health and cooldown evidence |
| `accounts` | object / null | Runtime-keyed weekly account quota objects or null; observations include used percentage, reset time, `recordedAt` and `live` |
| `supervisorPaused` | boolean / null | Whether new supervisor actions are paused |
| `autoRestarts` | object / null | `{count:number}` automatic restarts recorded during the past hour |
| `resources` | object | One current resource sample: `scope:"host"\|"container"\|"mixed"`, `sampledAt:number\|null` (Unix milliseconds), `cpu_pct:number\|null`, `cpu_count:number\|null`, `cpu_source:"container"\|"host"`, `mem_pct:number\|null`, `mem_used_bytes:number\|null`, `mem_total_bytes:number\|null`, `mem_source:"container"\|"host"`, `disk_pct:number\|null`, `disk_free_bytes:number\|null`, `disk_total_bytes:number\|null` |
| `services` | object / null | PM2 counts `online:number`, `total:number`, plus `channels:Array<{channel:string,service:string,status:string\|null,restarts10m:number,lastSendFailed:boolean\|null,consecutiveFailures:number\|null}>`. Channels come from installed skill frontmatter `type: communication` and `lifecycle.service.name`, and must exist in the PM2 sample. `restarts10m` sums observed counter increases in the last ten minutes, beginning at zero on Dashboard startup. Send fields describe the latest C4 outbound status and failures after the latest successful outbound; null means the C4 read failed. |

Each `defaults[runtime]` contains `model:string|null`, `effort:string|null`, `threshold:number`, `model_thresholds:Record<string,number>` and `session_hot_ttl:object` (effective mode, keepalive seconds and configuration/environment provenance). CPU and memory limits are resolved independently: a limited resource uses its container quota, while an explicitly unlimited resource uses host values and labels that resource’s source `host`. `scope` is `mixed` when the two sources differ, otherwise it is their common source; each resource’s source remains authoritative. An unreadable container limit keeps that resource’s source `container` with unknown measurements rather than implying unlimited host fallback. CPU percentages use the selected CPU capacity (which can be fractional); memory percentages use the selected total bytes. Disk describes the filesystem visible at the instance data directory and is independent of the CPU/memory scope. Unreadable observations remain null. There is no duplicate `system` sample or `runtime_info` object. Origin’s current model, effort, running CLI version and restart-to-apply status belong to group detail; instance versions and defaults describe installed software and configuration. Session context, cost and pool counts belong to the group and usage APIs.

`session_mode` carries Core’s existing status envelope:

| Field | Type / meaning |
|---|---|
| `sessionMode` | `"single"\|"multi"\|null`; null means the configured mode could not be established |
| `transition` | null or `{runId,sourceMode,targetMode,phase,cutoff,reason,createdAt,updatedAt}`, preserving Core's transition record |
| `globalGate` | null or `{present:boolean,reason:string\|null,runId:string\|null}`; null is unknown, not an absent gate |
| `blocked` | null or `{reason:string,since:number\|null}`; `since` is the matching diagnostic event's Unix milliseconds, when known |
| `supervisor` | `"reachable"\|"unreachable"\|"unknown"`; socket reachability is separate from the authoritative transition and gate records |
| `lastCompleted` | null or `{runId,sourceMode,targetMode,updatedAt}` from the most recent completed transition |
| `lastEvents` | array of the last ten matching Core diagnostic events; unavailable diagnostics produce an empty array without hiding authoritative records |
| `supervisorPm2` | optional `{status:string,error:{code:string,message:string}\|null}` alongside an unreachable supervisor |
| `error` | optional `{code:string,message:string}` when mode-status collection failed |

Transition and completion timestamps retain Core’s numeric source units. If authoritative status collection fails, Dashboard preserves the independently established `sessionMode`, sets `transition`, `globalGate`, `blocked` and `lastCompleted` to null, `lastEvents` to an empty array and `supervisor` to `unknown`, and includes `error`. These null fields do not prove that no transition, gate or block exists. These observations share the same object in GET and instance push; no separate transition endpoint exists.

The overview composes reminders from `supervisorPaused`, runtime health/account limits, `services.channels`, group counts/pool, offline `flag=startFailed`, row `flags.unreadable`, `counts.listKnown` and request failures. It does not receive a second instance-level attention list.

**Errors:** common authentication errors; an unavailable request dependency produces a server error. Individual missing observations can be represented by null fields.

Example: `GET /api/instance`.

### GET /api/instance/resources

**Access:** Read. **Parameters:** `range=6h|24h|7d` (default `6h`).

Returns `range:string`, `since:string`, `until:string`, `bucketSeconds:number`, `current:{cpu_pct:number|null,mem_used_pct:number|null,disk_used_pct:number|null,at:string|null}`, `pm2:{online:number,total:number,at:string|null}|null`, `series:Array<{at:string,cpu:Sample|null,mem:Sample|null,disk:Sample|null}>`, and `cpuPeak:{value:number,at:string}|null`. A `Sample` contains numeric `avg` and `max`. Empty sample buckets are null.

**Errors:** 400 `invalid_range`; common read errors.

Example: `GET /api/instance/resources?range=24h`.

### GET /api/instance/runtime-options

**Access:** Read. **Parameters:** `runtime=claude|codex` (default active runtime), optional `model` to include its threshold metadata.

Returns `runtime:string`, `current_model:string|null`, `current_effort:string|null`, `models:Array<{id:string,display_name?:string}>`, `efforts_by_model:Record<string,string[]>`, `model_thresholds:Record<string,number>`, `model_threshold_max:Record<string,number>`, `new_session_threshold:number`, `session_hot_ttl:object`, `zylos_version:string`, `runtime_cli:string`, and `cc_version:string|null`. Empty effort options mean capabilities are unknown or the model does not expose effort selection. Threshold values and maxima are percentages. These are configured defaults and available choices, not Origin runtime observations; the response never includes running_model or running_effort and does not collect Origin session evidence.

**Errors:** 400 `INVALID_RUNTIME`; common read errors.

Example: `GET /api/instance/runtime-options?runtime=codex`.

### PUT /api/instance/defaults

**Access:** Admin. **Parameters:** one JSON change at a time:

| `kind` | Other fields | Effect |
|---|---|---|
| `model` | `model:string`, optional `runtime:"claude"\|"codex"` | Change the selected runtime's default model |
| `effort` | `effort:string`, optional `runtime` | Change default effort within the model's supported options |
| `threshold` | `runtime`, `model:string`, `value:number\|string` | Set this model's rotation threshold, from 10 through its reported maximum |
| `session-hot-ttl` | `minutes:number\|string` | Set multi-session keepalive in the limits reported by runtime options |

Returns `ok:boolean`, optional `runtime:string`, `model:string`, `value:number`, `previous:string|null`, `requires_restart:boolean`, `minutes:number`, `seconds:number`, plus optional localized result metadata `message:string`, `messageKey:string`, `messageParams:object`. Specifying a runtime changes its defaults without requiring the active session to restart; callers should use the returned `requires_restart` value.

**Errors:** 400 `INVALID_DEFAULT`, `INVALID_RUNTIME`, `invalid_model`, `invalid_effort`, `invalid_value`; 409 `already_set`, `duplicate_request`, `environment_override`, `multi_session_required`; 503 `unknown_model_capabilities`; 500 `set_failed`; common write errors. Action failures can carry their own HTTP `status`.

Example: `PUT /api/instance/defaults` with `{"kind":"threshold","runtime":"claude","model":"opus","value":80}`.

### PUT /api/instance/name

**Access:** Admin; local-instance operation, not fleet-proxied. **Parameters:** JSON `{name:string}` (1–32 ASCII letters, digits, underscores, dots or hyphens).

Returns `{ok:true,self:{name:string}}`. The new name is persisted in instance configuration and subsequent instance/fleet publications.

**Errors:** 400 `invalid_name`, `reserved_name` or `duplicate_name`; 500 `failed_to_save_config`; common write errors.

Example: `PUT /api/instance/name` with `{"name":"my-agent"}`.

### POST /api/instance/actions/switch-mode

**Access:** Admin. **Parameters:** JSON `{mode:"single"|"multi"}`. Core owns transition validation and admission.

Returns `{ok:true,...CoreResult}` on success, with optional `data:object`, `message:string` and transition/result metadata. Core failures are mapped to the common error envelope and HTTP status. Completion and acceptance are distinct; refresh the instance after an accepted transition.

**Errors:** invalid mode, unavailable supervisor, transition conflicts and Core rejection codes in the returned envelope; common write errors.

Example: `POST /api/instance/actions/switch-mode` with `{"mode":"multi"}`.

### POST /api/instance/actions/switch-runtime

**Access:** Admin. **Parameters:** JSON `{runtime:"claude"|"codex"}` plus any authentication-confirmation fields required by Core's runtime-switch flow.

Returns `{ok:true,...CoreResult}` on success, with optional `data` and `message`; failures use the common envelope. An `AUTH_NOT_CONFIRMED` result can include authentication details; it is not a successful switch.

**Errors:** `AUTH_NOT_CONFIRMED`, invalid runtime, supervisor/transition rejection codes, and common write errors.

Example: `POST /api/instance/actions/switch-runtime` with `{"runtime":"codex"}`.

### POST /api/instance/actions/upgrade

**Access:** Admin. **Parameters:** JSON `{}`.

Returns `ok:boolean`, optional `message:string`, `detached:boolean` and localization fields. `detached:true` means the upgrade process was launched; it does not prove completion.

**Errors:** 409 `already_up_to_date`, `duplicate_request`; 502 upgrade outcome unknown/failed; common write errors.

Example: `POST /api/instance/actions/upgrade` with `{}`.

### POST /api/instance/actions/upgrade-runtime

**Access:** Admin. **Parameters:** JSON `{}`; operates on the current default runtime.

Returns `ok:boolean`, optional `message:string`, `output:string`, `requires_restart:boolean` and localization fields. Restart applies the installed CLI to a session.

**Errors:** 502 `upgrade_failed`; 409 `duplicate_request`; common write errors.

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
| `state` | `{kind:string,since:string\|null,stale?:boolean,sampledAt?:number,lastState?:"busy"\|"idle"}` | Mutually exclusive primary state and its known start; stale observations retain the last busy/idle classification for less than 60 seconds. Older samples become unknown while retaining sampledAt/lastState for an explicitly historical hint |
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

Returns `readAt:number`, `listKnown:boolean`, `running:{total:number,states:Record<PrimaryState,number>,flags:Record<Flag,number>}`, `offline:{total:number,waitingSlot:number,startFailed:number}`, and `pool:{used:number|null,capacity:number|null}|null`. Running state counts include working, idle, starting, stopping and unknown. `running.flags.noResponse` counts the independent no-response flag, including a row also flagged with an error. All count/pool observations are numeric or null; there are no rows, mode or capacity-provenance records. Session mode comes only from `/api/instance`. Pool capacity provenance is not exposed by instance or counts.

**Errors:** 502 `GROUP_CATALOG_UNREADABLE`; common read errors. Other source availability is represented by nullable observations. In counts, `listKnown` additionally requires a readable C4 catalog; running and offline responses expose the snapshot’s live-list availability directly. Offline and search still reject an unreadable C4 catalog even when the live list is known.

Example: `GET /api/groups/counts`.

### GET /api/groups/running

**Access:** Read. **Parameters:** none; this list is not paginated.

Returns `{readAt:number,listKnown:boolean,rows:RunningRow[]}` with only the running fields listed above. Confirmed offline rows are excluded. Its practical size follows the session pool.

**Errors:** common read errors.

Example: `GET /api/groups/running`.

### GET /api/groups/offline

**Access:** Read. **Parameters:** optional `q:string` (trimmed, at most 64 characters), `flag:queued|blocked|waitingSlot|startFailed|unreadable|noResponse` (one flag), `cursor:string` (opaque cursor from the previous page), `limit:integer` (1–200, default 50).

Returns `{readAt:number,listKnown:boolean,rows:OfflineRow[],nextCursor:string|null}` with only the five offline fields above. Rows are ordered by descending last activity and then ID. Text matches group ID/address and display name. A flag matches only when that key exists in the row’s flags; text and flag filters combine with AND before pagination. Pass the cursor unchanged with the same filters to continue.

**Errors:** 400 `INVALID_LIMIT`, `INVALID_QUERY`, `INVALID_FLAG`, `INVALID_CURSOR`; 502 `GROUP_CATALOG_UNREADABLE`; common read errors.

Example: `GET /api/groups/offline?flag=startFailed&q=team&limit=20`.

### GET /api/groups/search

**Access:** Read. **Parameters:** `q:string`, matched against ID/address and name; empty or more than 64 characters returns no results.

Returns `{rows:Array<RunningRow|OfflineRow>,truncated:boolean}`, at most 50 results across both sides. Search alone adds `side:"running"|"offline"` to each result; all other fields follow its side’s list schema.

**Errors:** 502 `GROUP_CATALOG_UNREADABLE`; common read errors.

Example: `GET /api/groups/search?q=team`.

### GET /api/groups/activity

**Access:** Read. **Parameters:** `range=60m|6h` (default `6h`).

Returns `{range:string,cellSeconds:number,start:number,groups:Record<string,{cells:string[],inbound:number[]}>,inboundError?:"inbound_unreadable"}`. Cells are activity classifications (`none`, `idle`, `busy`, `waiting`, `error`); inbound entries are message timestamps in milliseconds. This heatmap retains historical activity classifications, which are separate from the current primary-state vocabulary. If inbound timestamps cannot be read, the response includes `inboundError:"inbound_unreadable"` while retaining the event classifications.

In single-session mode, `groups.origin` combines current `origin` and historical null-group events, including turn transitions before the window needed to seed its first cell. Its inbound markers include all external channel groups feeding the sole session; internal and outbound messages are excluded. Multi-session heatmaps retain each group's own event and inbound scope.

After switching from multi-session to single-session mode, inbound markers within the selected window (up to six hours) also include messages handled by other groups before the switch, because single-session mode reads all external inbound messages.

**Errors:** 400 `invalid_range`; source read failures and common read errors.

Example: `GET /api/groups/activity?range=6h`.

### GET /api/groups/:id

**Access:** Read. **Parameters:** encoded group ID; optional `include=raw,config` (default both). An empty `include=` requests neither extra; either name can be selected independently.

Returns the complete group observation, including the applicable list fields plus `sessionGroup:string|null`, `name:object|null`, `side:"running"|"offline"`, `presence:string`, `live:object|null`, `fence:object|null`, `working:object|null`, `queue:object|null`, `wait:object|null`, `target:object|null`, `launchConfig:object|null`, `createdAt:number|null`, `c4:object|null`, `tools:array`, and other source observations. `readAt:number` is the snapshot’s Unix milliseconds. `runtimeInfo` is the group-specific object `{runtime:string|null,model:string|null,effort:string|null,runningVersion:string|null,installedVersion:string|null,update:string|null,pendingRestart:boolean}`. Its runtime/model/effort and running version are observed group values; unavailable strings remain null. `installedVersion` is the installed version for that runtime; `update` is an available newer version string or null, using the same version comparison as `versions[runtime]`. `pendingRestart` is true only on the running side when known evidence identifies a newer installed CLI or a desired runtime/model/effort that differs from the current observation. False does not establish that unknown values match. This group-specific object does not appear in `/api/instance`.

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

Returns the [usage summary](#usage-summary-fields) with `scope:"group"` and `group:string`. Historical records without group attribution count toward `origin`. An otherwise valid ID with no usage returns zero counts/cost and null cache rate.

**Errors:** 400 `SESSION_GROUP_INVALID`; 502 `GROUP_CATALOG_UNREADABLE` when historical membership cannot be verified; common read errors.

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

### GET /api/workbench/memory/backlog

**Access:** Admin. **Parameters:** none.

Returns `{groups:Array, originSync?:object, hasOlder:boolean, budgets:object|null}` from the shared backlog reader. Each group includes `sessionGroup`, `count:number|null`, `firstAt:string|null`, `aged:boolean`, `syncing:boolean|null`, `threshold:number|null`, and optional `reason`. Historical C4 groups with the same safe name shape accepted by group observation reads retain their counts and oldest time. Historical names cannot participate in per-group memory sync, so they return `aged:false` and do not produce an overdue warning. Historical groups’ `syncing` remains `null` with `reason:"backlog_failed"`, because sync-marker paths retain Core's strict grammar. Syncable groups still set `aged:true` when the oldest message is over six hours old. Unsafe name shapes return unknown backlog fields. The optional `originSync` row is a separate cross-group observation in multi mode.

**Errors:** 503 `backlog_failed` if collection fails; common read errors.

Example: `GET /api/workbench/memory/backlog`.

### PUT /api/groups/:id/config

**Access:** Admin. **Parameters:** encoded ID; one JSON change:

- `{kind:"runtime",value:"claude"|"codex"|"inherit"}` changes or resets runtime override.
- `{kind:"model",runtime:"claude"|"codex",model:string,effort:string}` sets a complete pair.
- `{kind:"model",runtime:"claude"|"codex",reset:true}` restores the runtime's default model/effort.

Returns `{ok:true,data?:object,...metadata}` on success; Core failures use the common error envelope and a non-2xx status. `RESULT_UNKNOWN` means the result could not be established; read the group detail before deciding whether any retry is needed.

**Errors:** 400 `SESSION_GROUP_INVALID`; `INVALID_ARGUMENT`, Core configuration rejection codes, or `RESULT_UNKNOWN` in the result; common write errors.

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

Returns `runtime:Array<{sessionGroup:string,runtime:string,name:object|null}>`, `nextAfter:string|null`, and `runtimeTotal:number` when querying the unfiltered list. Search results need not include a total. Only explicit runtime overrides are listed.

**Errors:** 502 `override_list_failed`; common read errors.

Example: `GET /api/groups/runtime-overrides?q=team`.

### POST /api/groups/naming-prompt

**Access:** Admin. **Parameters:** none; any JSON body is ignored.

Queues one C4 control that asks Origin to name recently active unnamed groups. The mode comes from this instance's `.zylos/config.json`: multi targets session group `origin`; otherwise the target stays empty, which C4 accepts only for the single session. The control text is the Dashboard naming prompt with the installed `group-name.js` path. Returns `{ok:true,controlId:number,sessionGroup:'origin'|null}` once C4 has queued it. Queued is the whole result: the response does not wait for delivery or naming, and nothing reports the names chosen.

**Errors:** HTTP 200 `{ok:false,sessionGroup?:'origin'|null,error:{code:string,message:string}}` when C4 rejects the control, keeping C4's code (for example `CONTROL_TARGET_REQUIRED` during a mode transition, or when the configuration cannot be read without a multi-mode target); `unknown:true` with `RESULT_UNKNOWN` when the send command fails or Core's answer cannot be read, in which case do not repeat automatically. `message` is a fixed English sentence such as `Send command failed (exit 1)`; it never carries the command line, prompt, paths or stack, which are written to the Dashboard service log instead. GET and HEAD return 405 `method_not_allowed`. Common write errors.

Example: `POST /api/groups/naming-prompt`.

### POST /api/groups/:id/actions/interrupt

**Access:** Admin. **Parameters:** encoded ID; JSON `{runId:string,sessionId?:string|null}` binding the request to observed identity. Non-Origin requires `runId`; Origin delegates to Core's session action handling.

Returns `ok:boolean`, `controlId:number|null`, `submission:string`, optional `rejectionCode:string|null`, `currentRunId:string|null`, `unknown?:boolean`, and `steps:object[]`. Core may add `data` or `error`. A submitted Escape is not a delivery acknowledgement.

**Errors:** 400 `SESSION_GROUP_INVALID`, `TARGET_REQUIRED`, `INVALID_ARGUMENT`; 409 `not_multi`; result `RESULT_UNKNOWN` or Core rejection codes; common write errors.

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

Returns Core's deletion preview: `ok:boolean`, `sessionGroup:string`, `draft:boolean`, `cutoffId:number` (message boundary), `operationId:string`, `messages:number`, `attachments:number`, `files:number`, and target/boundary metadata. Preserve the operation ID and cutoff for the confirmed delete.

**Errors:** 403 `local_cookie_required`, `origin_deletion_forbidden`; 400 `invalid_deletion_target`; 502 `deletion_result_unknown` / `deletion_unavailable`; Core target/preview errors.

Example: `GET /api/groups/telegram%3Aexample/deletion-preview`.

### DELETE /api/groups/:id

**Access:** Local owner, same origin. **Parameters:** encoded ID; JSON `{confirmed:true,operationId:string,cutoffId:integer}` from a fresh preview. Operation IDs are nonempty and at most 128 characters; cutoff is a nonnegative safe integer. Origin cannot be deleted.

Returns `ok:boolean`, `pending:boolean`, `operationId:string`, optional `reason:string`, `counts:object`, `countsEstimated:boolean` and retained-target metadata. HTTP 202 means draining or cleanup remains pending; HTTP 200 with `pending:false` establishes completed deletion.

**Errors:** 400 `deletion_confirmation_required`, `invalid_deletion_target`; 403 `local_cookie_required`, `same_origin_required`, `origin_deletion_forbidden`; 409 for transition/ownership/fence conflicts and `DELETION_PREVIEW_STALE`; 502 `deletion_result_unknown` / `deletion_unavailable`; Core deletion errors.

Example: `DELETE /api/groups/telegram%3Aexample` with `{"confirmed":true,"operationId":"from-preview","cutoffId":100}`.

## Usage

### Usage Summary Fields

Instance and group summaries share the following schema. Tokens include input and output; input includes cached input. Cache rate is weighted by input volume, not an average of request percentages. Historical records without a group belong to Origin. Costs sum stored priced requests; consult pricing results for models whose cost could not be priced. After a switch from multi-session to single-session mode, historical usage belonging to other groups remains in the instance summary and is not reassigned to Origin; Origin usage can therefore be smaller than the instance summary.

| Field | Type | Meaning |
|---|---|---|
| `tz`, `tzFallback` | string, boolean | Resolved instance zone; invalid/missing zones use UTC and flag fallback |
| `scope` | `all_groups` / `group` | Aggregation scope |
| `group` | string, optional | Present only for per-group reads |
| `today`, `sevenDay` | UsagePeriod | Current local day / seven local calendar days including today |

A `UsagePeriod` contains `since:string`, `until:string`, `tokens:number`, `inputTokens:number`, `outputTokens:number`, `cacheReadTokens:number`, `cacheHitRate:number|null` (0–1; null with no input), `cost:number` (USD), and `byRuntime:Record<string,UsageTotals>`. `UsageTotals` has the same numeric/rate/cost fields, without bounds or another runtime breakdown. Both known runtimes are present with zero counts if no records exist. Sums of each group's count/cost fields equal the instance fields for the same time window; cache rates must be recomputed from summed cache/input tokens.

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
| `totals` | object | `tokens`, `inputTokens`, `cacheReadTokens`, `cacheHitRate`, `cost`, `costByRuntime`, `messages:{in,out}`, `rotations`, `tools`; unavailable items nullable |
| `costByRuntime`, `tokensByRuntime` | `{runtime:string,at:string,value:number}[]` | Bucketed runtime cost/token series |
| `cache` | `{at:string,inputTokens:number,cacheReadTokens:number,value:number\|null}[]` | Bucket-aligned weighted cache rates |
| `messages` | `{at:string,in:number\|null,out:number\|null}[]` | Inbound/outbound message buckets |
| `messagesReason`, `messagesSampledAt` | string / null | Message query unavailability and observation time |
| `rotations` | `{at:string,value:number}[]` / null | Session-rotation event buckets |
| `tools` | `{name:string,count:number}[]` / null | Top ten tools with stable ordering |
| `runtimeEventsUnknown` | boolean | Range exceeds retained runtime-event history |
| `projects` | object | Project distribution with `items`, `totalTokens`, `totalOutput`, `totalCost`; items include name, output tokens, cost, percentage |

Hourly buckets are fixed epoch hours; daily buckets follow local calendar boundaries, including DST. Cache data is included here and requires no separate metric API request. Runtime events are retained for seven rolling days; wider ranges return null for rotations/tools instead of implying zero.

**Errors:** 400 `invalid_range`; common read errors.

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
| `GET /api/memory/tree` | No parameters. Returns `root:{name,path,type,children}`, recursively ordered directories/files with relative paths and file metadata. | 503 `memory_unavailable`. Example: `GET /api/memory/tree`. |
| `GET /api/memory/file` | Required `path`. Returns `{path,name,size_bytes,mtime,sha256,markdown,text}`. `mtime` is ISO; `sha256` is the optimistic-write version. | 400 `invalid_memory_path`, 404 `memory_file_not_found`, 413 `memory_file_too_large`. Example: `GET /api/memory/file?path=state.md`. |
| `PUT /api/memory/file` | Required `path`; JSON `{text:string,sha256:string}`. Returns `{ok:true,...file}` after Core's lock, conflict check and atomic save. | 409 `memory_conflict` (with current file), `memory_sync_busy`; 503 `memory_write_unavailable`, `memory_lock_timeout`; 502 `memory_write_unknown`. Example body: `{"text":"# Current work\n","sha256":"<64 hex characters>"}`. |
| `GET /api/memory/git` | Required `path` (empty root allowed). Returns `{path,commit:null|{hash,short_hash,author_name,author_date,subject}}`. Missing Git history yields `commit:null`. | Path/file errors as above. Example: `GET /api/memory/git?path=state.md`. |
| `GET /api/memory/backlog` | No parameters. Returns `{groups,originSync?,hasOlder,budgets}`. Each group has `sessionGroup,displayName,c4,count,firstAt,aged,syncing,threshold` and optional failure `reason`; multi mode adds cross-group `originSync`. | 503 `backlog_failed`. Example: `GET /api/memory/backlog`. |

## Schedules

All reads allow read scope; all writes require admin and browser same origin. A schedule ID is an ASCII letter/digit followed by at most 127 letters, digits, `_` or `-`. Writes go through the scheduler CLI and return `{ok:true,data}`. A rejected CLI result becomes an HTTP error; an unknown outcome is HTTP 502 `scheduler_cli_failed` and must not be automatically repeated.

| Method/path | Parameters and result | Errors / example |
|---|---|---|
| `GET /api/schedules` | `status=all|enabled|paused|failed|completed` (default all), `q`, `cursor`, `limit=1..100` (default30). Returns availability, task rows, summary counts, timeline bands, timezone and paging metadata. Task rows contain `id,name,promptSummary,promptTruncated,type,status,cron,intervalSeconds,nextRunAt,lastRunAt,updatedAt,priority,requireIdle,missThreshold,recent,nextRuns,target,reply,reenable`. | 400 `invalid_status`, `invalid_limit`, `invalid_cursor`. Example: `GET /api/schedules?status=completed&limit=30`. |
| `GET /api/schedules/preview` | `kind=cron|every|at`, `value`; optional `reenable=1`, `locale=en|zh`. Returns `{valid,runs?,text?,iso?,error?}`; invalid input is an HTTP error. | 400 `invalid_preview`, `invalid_cron`, `invalid_duration`, `invalid_time`, `reschedule_not_future`; 503 preview/timezone unavailable. Example: `GET /api/schedules/preview?kind=every&value=1h`. |
| `GET /api/schedules/:id` | Full task including `prompt`, recent executions and resolved delivery target; returns `{task}`. | 400 `invalid_task`; 404 `task_not_found`. Example: `GET /api/schedules/daily-report`. |
| `GET /api/schedules/:id/history` | Optional `before`, `beforeId`, `limit` for stable history pagination. Returns `{rows,next}` with execution status, start/completion, duration and error. | 400 invalid cursor/limit; 404 missing task. Example: `GET /api/schedules/daily-report/history?limit=20`. |
| `POST /api/schedules` | JSON `{name?,prompt,schedule:{kind:"cron"|"every"|"at",value},priority?,requireIdle?,missThreshold?}`. Routing/delivery fields are not accepted by this form. | 400 invalid form/schedule; CLI validation errors. Example body: `{"name":"Report","prompt":"Summarize progress","schedule":{"kind":"every","value":"1h"}}`. |
| `PUT /api/schedules/:id` | Same editable fields, all optional. A supplied schedule replaces the schedule. | 404 missing task, 409 conflicting task state. Example body: `{"name":"Weekly report"}`. |
| `DELETE /api/schedules/:id` | No body. Removes the named task through Core. | 404 missing task; CLI rejection/unknown errors. Example: `DELETE /api/schedules/daily-report`. |
| `POST /api/schedules/:id/actions/pause` | No body. Pauses the named task. | 404 missing task; 409 invalid current state. Example: `POST /api/schedules/daily-report/actions/pause`. |
| `POST /api/schedules/:id/actions/resume` | No body. Resumes the named task. | 404 missing task; 409 invalid current state. Example: `POST /api/schedules/daily-report/actions/resume`. |

Schedule task/history and run-array timestamps retain Unix seconds; `readAt` retains Unix milliseconds. `duration` is milliseconds and `intervalSeconds` is a duration. Cursor fields are opaque continuation values, not display timestamps.

## Settings and Credentials

| Method/path | Access, input and result | Errors / example |
|---|---|---|
| `GET /api/settings/pricing` | Read. Returns `{active,runtimes:{claude,codex}}`; runtime objects contain built-in model names, effective model prices, priority prices where applicable, configured prices and fast-mode metadata. Prices use input/output/cacheRead/cacheCreation per million tokens. | Common read errors. Example: `GET /api/settings/pricing`. |
| `PUT /api/settings/pricing` | Admin. JSON `{runtimes:{claude?:{modelPrices?,fastModeMultiplier?},codex?:{modelPrices?,priorityModelPrices?}}}`. Returns `{ok:true,active,runtimes}`. Claude multiplier can be null to restore default. Prices must be finite nonnegative numbers; built-in models cannot be removed. | 400 `invalid_pricing` / `invalid_request`; 500 save failure. Example body: `{"runtimes":{"claude":{"fastModeMultiplier":2}}}`. The single-runtime request format is removed. |
| `GET /api/settings/timezone` | Read. Returns `{tz,writable,read_only_reason,restart_services,restart_status}`. `tz` is an IANA name or null; the service list is advisory. | Common read errors. Example: `GET /api/settings/timezone`. |
| `PUT /api/settings/timezone` | Admin. JSON `{tz:string}`. Saves instance `.env` without restarting services; returns `{ok:true,tz,previous,changed,...restartAdvice}`. | 400 invalid/unavailable timezone; 503 environment inaccessible. Example body: `{"tz":"Asia/Singapore"}`. |
| `POST /api/settings/timezone/actions/restart-services` | Admin. JSON confirmation required by the timezone restart action. Restarts only services identified as belonging to this instance. Returns `{ok:true,...actionResult}`. | 400 `confirmation_required`; 409 no matching service; Core/service errors. Example body: `{"tz":"Asia/Singapore","confirm":true,"services":["scheduler"]}`. |
| `GET /api/settings/chat` | Read, including Fleet read proxies. Returns `{chat_allow_remote:boolean}`. This is the sole source of the remote chat/terminal visibility setting. | Common read errors. Example: `GET /api/settings/chat`. |
| `PUT /api/settings/chat` | Admin, local only (not Fleet proxied). JSON `{chat_allow_remote:boolean}`. Returns `{ok:true,chat_allow_remote}`; disabling revokes remote chat/terminal access. | 400 `invalid_chat_settings`; 500 `chat_settings_write_failed`. Example body: `{"chat_allow_remote":false}`. |
| `POST /api/auth/token` | Public credential exchange; requires `Authorization: Bearer <API key>`. Returns `{ok:true,token,expires_at,ttl_seconds,scope}`. The API key is not itself a data-access bearer token. | 401 `invalid_api_key`. Example: `POST /api/auth/token` with the key header. |
| `GET /api/keys` | Admin, local only. Returns key metadata; key material is omitted. | Common access errors. Example: `GET /api/keys`. |
| `POST /api/keys` | Admin, local only. JSON `{name,scope:"read"|"admin"}`; returns `{ok:true,key,plaintext_key,...keyMetadata}`. The key is shown once. | 400 invalid name/scope; 409 `name_taken`. Example body: `{"name":"reader","scope":"read"}`. |
| `POST /api/keys/:name/rotate` | Admin, local only. Returns `{ok:true,key,plaintext_key,...keyMetadata}` with replacement material once. | 404 `unknown_key`. Example: `POST /api/keys/reader/rotate`. |
| `DELETE /api/keys/:name` | Admin, local only. `permanent=1` permanently removes an already revoked key; otherwise revokes it. Returns `{ok:true,...}`. | 404 `unknown_key`; 409 `must_revoke_first`. Example: `DELETE /api/keys/reader`. |
| `POST /api/keys/purge-revoked` | Admin, local only. Returns `{ok:true,purged,...keyMetadata}`. | Common write errors. Example: `POST /api/keys/purge-revoked`. |
| `GET /login`, `POST /login` | Public password login form and submission (`application/x-www-form-urlencoded`, password, optional remember). Success redirects and sets the scoped secure session cookie. Failure renders HTML. | Invalid credentials/rate limit are rendered on the form. Example: `GET /login`. |
| `POST /logout` | Browser session logout; clears cookie and redirects. | Browser same-origin requirement applies. Example: `POST /logout`. |

## Chat

The remote chat switch must be enabled for API-session access. GETs permit read scope; writes require admin and browser same origin. Local password sessions can read their own instance independently of the remote switch. Conversation IDs are opaque and must be URL-encoded; query parameters are validated per route.

| Method/path | Contract and minimal example |
|---|---|
| `GET /api/chat/conversations` | `tab=mine|external`, `limit`, `cursor`. Returns `{items,nextCursor,tz,deletionAllowed,...}`. Example: `GET /api/chat/conversations?tab=mine`. |
| `GET /api/chat/conversations/:id` | Returns reconciliation receipt plus conversation metadata. Example: `GET /api/chat/conversations/origin`. |
| `POST /api/chat/drafts` | JSON `{displayName?}` → `{ok:true,conversation}` (201). Example body: `{}`. |
| `PATCH /api/chat/conversations/:id` | JSON `{displayName}` → `{ok:true,conversation}`. Example body: `{"displayName":"Work"}`. |
| `POST /api/chat/conversations/:id/send` | JSON `{content,retry?,attachments?,quote?}` → `{ok:true,...receipt}`. Uncertain delivery is not safe to repeat automatically. Example body: `{"content":"Hello"}`. |
| `GET /api/chat/conversations/:id/messages` | `tab,limit,cursor,direction,recheckIds` → paged messages and `tz`. Example: `GET /api/chat/conversations/origin/messages?limit=30`. |
| `GET /api/chat/conversations/:id/status` | `tab,ids` → message delivery statuses. Example: `GET /api/chat/conversations/origin/status`. |
| `GET /api/chat/conversations/:id/activity` | `tab,subtask` → current conversation activity. Example: `GET /api/chat/conversations/origin/activity`. |
| `GET /api/chat/conversations/:id/questions` | Returns interactive questions for the stored conversation. Example: `GET /api/chat/conversations/origin/questions`. |
| `POST /api/chat/conversations/:id/answers` | JSON control answer payload validated against the stored question/control; returns `{ok:true,...receipt}`. Example: JSON `{interruptId,action,retry?}`, using the stored question/control action from the question response. |
| `GET /api/chat/conversations/:id/uploads/config` | Upload constraints for a writable conversation. Example: `GET /api/chat/conversations/origin/uploads/config`. |
| `POST /api/chat/conversations/:id/uploads` | Multipart file upload → `{ok:true,id,name,size,mime,kind}` (201). Example: multipart field `file` containing one supported file. |
| `GET /api/chat/conversations/:id/attachments/:attachmentId` | Streams authorized file bytes with safe content type/disposition. Example: `GET /api/chat/conversations/origin/attachments/<id>`. |
| `GET /api/chat/drafts/:id/deletion` | Local-owner-only draft deletion preview. Example: `GET /api/chat/drafts/<id>/deletion`. |
| `DELETE /api/chat/drafts/:id` | Local-owner-only, JSON `{confirmed:true,operationId,cutoffId}` from the preview. Returns `{ok:true,...deletionResult}`. Example: pass the preview's confirmation values. |

Chat validation uses HTTP 400 (`invalid_chat_parameters`, invalid conversation/control IDs), missing resources 404, forbidden writes 403, conflicting state 409, upload limits 413 and upstream/unknown outcomes 502. All JSON failures use the common error envelope. Attachment downloads are binary; SSE uses the Push contract below.

## Terminal Observer and History

Read-scope callers can read observer status/history when remote access is enabled. Administration, terminal-size changes and leases require admin and browser same origin. `/observer/frame` and `/observer/stream` are lease-bound terminal resources, not read-key data APIs. Install/enable/disable/uninstall retain their existing coordinator semantics.

| Method/path | Contract and minimal example |
|---|---|
| `GET /api/observer/status` | Optional `session_group` (default Origin); returns installation/enable state, target/runtime/startup status and agent size. Example: `GET /api/observer/status?session_group=origin`. |
| `POST /api/observer/agent-size` | JSON size and optional `sessionGroup`; optional query `session_group`. Returns `{ok:true,...sizeResult}`. Example body: `{"cols":120,"rows":40,"sessionGroup":"origin"}`. |
| `POST /api/observer/install` | Installs/enables observer; returns `{ok:true,...publicStatus}`. Example body: `{}`. |
| `POST /api/observer/enable` | Enables installed observer; returns `{ok:true,...publicStatus}`. Example body: `{}`. |
| `POST /api/observer/disable` | Revokes leases/streams, disables observer; returns `{ok:true,...publicStatus}`. Example body: `{}`. |
| `DELETE /api/observer/install` | Uninstalls and revokes access; returns `{ok:true,...publicStatus}`. Example: `DELETE /api/observer/install`. |
| `POST /api/observer/leases` | Optional JSON `{sessionGroup}`; returns `{ok:true,...lease}` (201). The lease binds identity and target. Example body: `{"sessionGroup":"origin"}`. |
| `POST /api/observer/leases/:id/renew` | Renews the same principal's lease → `{ok:true,...lease}`. Example: `POST /api/observer/leases/<id>/renew`. |
| `POST /api/observer/leases/:id/release` | Releases owned lease → `{ok:true,released:true}`; missing owned lease is idempotent. Example: `POST /api/observer/leases/<id>/release`. |
| `GET /observer/frame` | HTML terminal frame; `X-Observer-Lease` header required. HEAD is supported. Example: `GET /observer/frame` with lease header. |
| `GET /observer/stream` | WebSocket upgrade with the observer protocol and lease credentials. Query parameters are rejected. Example: connect to `/observer/stream` using the issued lease. |
| `GET /api/observer/history/sessions` | Optional `session_group` (default Origin) → `{runtime,current,sessions}`. Example: `GET /api/observer/history/sessions?session_group=telegram%3Ateam`. |
| `GET /api/observer/history/entries` | Same group, required `session`, optional `before|after|around`, `limit=1..200`, `internal=0|1` → entries, updates and older/newer cursors. Example: `GET /api/observer/history/entries?session_group=origin&session=<id>`. |
| `GET /api/observer/history/content` | Same group, required `session,entry,field`, optional text `offset` → UTF-16 text chunk `{text,offset,next,total}` or binary bytes. Example: `GET /api/observer/history/content?session_group=origin&session=<id>&entry=o:0&field=text`. |
| `GET /api/observer/history/search` | Same group, required `session,q` (2–200 chars), optional `limit=1..200` and `before` → bounded matches. Example: `GET /api/observer/history/search?session_group=origin&session=<id>&q=hello`. |

All four history routes use the same selected group. In single mode only Origin is valid. History supports offline groups through imported runtime-event attribution and transcript files, without acquiring a live terminal lease. A session outside the selected group returns 404. Missing/disabled observer history returns 404; invalid group/target/cursor/size returns 400; state conflicts return 409; inaccessible dependencies return 503. Terminal stream failures close the connection after upgrade.

## Fleet

`GET /api/fleet` is a read-scoped status API. Configuration and probe routes are admin and local-only. A remote request is authorized both on the local proxy and the destination; no old-version fallback exists.

| Method/path | Contract and minimal example |
|---|---|
| `GET /api/fleet` | Returns self/remote status records and update metadata. Example: `GET /api/fleet`. |
| `GET /api/fleet/agents` | Returns `{self,agents}` configuration with credential material redacted. Example: `GET /api/fleet/agents`. |
| `POST /api/fleet/agents` | JSON `{name,base_url,read_api_key}` → `{ok:true,...configuration}` after validation/probe. Example body: `{"name":"worker","base_url":"https://worker.example/dashboard","read_api_key":"<key>"}`. |
| `POST /api/fleet/agents/test` | JSON `{base_url,read_api_key}` → `{ok:true,...probeResult}`. Example: same destination/key as an add request. |
| `DELETE /api/fleet/agents/:name` | Removes the configured remote → `{ok:true,self,agents}`. Example: `DELETE /api/fleet/agents/worker`. |
| `GET /fleet/:name/*` | Proxies allowed read routes/assets using configured credentials. Example: `GET /fleet/worker/api/settings/chat`. |
| `PUT`, `PATCH`, `POST`, `DELETE /fleet/:name/*` | Only explicit object-write allowlist entries are proxyable, with admin and browser same origin. Local-only name, key, Fleet config, deletion and chat-setting writes cannot be proxied. Example: `POST /fleet/worker/api/schedules/report/actions/pause`. |

Fleet rejects unknown agents with 404, local-only/forbidden routes with 403, invalid paths with 400 and upstream failures with 502/504. JSON upstream errors are normalized to the common envelope. Attachment, observer WebSocket and SSE relays keep their streaming content types.

## Push

### GET /api/stream

**Access:** Read for the ordinary stream. Chat subscriptions additionally use the existing chat-access rules (local owner or permitted remote chat access).

**Parameters:** no parameters for ordinary instance events. Chat opt-in uses `chat=1`, optional `chat_tab=mine|external` (default mine) and `chat_conversation` (an encoded conversation ID); repeated subscription parameters and legacy `chat_ids` are invalid; invalid subscriptions are rejected rather than treated as an ordinary stream. Response is `text/event-stream`, not JSON.

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

Multi-session Fleet `group_summary` optionally includes `attention`, projected from the same observations as Overview. Supported kinds are `channel_send_failed`, `channel_restarting`, `start_failed`, `rate_limited` and `data_unreadable`. Items carry only applicable bounded text fields (`group`, `displayName`, `runtime`, `channel`, `service`, `reasonCode`, `source`), nonnegative `count`/`count30m`, and `until`. Channel items have no group link. Group unreadability includes the group name/key and diagnostic reason; clients render reason text through text nodes. Existing running/counts/problems semantics remain unchanged, and older remote summaries without `attention` remain valid. Offline start failures use the existing filtered offline resource, including pagination; a failed read remains a diagnostic observation.

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
