# Dev Plan: web-console image and file upload/display (#629)

## Summary

Add bidirectional image/file support to the web-console channel: users can attach images/files in the browser console (delivered to the agent via existing C4 attachment conventions), and agent replies carrying media (`[MEDIA:image|file]<path>` — the same syntax used for Lark/Telegram) render inline / as downloadable chips in the console. Existing text-only flows remain byte-for-byte unchanged.

Reference studied: hxa-connect's file message handling (upload endpoint + parts schema + org quotas). We adapt its endpoint/storage/serving patterns; we do NOT import its parts-based message schema — C4 is text-convention based and the agent-side experience must match other channels (issue constraint).

## Current State (facts the design builds on)

- web-console = Express + WS on :3456 (`skills/web-console/scripts/server.js`), cookie session auth, static `public/`, served behind Caddy at `/console/*`.
- Inbound: browser → WS `{type:'send', content}` or `POST /api/send {message}` → server spawns `c4-receive.js --channel web-console --endpoint console --content` → c4.db row → dispatcher → agent.
- Outbound: agent runs `c4-send.js web-console console "<text>"` → c4.db row (web-console's `send.js` is a no-op stub) → server polls c4.db every 500ms → WS broadcast → client renders via `.textContent` (plain text only).
- Channel media convention (Lark/Telegram): inbound files downloaded to `~/zylos/<channel>/media/<prefix>-<ts>-<sanitizedName>`, referenced in the message text the agent receives; outbound media sent as `[MEDIA:image]/abs/path` / `[MEDIA:file]/abs/path`, parsed by each channel's `send.js`.
- c4.db `conversations` has no attachment columns; everything rides in `content` as text. We keep that invariant — **no schema change**.

## Design Decisions

### D1. Two-step inbound: upload first, then send referencing the upload

`POST /api/upload` (multipart, existing session auth) stores the file and returns metadata; the send message (WS or HTTP) carries an optional `attachments: [<upload-id>]` list. The server resolves ids → local paths and builds the annotated text for c4-receive.

- Why not single-step (multipart send)? Two-step matches hxa-connect, gives the UI immediate preview/progress per file, and keeps the send path JSON-only (no multipart parsing in two places).
- Upload ids are single-use, session-scoped, expire after 30 min if unsent (in-memory registry; file already on disk either way).

### D2. Storage: `~/zylos/web-console/media/` (new channel data dir), UUID disk names

- Follows the per-channel `media/` convention (lark/telegram). Web-console gains a data dir like every other channel.
- Disk name: `wc-<timestamp>-<uuid8><sanitized-ext>`; original filename kept only in the message annotation (sanitized). UUID naming + fixed dir = no path traversal surface from filenames.
- No retention/cleanup in v1 — identical to lark/telegram media behavior (documented known gap across channels; not this issue's scope).

### D3. Inbound message format: text annotations appended to content (no schema change)

Agent-visible format (matches the "agent reads a path from the message" experience of other channels):

```
<user text>
[attachment:image /home/.../web-console/media/wc-...png name="screenshot.png" 142KB]
[attachment:file /home/.../web-console/media/wc-...pdf name="report.pdf" 1.2MB]
```

- Text-only sends produce exactly the same content as today (backward compatible).
- Attachment-only sends (no text) are allowed; content is just the annotation lines. This changes three existing empty-text gates that must each be touched explicitly: client `public/app.js:225-226` (`if (!message) return`), WS handler `server.js:245` (requires `msg.content`), HTTP `server.js:343-344` (requires `message.trim()`). Rule: when `attachments.length > 0`, empty user text is allowed BUT the annotation content must be built (non-empty) BEFORE invoking c4-receive, which itself requires non-empty `--content` (`c4-receive.js:356-359`) — that requirement stays satisfied by construction.
- Max 5 attachments per message (UI + server enforced).
- **No special handling needed** — if c4-receive offloads content to `attachments/<msgId>/message.txt`, the agent reads the full content from message.txt (standard C4 behavior). Attachment path annotations are preserved in the offloaded file.

### D4. Outbound: reuse `[MEDIA:type]<path>` c4-send syntax; server maps message-id → file

Agent sends media to the console exactly like other channels: `c4-send.js web-console console "[MEDIA:image]/path/to/img.png"`. No new agent-side syntax.

- Server-side: when a polled out-row matches the MEDIA pattern, broadcast it as `{kind:'media', media_type, message_id, name, size}` instead of raw text.
- New `GET /api/media/<message-id>` (session auth) looks up the row **by id in c4.db**, re-validates it is `direction='out' AND channel='web-console' AND endpoint_id='console'` and matches the MEDIA pattern, then streams the file. The client never supplies a path — only a message id. This is the arbitrary-file-read guard: the only paths servable are ones a local C4 writer put into an outbound web-console row.
- Path allowlist on serving, **canonical-path based**: both the allowlist roots (`$ZYLOS_DIR`, `/tmp`) and the target file are resolved with `fs.realpath` BEFORE the containment check; containment is judged on canonical paths (`realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)`). A symlink under /tmp pointing outside the allowlist (e.g. `/tmp/link → /etc/passwd`) therefore fails containment → 404. Broken/missing symlink or nonexistent file → 404. String-prefix checks on `path.resolve()` output alone are explicitly NOT sufficient and must not be used. Out-of-allowlist and symlink-escape attempts are logged.
- Trust boundary (stated precisely, not as a guarantee): `c4-send.js` is a local C4 writer — any process in the same OS trust zone can create `out` rows. The security claim is: an **authenticated browser user cannot create out rows** (no console API writes them); only local trusted processes (the agent and siblings) can. Under that boundary, message-id lookup + row revalidation + canonical-path allowlist is sound.
- Caveat to accept: the file must still exist at render time (agent may clean up later). Acceptable for v1; same as Lark where upload happens at send time. If it bites, v2 can copy-on-send in `send.js`.

### D5. Limits & content-type policy

- Upload size cap: 20MB default, `WEB_CONSOLE_MAX_UPLOAD_MB` env override. Enforced by multer; 413 JSON error (hxa-connect's wrapped-error pattern).
- MIME policy: **no allowlist** (matches hxa-connect and our channels — the agent is the consumer and reads from disk), BUT:
  - Inline `<img>` rendering only when magic-byte sniffing (server-side, at serve time) confirms png/jpeg/gif/webp. Everything else serves with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` + `application/octet-stream`. This closes hxa-connect's "trust client MIME" gap — nothing user-uploaded or agent-referenced can execute in the console's origin.
- No daily quotas in v1 (single-owner console behind password; hxa-connect's org quotas solve a multi-tenant problem we don't have).

### D6. UI scope

- Attach button (📎) + drag-drop onto the message list + paste-from-clipboard (images).
- Pre-send: thumbnail strip with per-file remove; upload state per file (progress via XHR upload events).
- Rendering: inline image (max-height capped, click = open full in new tab) for image media; file chip (name, size, download link) for files — both directions (user's own sent attachments render the same way via their annotations).
- Inbound annotations in agent replies are NOT parsed (agent replies are text; only `[MEDIA:...]`-pattern rows from c4-send render as media). User-sent messages render attachments from the client's own send-time knowledge (tempId flow extended), and from the annotation lines when loading history.

### D7. Test placement

web-console has no test setup; zylos-core root has jest. Tests go in `test/web-console-*.test.js` at repo root, server logic refactored where needed into importable ESM units (annotation builder, MEDIA-row classifier, media-path guard incl. realpath containment, sniffer) so they're testable without booting Express. web-console is ESM and root jest runs ESM — import the real modules, never copy functions into tests.

## Explicitly Out of Scope

- c4.db schema changes; parts-style structured message schema (hxa-connect's model) — rejected for this issue.
- Media retention/cleanup policy (channel-wide gap, separate issue if wanted).
- Audio transcription, thumbnails/resizing, virus scanning, multi-user ACLs.
- Other channels' inbound annotation formats (unchanged).
- `zylos attach` shell client rendering of media (text passthrough as-is).

## Development Checklist

- [ ] `media/` dir bootstrap + config (`WEB_CONSOLE_MAX_UPLOAD_MB`, data dir resolution)
- [ ] `POST /api/upload`: multer (memory→disk or disk storage), session auth, size cap, UUID naming, sanitized ext; JSON errors; returns `{id, name, size, mime}`
- [ ] Upload registry (in-memory, session-scoped, 30-min TTL, single-use)
- [ ] Extend WS `send` + `POST /api/send` with optional `attachments: [id]`; build annotation lines; pass combined content to c4-receive (text-only path untouched — assert byte-identical)
- [ ] Attachment-only sends: relax all three empty-text gates (`public/app.js:225-226`, WS `server.js:245`, HTTP `server.js:343-344`) to allow empty text iff attachments present; annotation content built non-empty before the c4-receive call (its non-empty `--content` requirement holds by construction)
- [ ] Outbound MEDIA-row classifier + `GET /api/media/<message-id>` with row re-validation, path allowlist, magic-byte sniff, inline-vs-attachment headers
- [ ] WS broadcast shape for media rows (`kind` field; plain rows unchanged shape)
- [ ] Client: attach button, drag-drop, paste, pre-send strip, XHR upload w/ progress, send with attachment ids
- [ ] Client: render media messages (inline img / file chip) + render annotation lines in history for user-sent messages
- [ ] SKILL.md + references docs update (annotation format for the agent, `[MEDIA:...]` examples for web-console)

## Test Checklist

- [ ] Upload: auth required; size cap 413; filename sanitization; UUID on disk; concurrent uploads
- [ ] Send with attachments: annotation format exact-match; text-only send byte-identical to current behavior; >5 attachments rejected; expired/foreign upload id rejected
- [ ] Media serving: message-id not found / not-out-row / wrong-channel / wrong-endpoint / not-media-row → 404; path outside allowlist → 404; **symlink escape** (`/tmp/link → file outside allowlist`) → 404; broken symlink → 404; allowlist root itself reached via symlinked parent handled via realpath’d roots; sniff mismatch (renamed .exe→.png) → attachment headers not inline; correct inline for real png/jpeg/gif/webp
- [ ] Attachment-only send accepted on BOTH WS and HTTP paths (empty text + 1..5 attachments); empty text + zero attachments still rejected
- [ ] MEDIA-row classifier: exact pattern only (no substring false positives on user text containing "[MEDIA:")
- [ ] Manual browser: attach/drag/paste flows; image inline render both directions; file download; old client (no attachments field) still sends fine

## Assumptions

- [ ] Trust boundary (not a guarantee): authenticated browser users cannot create `out` rows via any console API; only local trusted C4 writers (agent + sibling processes in the same OS trust zone) can. Media-serving security holds under this boundary — see D4.
- [ ] c4-receive `--content` arg handles multi-line content (annotation lines) — **needs validation** (check arg passing / escaping in server.js spawn).
- [ ] Session cookie auth is sufficient for upload/media endpoints (no CSRF token in component today; SameSite=Strict mitigates) — same trust level as existing `/api/send`.

## Acceptance Checklist

- [ ] Browser: upload image via button/drag/paste → agent receives message with readable file path → agent can Read the image
- [ ] Browser: upload non-image file → agent receives path → file intact (checksum)
- [ ] Agent: `c4-send.js web-console console "[MEDIA:image]<path>"` → renders inline in console
- [ ] Agent: `[MEDIA:file]` → file chip, download works, bytes intact
- [ ] Text-only round trip unchanged (regression)
- [ ] Old-style client (raw `{message}` POST) works unchanged
- [ ] Renamed-executable upload does not render/execute inline
- [ ] All tests pass (`npm test` at repo root), lint clean
- [ ] Screenshots of UI states to Howard
