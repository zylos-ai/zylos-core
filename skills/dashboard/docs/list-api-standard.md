# Dashboard List API Standard

## Purpose and scope

Dashboard pages show collections that can grow large: session groups, conversations and, later, other lists. This standard defines one protocol for every collection endpoint, so that a page or the App can filter, search and page any list the same way, and so that request cost does not grow with the amount of stored history.

It applies to:

- the session-group list (`GET /api/groups`) and the conversation list (`GET /api/conversations`), which move to it in the changes that follow this standard;
- every new collection endpoint.

It does not change:

- the Operations Interfaces in [api.md](api.md#operations-interfaces), including `GET /api/groups/origin` and `GET /api/groups/counts`, which external clients (Fleet, OpenMax) read under the compatibility policy stated there;
- Core result codes passed through command adapters (for example `STALE_TARGET`, `RESULT_UNKNOWN`);
- the common error envelope, authentication and timestamp rules in [api.md](api.md#access-and-common-results).

Existing lists outside this round (for example `GET /api/schedules`) follow it when they are next changed.

[api.md](api.md) remains the reference for each concrete route; this document defines the rules those routes follow. A PR adding or changing a collection endpoint checks it against every rule below.

## A representative request

The settings page lists running groups that override the default runtime, eight per page:

```
GET /api/groups?side=running&runtimeOverridden=true&limit=8&include=total
→ 200 {"items":[{"id":"telegram%3Aexample",...}, ...], "nextCursor":"eyJ2Ijox...", "total":13}

GET /api/groups?side=running&runtimeOverridden=true&limit=8&cursor=eyJ2Ijox...
→ 200 {"items":[...5 rows...], "nextCursor":null}
```

If the Dashboard restarted between the two requests, the second returns `400 {"ok":false,"error":{"code":"invalid_cursor","message":"..."}}` and the page reloads from the first page.

## Rules

### 1. Resources and paths

1.1 One collection path per resource: `GET /api/<resource>`. One object: `GET /api/<resource>/<id>`. Subsets are expressed by filter parameters, never by extra list paths such as `/running`, `/offline` or `/search`.

1.2 Everything about one resource lives under its path. When a resource moves, its whole family moves in the same change: for conversations that is the list, detail, messages, status, activity, questions, answers, send, uploads, attachments, drafts, rename, delete and pins. Pins are `PUT /api/conversations/pins?tab=…`. Two prefixes for one resource never coexist.

### 2. Query parameters

2.1 Each filter is one parameter named after the row field or concept it filters, for example `side=running`, `runtime=codex`, `runtimeOverridden=true`, `flag=queued`, `tab=external`. A parameter takes one value; the exceptions are `include` and ID lists (such as a message timeline's `recheckIds`), which are comma-separated. Booleans are written `true` or `false`.

2.2 `q` is the text search. It matches names only (display name and, for groups, the group ID/address); it does not search message content. It is trimmed and at most 64 characters; an empty `q` is the same as no `q`. Filters and `q` combine with AND, before paging.

2.3 Paging uses `limit` and `cursor` only. `limit` is an integer 1–100, default 50. There is no `offset` or page number. A message timeline, which is read in both directions, also takes `direction=before|after`, and its first page may be opened at an anchor (for example the read position) instead of at the newest message. `direction` and the anchor are paging parameters like `limit`: they choose where to read, not which rows belong to the collection.

2.4 `include` requests optional parts as a comma-separated list. `include=total` adds the total match count to a list; `include=raw` adds raw observations to a detail response. Parts not requested are not computed.

2.5 An unknown parameter, a repeated parameter or an invalid value returns 400 `invalid_parameter` with the parameter name (rule 4.2). Nothing is silently ignored.

### 3. Responses

3.1 A list returns `{items, nextCursor, total?}`:

| Field | Type | Meaning |
|---|---|---|
| `items` | array | The rows of this page, in the collection's order |
| `nextCursor` | string / null | Opaque value for the next page; `null` when this is the last page |
| `total` | number | Total rows matching the filters and `q`, including pinned rows; present only with `include=total` |

A message timeline also returns `afterCursor`, the position for reading newer messages; a page opened at an anchor returns both cursors.

A list may add collection-level fields that a page needs (for example `readAt`, `listKnown`, `tz`). It never wraps the result in `{data: …}`.

3.2 A row carries only the fields its list view displays or needs to act on (its ID, name, sort time and status). Heavy or raw data belongs to the detail response.

3.3 Timestamps are ISO 8601 strings, as for every Dashboard API.

### 4. Errors

4.1 Errors use the common envelope `{ok:false, error:{code, message}}`, produced by the shared HTTP serializer.

4.2 Codes are lowercase snake_case, matching the rest of the Dashboard HTTP layer. One condition has one code across all collections:

| Status | Code | When | Extra fields |
|---|---|---|---|
| 400 | `invalid_parameter` | Unknown, repeated or invalid query parameter | `error.param`: the parameter name |
| 400 | `invalid_cursor` | Cursor malformed, tampered with, issued for another collection or other filters, or issued before a Dashboard restart | — |
| 404 | `not_found` | The object ID does not exist | — |
| 503 | `unavailable` | A source the list depends on cannot be read | — |

Collection-specific conditions may add their own codes in the same style.

4.3 A client that receives `invalid_cursor` reloads from the first page with the same filters. This is the normal path after every Dashboard restart, not an error to show.

### 5. Cursors

5.1 Cursors are opaque to clients: pass `nextCursor` back unchanged with the same filters and `q`.

5.2 Cursors are keyset positions: they encode the last row's sort key and ID, never an offset. Rows added or removed while a client pages do not shift the remaining pages. A row whose sort time changes moves to the top; a client that already passed it sees it on its next refresh of the first page.

5.3 A cursor is bound to its collection, filters and `q`, and signed with HMAC. Paging parameters (`limit`, `direction`, an anchor) and per-request ID lists such as `recheckIds` are not bound: one signed position may be read in either direction, and a poll may send a different ID list each time. The signing key is generated randomly at process start, so a restart invalidates outstanding cursors (rule 4.3).

### 6. Ordering

6.1 Every collection has one documented order with a unique tie-breaker (the ID); the cursor key is that order's key.

6.2 Conversation and group lists are ordered by the time of the latest received message, newest first. Every received message counts: messages from people or other agents' bots, scheduled tasks, internal relays from other threads and automation notices. Messages the agent itself sends update the row's preview in place but do not move the row; neither do state changes such as working or idle.

A received message is a stored message with `direction = 'in'` on a visible channel: not `void`, not `control` and not empty. C4 records scheduled tasks under their reply target's channel, or under `system` in Origin when they have none; both count.

6.3 A conversation that has never received a message is ordered by the time of its first message.

6.4 The time shown on a row is its sort time. The preview shows the latest message that the conversation's message page shows, including internal relays and scheduled tasks delivered to that conversation. A received message the message page does not show (such as an Origin scheduled task recorded under `system`) still sets the sort time but is not the preview. The row says who sent that message; whether the page displays it depends on the space available.

6.5 Pinned rows, and Origin in the conversation list, appear only on the first page, before the ordered rows, and take no part in the cursor order; the cursor holds the last ordered row. Pinned rows do not count toward `limit`.

6.6 A page showing a list in this order does not move rows while it stays open. New messages update a row's time, preview and unread marker in place; a row that would move, or a conversation not yet shown, is counted in a bar at the top ("N conversations have new messages"). The list is re-read in the new order when the user clicks that bar, switches tab or reopens the page. This is a page rule; the API always returns the current order.

### 7. Efficiency (acceptance condition)

7.1 Request cost must not grow with the number of stored messages. It may grow with the number of groups or conversations.

7.2 Session groups: the group snapshot is projected into rows once per snapshot generation and indexed by ID. Filtering, `q`, sorting, `total` and paging work on those rows in memory; a detail request looks its row up by ID. The sort time of each group is read as in 7.3.

7.3 Conversations: for each session group, the existing `(session_group, id)` index gives the latest visible message (the preview) directly, and the sort time by scanning backwards only until the first received message. The scan length depends on how many messages the agent sent since the last received one, not on the total. History recorded before session groups existed does not change; it is computed once at Dashboard start and kept in memory.

7.4 `total` is computed only when requested, from the in-memory rows or summaries, never by scanning messages. A count shown to the user that would otherwise grow with messages, such as an unread count, stops counting at a cap (99, shown as `99+`).

7.5 A stored per-conversation summary is not used now. It becomes worthwhile when group counts reach the hundreds; adding it changes only the server side, not this protocol.

7.6 HTTP caching (ETag and similar) is not used; list changes reach pages through push events.

### 8. Fleet

The Fleet page loads the local Dashboard page and proxies its API requests to the peer instance. Before proxying, it reads the peer's `GET /api/instance` (`versions.zylos.installed`); a peer older than the version that introduced this standard is shown as needing an upgrade, and no further API request is sent to it. Old paths are not kept for old peers.

### 9. Shared implementation

Collection routes parse their query with `parseListQuery` in `src/lib/list-query.js`. It validates `limit`, `cursor`, `q`, `include` and the route's declared filters, rejects unknown or repeated parameters, verifies the cursor against the collection, filters and `q`, and signs the next cursor. Routes return its failures with `listErrorBody`, which keeps `error.param`. A new collection uses this module rather than its own parser.

```js
const query = parseListQuery('groups', url.searchParams, {
  filters: { side: ['running', 'offline'], runtimeOverridden: BOOLEAN }, q: true, include: ['total'],
});
// query.filters, query.q, query.include, query.limit, query.after (null on the first page)
const nextCursor = more ? query.nextCursor([sortTime, lastRow.id]) : null;
```

Parameters that are validated but not bound to the cursor (rule 5.3) are declared under `extras` with the same rules as filters and returned in `query.extras`. Detail routes call it with `paging: false`, so they accept only their declared `include` parts.
