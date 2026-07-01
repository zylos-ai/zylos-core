# Dev Plan: C4 Store Full Messages + Strip Reply Via (#618)

## Summary

c4.db should be a complete canonical conversation log. Currently it has two problems: (1) long messages (>2KB) are truncated to a preview + attachment file path, and (2) the `reply via` suffix is baked into every inbound message's `content` column despite being fully reconstructable from `channel` + `endpoint_id`. This change fixes both: store full content, strip `reply via` from storage, and reconstruct it dynamically at the two delivery points (dispatcher and session init).

## Scope

**In scope:**
- c4-receive.js: store full message content (no truncation), do not append `reply via` suffix
- c4-dispatcher.js: reconstruct `reply via` suffix when delivering inbound messages to agent
- c4-session-init.js: reconstruct `reply via` suffix when loading recent conversations
- formatConversations (c4-db.js): reconstruct `reply via` suffix for inbound conversations (used by session init)
- Tests for all changed paths

**Out of scope:**
- No migration of old data (existing rows remain as-is)
- No structural refactor of channel-provided metadata prefixes (`[TG DM]`, `<current-message>`, etc.)
- No new DB columns
- No changes to outbound (direction='out') messages

## Development Checklist

- [ ] **1. Extract `buildReplyViaSuffix()` as a shared utility**
  - Move the reply-via construction logic from `c4-receive.js buildFullMessage()` into a shared function (in `c4-config.js` or a new `c4-utils.js`)
  - Signature: `buildReplyViaSuffix(channel, endpointId)` → returns `" ---- reply via: node .../c4-send.js \"channel\" \"endpoint\""` or `""` if channel/endpoint missing
  - Both c4-receive and the read-side consumers import this same function

- [ ] **2. Simplify `buildFullMessage()` in c4-receive.js**
  - Remove the `reply via` suffix construction (now in shared utility)
  - Remove the `FILE_SIZE_THRESHOLD` truncation logic — store `content` directly as `dbContent`
  - Remove attachment file creation (`fs.mkdirSync`, `fs.writeFileSync` to `ATTACHMENTS_DIR`)
  - The `noReply` parameter still controls whether the reply via suffix is appended — but now it doesn't matter for storage since we never append it. Keep the parameter for API compatibility but it no longer affects `dbContent`
  - `buildFullMessage()` now simply returns `content` (the raw message from the channel)

- [ ] **3. Reconstruct reply via in `formatConversations()` (c4-db.js)**
  - `formatConversations()` already iterates over conversation records and has access to `conv.channel` and `conv.endpoint_id`
  - For `direction === 'in'` records: append the reconstructed reply via suffix to `conv.content` in the formatted output
  - For `direction === 'out'` records: no change (outbound messages never had reply via)
  - Import `buildReplyViaSuffix` from the shared utility
  - This covers session-init (which calls `formatConversations()`) and c4-fetch (which also calls `formatConversations()`)

- [ ] **4. Reconstruct reply via in dispatcher delivery (c4-dispatcher.js)**
  - In `processNextMessage()`, when delivering a conversation item (`item.type === 'conversation'`), reconstruct the reply via suffix using `buildReplyViaSuffix(item.channel, item.endpoint_id)` and append it to the delivery content
  - Only for inbound conversations — outbound messages are never dispatched
  - Import `buildReplyViaSuffix` from the shared utility

- [ ] **5. Handle legacy rows gracefully**
  - Old rows already have `reply via` baked into `content`. The read paths (formatConversations, dispatcher) will now append a second `reply via` suffix to these rows
  - Fix: in `buildReplyViaSuffix()` or at the call site, check if `content` already contains `---- reply via:` and skip appending if so
  - This ensures old rows render correctly (they already have the suffix) while new rows get it dynamically appended

- [ ] **6. Clean up unused imports/exports in c4-receive.js**
  - Remove imports: `FILE_SIZE_THRESHOLD`, `ATTACHMENTS_DIR`, `CONTENT_PREVIEW_CHARS` (if no longer used anywhere)
  - Keep these exports in c4-config.js for now (other consumers might reference them) — only remove if confirmed unused across the codebase

## Test Checklist

- [ ] **c4-receive.test.js**: Short message stored without reply via suffix in content
- [ ] **c4-receive.test.js**: Long message (>2KB) stored in full without truncation, no attachment file created
- [ ] **c4-receive.test.js**: `--no-reply` message stored without reply via suffix (same as before, but verify)
- [ ] **c4-session-init-cli.test.js**: Session init output includes reply via suffix for inbound messages
- [ ] **c4-session-init-cli.test.js**: Session init output does NOT include reply via suffix for outbound messages
- [ ] **c4-dispatcher-pure.test.js**: Dispatcher delivery content includes reconstructed reply via for inbound conversations
- [ ] **c4-fetch-cli.test.js**: Fetch output includes reply via suffix for inbound messages
- [ ] **Legacy row handling**: Content already containing `---- reply via:` does not get a duplicate suffix

## Assumptions

- [ ] **`formatConversations()` is the sole read path for session-init and c4-fetch** — both call this function to render conversation output. If reply via is reconstructed here, both consumers get it. *Guaranteed by code inspection: session-init calls `formatConversations(conversations)` at line 62; c4-fetch calls it at line 39.*
- [ ] **Dispatcher reads `item.content` directly from DB** — it does not go through `formatConversations()`. Reply via must be separately reconstructed in the dispatcher delivery path. *Guaranteed by code inspection: dispatcher reads via `getNextPending()` which returns raw DB rows.*
- [ ] **`channel` and `endpoint_id` columns are always populated for inbound messages** — needed to reconstruct reply via. *Validated: c4-receive.js requires `--channel` and passes `endpoint` to `insertConversation()`. Channel is mandatory; endpoint can be null for system/no-reply messages, but those don't need reply via.*
- [ ] **`ATTACHMENTS_DIR` files are not read by any current consumer** — c4-fetch and c4-session-init do not auto-expand attachment paths. Removing attachment creation won't break any active read path. *Verified by code inspection and Issue #618 evidence.*
- [ ] **Old attachment files on disk can remain** — we don't delete them; they're harmless. Disk cleanup is a separate concern.

## Acceptance Checklist

- [ ] New short inbound message: `content` column has raw message without `reply via`
- [ ] New long inbound message (>2KB): `content` column has full message, no truncation, no attachment file
- [ ] Dispatcher delivery to agent: message includes `---- reply via: ...` suffix
- [ ] Session init output: inbound messages include `---- reply via: ...` suffix
- [ ] c4-fetch output: inbound messages include `---- reply via: ...` suffix
- [ ] Legacy rows (with baked-in reply via): no duplicate suffix in any read path
- [ ] All existing tests pass (`npm test`)
- [ ] No regressions in message flow: send a Telegram message → verify it's stored clean, delivered with reply via, and session init shows it correctly
