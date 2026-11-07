---
name: dashboard
version: 0.6.9
description: Zylos observability dashboard with a conversation channel for agent state, costs, tools, communication, scheduler, and PM2 service health. Full features on Claude runtime. PM2, system health, communication, and scheduler monitoring on all runtimes.
type: capability

c4:
  delivery: stdin
  before_send:
    hook_id: dashboard.content
    entry: scripts/send-hook.js
    timeout_ms: 1500

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-dashboard
    entry: src/index.js
  data_dir: ~/zylos/components/dashboard
  preserve:
    - config.json
    - dashboard.db
    - spool/
    - backups/
  next-steps: "Dashboard is bundled with Core. Upgrade with zylos upgrade --self; Core owns activity hooks."

http_routes:
  - path: /dashboard/*
    type: reverse_proxy
    target: 127.0.0.1:3470
    strip_prefix: /dashboard

config:
  required: []
  optional:
    - name: DASHBOARD_PORT
      description: Dashboard server port
      default: "3470"
    - name: DASHBOARD_HOST
      description: Dashboard bind address
      default: "127.0.0.1"
    - name: DASHBOARD_AUTH_PASSWORD
      description: Dashboard login password (independent from Web Console; generated on first install and never printed)
      sensitive: true


---

# Zylos Dashboard

Observability dashboard for a local Zylos agent, with a Dashboard conversation channel.

## Conversation channel

The Dashboard channel requires Core support for channel-declared synchronous
BeforeSend hooks and post-storage stdin delivery. Deploy the matching Core and
Dashboard capabilities together; an older argv-only Core cannot deliver this
channel. This declaration does not add a separate service or registration step.

Send plain text through the C4 send entry, using the original conversation ID as
the endpoint and its local group name when replying within that group:

```bash
cat <<'EOF_MESSAGE' | node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js dashboard conversation_a --session-group conversation_a
Your plain-text reply.
EOF_MESSAGE
```

Use the exact endpoint/group from the originating conversation; display names do
not select a destination. Do not call the low-level `c4-db.js insert` command for
Dashboard sends: it bypasses BeforeSend. Core stores the original text, then
passes the six-field delivery packet to `scripts/send.js` on stdin; the script's
argv does not carry the message body. Callers do not construct this packet.

The synchronous hook permits unmarked text up to 65,536 UTF-8 bytes, including
ordinary JSON and Core status notices. Content beginning with the exact shared
`[C4-JSON]` plus LF prefix must pass the shared C4 envelope parser: version,
block types, actions, fields and known Core suffix rules are validated without
rewriting the original content. Malformed envelopes and any oversized message
are rejected before storage or channel delivery. See Core's
`docs/c4-content-protocol.md` for the envelope contract and examples.

After the stored row is verified, an interactive message is registered with its
original group, C4 reference, question summary, constraints and paused state.
Repeated delivery of the same C4 reference preserves the existing record and
its current state. A different C4 row reusing the same group and interrupt ID
fails registration; its content remains stored and read-only, and does not
replace the original question. If registration fails, the message is already stored in C4 and remains visible
as read-only content. Do not resend it. Repair must use the same C4 reference;
this release does not provide a product entry point for that repair. The repair
entry point belongs to subsequent work.
Answers, stop/replace control envelopes and noninteractive messages do not
register or change questions in this channel receiver. Answering and lifecycle
controls are separate capabilities.

A successful send confirms the stored row and channel handoff; it does not prove
that a person viewed the text. Dashboard delivery reads the authoritative C4 row
by its ID using a read-only connection and does not call back into Dashboard HTTP.
Plain-text and noninteractive delivery do not open the Dashboard database.
Question registration writes only to Dashboard's database after the C4 readback;
it never writes C4 or creates a second message/head.

Release prerequisites (verify actual installed versions before deployment):

| Component | Minimum version |
| --- | --- |
| Core | TBD — finalized with Core release (待定，随 Core 定版); must include shared envelope parsing, all model/history readers migrated to projection, BeforeSend and stdin delivery |
| identity-reflection | TBD — finalized with Core release (待定，随 Core 定版); must include the reviewed projected-history adapter |
| thinking-patterns | TBD — finalized with Core release (待定，随 Core 定版); must include the reviewed projected-history adapter |

These are release requirements. No automatic capability detector or runtime
disable switch substitutes for verifying the deployed versions.

## Dashboard service

```bash
npm start
```

Default URL: `http://127.0.0.1:3470/`

A new installation creates an independent random password hash without printing
the password. Before first sign-in, set an owner-chosen Dashboard password through
the existing `hooks/configure.js` stdin JSON interface: supply
`DASHBOARD_AUTH_PASSWORD` as the scrypt value produced by
`hashPassword` from `src/lib/auth.js`. Point `ZYLOS_DATA_DIR` at this instance's
`components/dashboard` directory. Keep the plaintext in memory, out of command
arguments, files and logs; the configure input and saved config contain only the
hash. Restart Dashboard after changing its configuration. Existing installations
keep their configured password. Dashboard does not share Web Console credentials.

For optional terminal viewing, supported platforms and cleanup recovery, see
[Observer](docs/observer.md). Observer automatically selects the target Dashboard
host's platform: macOS Apple Silicon, Linux x64 or Linux ARM64. Install and enable
it from Settings; the linked guide lists host requirements and cleanup behavior.

## Drafts and text sending

All routes require the Dashboard conversation access policy. Writes require
multi mode, admin access, same-origin cookie requests, and a registered
Dashboard-owned conversation. API access also requires `chat.allowRemote`.

| Request | Body | Result |
| --- | --- | --- |
| `POST /api/chat/drafts` | `{displayName?}` | `201 {conversation}` |
| `GET /api/chat/conversations/:id` | none | Receipt and registered conversation; reconciles an uncertain first send by reading its Core head |
| `PATCH /api/chat/conversations/:id` | `{displayName}` | `{conversation}` |
| `POST /api/chat/conversations/:id/send` | `{content, retry?}` | Receipt based on the authoritative inbound row, when available |

Use returned IDs as opaque route segments and URL-encode them. The draft ID
`d:<localId>` identifies the initial send permanently. Repeating that request
after activation returns its existing receipt only when the content matches the
initial submission. Different content returns HTTP 409 with the canonical
`conversationId` and `preserveInput: true`; the frontend must keep the input and
use that canonical ID for a deliberate later send.
Use the returned canonical `g:<hex group>` conversation ID for later messages.
The caller cannot supply a channel, namespace, endpoint, group or target group.
The registered local ID is both the Core endpoint and local group name.

An empty draft exists only in the Dashboard database. No Core namespace, message,
group head or runtime is created until sending. Local IDs are retained permanently;
collisions with registered drafts or historical Dashboard endpoints/heads are
skipped. Namespace allocation uses Core's persistent component binding.

Omitting `displayName` stores NULL; unnamed draft and active API names remain
NULL, and the frontend chooses fallback text. NULL is never written as a human
name, so automatic workbench naming remains available. The draft row owns an
explicit display name before activation. Activation transfers that name to
`group_display_names` if the group has no existing name, then clears the draft
name. An existing workbench name takes precedence. After activation both
conversation and workbench renames write `group_display_names`; routing keys stay
fixed through renames, refresh and runtime reclamation.

Receipts distinguish `stored: false`, `stored: true`, and `stored: null` (unknown).
`messageId` is saved when Core provides it. `deliveryState` is read from the C4
inbound row's status and delivery action; Core's returned `action` is only a hint.
An `action` of `delivered` does not establish that the message reached an agent.
For an uncertain first send, the exact group head proves the first insert
committed because Core writes both in one transaction. The receipt has
`stored: true` and `retryAllowed: false` through both draft and canonical IDs;
without the original message ID its delivery state still needs reconciliation.
Retrying that first text through the canonical ID reuses the receipt, while new
text is a normal subsequent send and does not require `retry: true`. The head
does not establish a message ID or delivery status.

`DB_BUSY`, `DB_WRITE_FAILED`, and branded pre-insert errors with `persisted: []`
are definite no-store results. The draft and input remain available for retry.
Suppressed notifications and errors carrying `persisted: ['D1']` establish an
inbound commit. They activate the conversation and never cause an automatic resend.
The same committed non-success content reuses its stored receipt, including when
the caller supplies `retry: true`.

Before entering Core, the pending input and send state are saved in one Dashboard
transaction. A restarted service treats an unfinished call as unknown. Opening or
refreshing an uncertain first send reads its exact namespace/local-ID head again;
it never calls receive. If no head exists, the input remains and the user can
choose a retry. If the head read fails, reconciliation remains pending. Unknown
later sends retain their input and require an explicit `retry: true` after the
user reviews the refreshed history. This is also required when the user changes
the text after an unknown later result; new content alone does not acknowledge
the earlier uncertainty. There are no polling jobs, retry leases or
automatic resends. One sender instance permits one in-flight call per local ID;
this does not promise cross-process exactly-once delivery.

The mine list merges bounded Core and draft sources using the existing timestamp
and stable-ID cursor order. Drafts use their Dashboard update time, appear only in
mine, and are omitted once an authoritative Core head exists. External history
remains read-only. These draft and ordinary-send endpoints manage registration,
naming and message submission; question answers and UI actions have separate contracts.

### Questions, answers and delivery recovery

`GET /api/chat/conversations/:id/questions?limit=50&cursor=…` returns a bounded
`items` page with `nextCursor`. Each item preserves the original question
references, summary and constraints, its Dashboard lifecycle state, any accepted
`answer_id`, its saved `action` and its delivery receipt. After refresh, retry
by posting that item's `action` unchanged with its `interrupt_id` as `interruptId`
and `retry: true` when `delivery.retryAllowed` is true. A saved action that cannot
be parsed as an object returns `actionError: "chat_answer_action_invalid"` on that
item instead of `action`; other items remain readable. Opening or refreshing the
group checks only unresolved answer deliveries in bounded batches, using the same selection
as startup recovery. A confirmed delivery with a saved C4 ID reads that row's
status directly; it does not rescan the group's messages or replace its saved
commit evidence with a lookup error. Opening a group never resends an answer.

`POST /api/chat/conversations/:id/answers` accepts
`{interruptId, action, retry?: boolean}`. `action` is the shared protocol's
ActionRequest, including its stable `id`. No caller-supplied summary, channel,
namespace, endpoint or target group is accepted. The server uses the original
saved question, validates the answer against its saved block/interrupt and
builds the self-contained answer fallback from its stored summary and option or
field labels. The original group must be an active registered Dashboard
conversation. Local browser admins may write in multi mode; API requests also
require the data instance's remote-chat switch and admin scope. Cookie writes
require the same origin. Read keys and single mode cannot accept answers.

One question accepts one answer. Repeating the same action and ID returns its
saved answer and delivery; a competing answer cannot overwrite it. Acceptance,
question status and the unfinished delivery row commit in one Dashboard
transaction before the original in-process Core `receive()` call. The sender
reuses the installed-Core loader, instance DB_PATH check and receive-result
classification used by ordinary sends. One answer has at most one in-flight
call in this process. No cross-process exactly-once guarantee is made.

Before the first delivery or an explicit retry, the server reads indexed C4
pages limited to the original group, Dashboard channel, inbound direction and
endpoint. Only a valid parsed answer's `metadata.zylos.answerId` matches; text
that merely contains the ID cannot match. A single existing row is reused in
any status, including failed, suppressed and switch_absorbed. Multiple matches
or a failed query remain pending reconciliation. Returned `action: delivered`
does not establish delivery to an agent; receipts use the authority row's
status/delivery_action.

A definite pre-insert failure retains the accepted answer and permits an
explicit retry of that action ID. Unknown results are checked once when the
call ends. Startup recovery checks unfinished deliveries once, and opening or
refreshing their group checks again. Only a successful absence check after the
old call is known to have ended permits `retry: true`; recovery never sends on
its own. Committed evidence always prevents a resend even if the authority row
is temporarily unreadable. There are no retry leases, timers or polling jobs.

Agent-authored stop/replace envelopes are applied after the channel verifies
the authoritative stored outbound row. Replacement requires a separately
registered paused question in the same group. Dashboard records `stopped` or
`superseded` plus replacement metadata; the original C4 question remains
immutable. If application fails after storage, the channel reports the original
error code and that the message is already stored/read-only and must not be
resent. Confirmation `cancel` remains an accepted answer. Ordinary new chat
messages leave paused questions unchanged.
