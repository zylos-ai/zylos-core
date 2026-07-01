# Dev Plan: C4 Store Full Messages + Strip Reply Via (#618)

## Summary

c4.db should be a complete canonical conversation log. Currently it has two problems: (1) long messages (>2KB) are truncated to a preview + attachment file path, and (2) the `reply via` suffix is baked into every inbound message's `content` column despite being fully reconstructable from `channel` + `endpoint_id`. This change fixes both: store full content, strip `reply via` from storage, and reconstruct it dynamically only at agent delivery points (dispatcher and session init).

## Scope

**In scope:**
- c4-receive.js: store full message content (no truncation), do not append `reply via` suffix
- c4-dispatcher.js: reconstruct `reply via` suffix when delivering inbound messages to agent
- c4-session-init.js: reconstruct `reply via` suffix when loading recent conversations for agent context
- Tests for all changed paths

**Out of scope:**
- No migration of old data (existing rows remain as-is)
- No structural refactor of channel-provided metadata prefixes (`[TG DM]`, `<current-message>`, etc.)
- No new DB columns
- No changes to outbound (direction='out') messages

## Key Design Decisions

### `formatConversations()` stays clean (no reply via)

`formatConversations()` in `c4-db.js` is a shared formatter used by both `c4-session-init.js` and `c4-fetch.js`. Per Issue #618, `c4-fetch` / Memory Sync / Identity Reflection / audit consumers should see **clean content without reply via**. Therefore `formatConversations()` must NOT unconditionally append reply via.

Instead:
- `formatConversations()` remains a clean history formatter (default, no reply via)
- `c4-session-init.js` reconstructs reply via **after** calling `formatConversations()`, or uses a wrapper/option to add reply via to the output
- `c4-dispatcher.js` reconstructs reply via independently at delivery time
- `c4-fetch.js` calls `formatConversations()` directly and gets clean output — no change needed

### Reply via reconstruction guard: `endpoint_id` is the signal

Reply via is only reconstructed when `direction === 'in'` AND `endpoint_id IS NOT NULL` AND content does not already contain `---- reply via:` (legacy guard).

`--no-reply` messages that have no real reply target use `endpoint_id = NULL` (either explicitly or by convention: `--no-reply` without `--endpoint` omits it). The read side uses `endpoint_id IS NOT NULL` as the replyability signal. This is verified by a new test case.

## Development Checklist

- [ ] **1. Extract `buildReplyViaSuffix()` as a shared utility**
  - Move the reply-via construction logic from `c4-receive.js buildFullMessage()` into a shared function (in `c4-config.js` or a new `c4-utils.js`)
  - Signature: `buildReplyViaSuffix(channel, endpointId)` → returns `" ---- reply via: node .../c4-send.js \"channel\" \"endpoint\""` or `""` if channel or endpointId is missing/null
  - This function only builds the suffix from route fields. **Callers** are responsible for the legacy duplicate guard (checking if content already contains `---- reply via:` before appending)
  - Read-side consumers (session-init, dispatcher) import this function

- [ ] **2. Simplify `buildFullMessage()` in c4-receive.js**
  - Remove the `reply via` suffix construction (now in shared utility, but no longer used at write time)
  - Remove the `FILE_SIZE_THRESHOLD` truncation logic — store `content` directly as `dbContent`
  - Remove attachment file creation (`fs.mkdirSync`, `fs.writeFileSync` to `ATTACHMENTS_DIR`)
  - `buildFullMessage()` now simply returns `content` (the raw message from the channel)
  - The `noReply` parameter is kept for API compatibility but no longer affects `dbContent`

- [ ] **3. Add `formatConversationsForAgent()` for session-init**
  - Create a new function `formatConversationsForAgent(conversations)` (in `c4-db.js` or a new utility) that iterates the original conversation records and appends reply via per-record **before/while formatting** — NOT as string post-processing after `formatConversations()` has flattened the records
  - For each record: if `direction === 'in'` AND `endpoint_id` is non-null AND `content` does not already contain `---- reply via:`, append the reconstructed suffix to that record's content during formatting
  - `c4-session-init.js` calls this instead of `formatConversations()`
  - `formatConversations()` remains unchanged (clean, no reply via) for c4-fetch and other consumers

- [ ] **4. Reconstruct reply via in dispatcher delivery (c4-dispatcher.js)**
  - In `processNextMessage()`, when delivering a conversation item (`item.type === 'conversation'`), reconstruct the reply via suffix using `buildReplyViaSuffix(item.channel, item.endpoint_id)` and append it to the delivery content
  - Guard: skip if `endpoint_id` is null or content already contains `---- reply via:`
  - Import `buildReplyViaSuffix` from the shared utility

- [ ] **5. Clean up unused imports/exports in c4-receive.js**
  - Remove imports: `FILE_SIZE_THRESHOLD`, `ATTACHMENTS_DIR`, `CONTENT_PREVIEW_CHARS` (if no longer used anywhere in c4-receive.js)
  - Keep these exports in c4-config.js for now (other consumers might reference them) — only remove if confirmed unused across the codebase

- [ ] **6. Update comm-bridge reference docs**
  - Update `skills/comm-bridge/references/c4-receive.md`: remove documentation of long-message attachment storage (lines ~58-60) and the statement that c4-receive appends reply via into message content (lines ~90-96)
  - Reflect the new behavior: content stored in full, reply via reconstructed at delivery time

## Test Checklist

- [ ] **c4-receive.test.js**: Short message stored without reply via suffix in content
- [ ] **c4-receive.test.js**: Long message (>2KB) stored in full without truncation, no attachment file created
- [ ] **c4-receive.test.js**: `--no-reply` message stored without reply via suffix (same as before, but verify)
- [ ] **c4-session-init-cli.test.js**: Session init output includes reply via suffix for inbound messages with endpoint_id
- [ ] **c4-session-init-cli.test.js**: Session init output does NOT include reply via suffix for outbound messages
- [ ] **c4-session-init-cli.test.js**: Session init output does NOT include reply via suffix for `--no-reply` inbound messages (endpoint_id = NULL)
- [ ] **c4-dispatcher-pure.test.js**: Dispatcher delivery content includes reconstructed reply via for inbound conversations with endpoint_id
- [ ] **c4-dispatcher-pure.test.js**: Dispatcher delivery content does NOT include reply via for messages with null endpoint_id
- [ ] **c4-fetch-cli.test.js**: Fetch output does NOT include reply via suffix (clean content)
- [ ] **Legacy row handling**: Content already containing `---- reply via:` does not get a duplicate suffix in session-init or dispatcher

## Assumptions

- [ ] **`formatConversations()` is used by both session-init and c4-fetch** — confirmed by code inspection. It must remain clean (no reply via) so c4-fetch and Memory Sync consumers get undecorated content. Session-init adds reply via separately.
- [ ] **Dispatcher reads `item.content` directly from DB** — it does not go through `formatConversations()`. Reply via must be separately reconstructed in the dispatcher delivery path. *Guaranteed by code inspection: dispatcher reads via `getNextPending()` which returns raw DB rows.*
- [ ] **`endpoint_id IS NOT NULL` is a reliable replyability signal** — messages that should receive reply via (real user messages from channels) always have an endpoint_id. `--no-reply` messages either have no endpoint or use channel='system'. *Validated: c4-receive.js requires `--channel` and passes `endpoint` to `insertConversation()`. Channel is mandatory; endpoint can be null for system/no-reply messages.*
- [ ] **`ATTACHMENTS_DIR` files are not read by any current consumer** — c4-fetch and c4-session-init do not auto-expand attachment paths. Removing attachment creation won't break any active read path. *Verified by code inspection and Issue #618 evidence.*
- [ ] **Old attachment files on disk can remain** — we don't delete them; they're harmless. Disk cleanup is a separate concern.

## Acceptance Checklist

- [ ] New short inbound message: `content` column has raw message without `reply via`
- [ ] New long inbound message (>2KB): `content` column has full message, no truncation, no attachment file
- [ ] Dispatcher delivery to agent: message includes `---- reply via: ...` suffix (reconstructed)
- [ ] Session init output: inbound messages with endpoint_id include `---- reply via: ...` suffix
- [ ] Session init output: outbound messages and no-reply messages do NOT include reply via
- [ ] c4-fetch output: NO reply via suffix (clean canonical history)
- [ ] Legacy rows (with baked-in reply via): no duplicate suffix in any read path
- [ ] All existing tests pass (`npm test`)
- [ ] No regressions in message flow: send a Telegram message → verify it's stored clean, delivered with reply via, and session init shows it correctly
