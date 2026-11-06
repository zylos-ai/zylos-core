# Dashboard drafts and text sending

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
after activation returns its existing receipt, even if the supplied text differs.
Use the returned canonical `g:<hex group>` conversation ID for later messages.
The caller cannot supply a channel, namespace, endpoint, group or target group.
The registered local ID is both the Core endpoint and local group name.

An empty draft exists only in the Dashboard database. No Core namespace, message,
group head or runtime is created until sending. Local IDs are retained permanently;
collisions with registered drafts or historical Dashboard endpoints/heads are
skipped. Namespace allocation uses Core's persistent component binding.

The draft row owns its display name before activation. Activation transfers that
name to `group_display_names` if the group has no existing name, then clears the
draft name. An existing workbench name takes precedence. After activation both
conversation and workbench renames write `group_display_names`; routing keys stay
fixed through renames, refresh and runtime reclamation.

Receipts distinguish `stored: false`, `stored: true`, and `stored: null` (unknown).
`messageId` is saved when Core provides it. `deliveryState` is read from the C4
inbound row's status and delivery action; Core's returned `action` is only a hint.
An `action` of `delivered` does not establish that the message reached an agent.
An existing group head proves only that the group exists, not which message was
stored or delivered.

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
user reviews the refreshed history. There are no polling jobs, retry leases or
automatic resends. One sender instance permits one in-flight call per local ID;
this does not promise cross-process exactly-once delivery.

The mine list merges bounded Core and draft sources using the existing timestamp
and stable-ID cursor order. Drafts use their Dashboard update time, appear only in
mine, and are omitted once an authoritative Core head exists. External history
remains read-only. This implementation adds no archive, delete, close, question
answering or frontend action.
