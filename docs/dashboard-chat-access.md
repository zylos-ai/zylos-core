# Dashboard conversation access

Conversation handlers call `requireChatAccess(req, auth, config)` before any
reader or business-state query. It returns `null` on success or an HTTP `status`
and response fields on refusal. Authentication must be enabled. A validated
cookie session is local admin. Every API session is remote, including direct
script requests: `config.chat.allowRemote` must be exactly `true`, and the key
scope must be `admin`.

The independently registered conversation routes are:

| Method | Route |
| --- | --- |
| GET | `/api/chat/conversations` |
| GET | `/api/chat/conversations/:id/messages` |
| GET | `/api/chat/conversations/:id/status` |
| GET | `/api/chat/conversations/:id/questions` |
| POST | `/api/chat/drafts` |
| POST | `/api/chat/conversations/:id/send` |
| POST | `/api/chat/conversations/:id/answers` |

These are access/proxy contracts; the history, draft, send and answer handlers
are implemented separately. New routes must be registered explicitly in
`isChatDataRoute`; writes also need the fleet write allowlist and its shared
route fixture. The hub checks its current visitor's admin scope before using
the configured remote credential. The data instance still applies its own
remote-permission gate.

Writes call `requireChatWrite` with the authoritative mode. Draft creation uses
`draft: true`. Sending and answering pass the server-stored `conversation`
record (`channel`, `namespace`, `localId`) and the server's expected namespace
and local ID. Do not construct this record or routing identity from request
fields. Missing records fail closed. Cookie writes also require same-origin
browser provenance. Business handlers still validate the requested group,
message and answer against their persisted ownership and constraints.

`GET` and `PUT /api/chat/settings` are local-cookie-only, including when the
remote permission is enabled. PUT accepts only `{ "allowRemote": boolean }`,
uses the existing serialized config mutation, and updates memory after a
successful persistent write. Fleet never forwards this endpoint. It is separate
from generic remote-editable settings.

Workbench groups, search, activity and their existing redacted summaries keep
their current access rules. Web Console history always excludes the actual
`dashboard` channel, independently of this setting and of namespace names.
