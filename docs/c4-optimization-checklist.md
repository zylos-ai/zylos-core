# C4 Communication Bridge - Optimization Checklist

**Date:** 2026-02-06 (original), 2026-02-07 (updated after implementation review)
**Based on:** [C4 Review Report](./c4-review-report.md)
**Status:** Implemented

> Legend: [x] implemented | [-] skipped | [~] implemented differently than originally proposed

---

## Phase 1: Critical Fixes

### 1. [C1] Poison Message Blocks Entire Queue — Dead Letter Mechanism
- **Status:** [x] implemented
- **File:** `c4-dispatcher.js`
- **Implementation:**
  1. `retry_count INTEGER DEFAULT 0` column in conversations table
  2. On delivery failure, `isStatusFresh()` checks `~/.claude-status` mtime to distinguish channel vs message issues
  3. Channel healthy → `incrementRetryCount()` + exponential backoff `sleep(500ms * 2^n)`
  4. `retry_count >= 5` → `markFailed()`, logged prominently
  5. `getNextPending()` filters by `status = 'pending'` (implicitly excludes `failed`, no redundant `AND status != 'failed'` needed)
- **Notes:** Head-of-line blocking with `require_idle` messages is intentional — prevents starvation. Documented in code comment.

### 2. [H1/H6/M2] Unvalidated `source` Parameter — Path Traversal & Command Injection
- **Status:** [x] implemented
- **Files:** `c4-validate.js`, `c4-send.js`, `c4-receive.js`
- **Implementation:**
  1. `source` → `channel` rename completed across all scripts and DB schema
  2. `c4-validate.js` shared module: `validateChannel()` (path traversal check + directory existence) and `validateEndpoint()` (regex `/^[a-zA-Z0-9_-]+$/`)
  3. `c4-receive.js`: `--channel` optional when `--no-reply`, defaults to `'system'`. Path validation only when channel is used for path construction.
  4. Reply-via string quotes channel and endpoint values
- **Notes:** No DB migration needed — this is the v1 open-source release with no existing databases.

### 3. [H5] No SQLite `busy_timeout` — Concurrent Write Failures
- **Status:** [x] implemented
- **File:** `c4-db.js:33`
- **Implementation:** `db.pragma('busy_timeout = 5000')` after WAL mode.

### 4. [H3] Shutdown Race Condition — Duplicate Messages
- **Status:** [x] implemented
- **File:** `c4-dispatcher.js`
- **Implementation:** `shutdown()` only sets `isShuttingDown = true`. `close()` and `process.exit(0)` moved to after `dispatcherLoop()` resolves.

---

## Phase 2: High Priority

### 5. [H2] Tmux Escape Sequence / Newline Injection + Enter Delivery Reliability
- **Status:** [x] implemented
- **File:** `c4-dispatcher.js`
- **Implementation:**
  1. `sanitizeMessage()`: strips 0x00-0x08, 0x0B-0x1F (preserves `\n` 0x0A and `\t` 0x09)
  2. `tmux set-buffer` + `paste-buffer` (avoids send-keys escaping issues)
  3. Post-Enter verification via `capture-pane`: `getInputBoxText()` locates input area between `\u2500` separator lines, `isInputBoxEmpty()` strips prompt char `\u276F` and whitespace
  4. Retry loop: max 3 re-sends of Enter, with 500ms wait between attempts

### 6. [H4/P6] Recovery Misses Same-Second Messages
- **Status:** [~] implemented differently
- **File:** `c4-db.js`, `init-db.sql`
- **Original proposal:** Use `last_checkpoint_id` field on conversations for recovery query.
- **Actual implementation:** Removed `checkpoint_id` from conversations entirely. Checkpoints now record `start_conversation_id` and `end_conversation_id` — the checkpoint self-contains its conversation range. Recovery uses id-range query: `WHERE id > end_conversation_id`. This eliminates the race condition where new messages arriving during Memory Sync processing get missed.
- **Notes:** `insertConversation()` no longer queries the checkpoints table at all — simpler and faster.

### 7. [H7] c4-notify.js Hardcodes Channel List
- **Status:** [x] implemented (deleted)
- **Implementation:** `c4-notify.js` deleted entirely. No broadcast concept.

### 8. [M6] Migration Operations Lack Transactions
- **Status:** [~] resolved differently
- **Original proposal:** Wrap migrations in transactions.
- **Actual implementation:** Removed all migration code. This is v1 open-source release — `init-db.sql` is the single schema source of truth. No migration scenario exists.

### 9. [P1] No Database Cleanup / Archival Strategy
- **Status:** [x] implemented
- **Implementation:** No deletion/cleanup. LIMIT 200 applied to unbounded queries. Conversation history preserved as a critical asset.

---

## Phase 3: Performance & Hardening

### 10. [P2] 200ms Delivery Delay + [M7] Message Size Handling
- **Status:** [~] implemented differently
- **Files:** `c4-dispatcher.js`, `c4-receive.js`, `c4-config.js`
- **Original proposal:** `attachment_path` column + DB stores summary only for large messages.
- **Actual implementation:**
  1. `FILE_SIZE_THRESHOLD = 1500` bytes in `c4-config.js`
  2. Adaptive delay: `getDeliveryDelay()` in dispatcher (200ms base + 100ms/KB, max 1000ms)
  3. Large message handling in `c4-receive.js` (NOT dispatcher): writes full message to `~/zylos/comm-bridge/attachments/{id}/message.txt`, DB `content` stores `preview (100 chars) + [C4] Full message (X.XKB) at: /path + reply-via suffix`
  4. No `attachment_path` column — file path is naturally embedded in message content. Dispatcher delivers `msg.content` directly.
- **Notes:** `CONTENT_PREVIEW_CHARS = 100`. Preview is character-based (not byte-based) — suitable for mixed CJK/Latin content.

### 11. [P3] Sequential Channel Sends in c4-notify.js
- **Status:** [-] skipped (c4-notify.js deleted)

### 12. [M5] Database Schema Constraint Gaps
- **Status:** [x] implemented (partial)
- **Implementation:** `PRAGMA foreign_keys = ON` enabled. No CHECK constraints — application-layer validation sufficient.
- **Notes:** `conversations` table no longer has foreign keys (no `checkpoint_id` column). Only `checkpoints` table exists with no FK references.

### 13. [M7] No Message Size Validation
- **Status:** [-] merged into item 10

### 14. [M8] Silent Queue Accumulation When Tmux Missing
- **Status:** [x] implemented
- **Implementation:** `TMUX_MISSING_WARN_THRESHOLD = 30` consecutive checks (~30 seconds at 1s polling) triggers a WARNING log.

### 15. [L2] package.json `main` Field Path Error
- **Status:** [x] implemented
- **Implementation:** `"main": "scripts/c4-db.js"`. Package name updated to `"comm-bridge"`.

### 16. [L4] Hardcoded Config Values Scattered Across Files
- **Status:** [x] implemented
- **File:** `c4-config.js`
- **Implementation:** All constants centralized: poll intervals, delivery delays, retry params, enter verification, file size threshold, content preview chars, tmux session, status file path, data directories, checkpoint threshold, session init recent count, stale status threshold, tmux missing warn threshold.

---

## Phase 4: Quality & Optimization

### 17. [M9] No Test Suite
- **Status:** [ ] pending
- **Scope:** DB operations (unsummarized range/conversations, checkpoint creation, conversation range queries), input validation, capture-pane parsing.

### 18. [M3] Doc-Code Path Mismatch
- **Status:** [x] implemented
- **Implementation:** `c4-send.js` looks for `scripts/send.js` under channel directory, matching project convention.

### 19. [L3] Dispatcher Fallback Query Duplicates `getNextPending()` Logic
- **Status:** [x] implemented
- **Implementation:** Fallback query block deleted entirely. When `require_idle` message is next but Claude isn't idle, dispatcher returns false and waits. This preserves ordering and prevents starvation.

### 20. [L5] Error Logs Lack Stack Traces + [L1] Silent DB Error Swallowing
- **Status:** [x] implemented
- **Implementation:** All `err.message` → `err.stack`. c4-send.js DB errors now logged as warnings. All short-lived scripts call `close()` in finally blocks for consistency.

### 21. [P5] Multiple Synchronous tmux Spawns per Delivery
- **Status:** [-] absorbed into items 5 and 10

### 22. [P4] 500ms Polling Loop — Wasteful When Idle
- **Status:** [x] implemented
- **Implementation:** Adaptive backoff 1s → 3s when idle, reset on delivery. `getClaudeState()` reads `~/.claude-status` file instead of spawning `tmux has-session`. `isStatusFresh()` checks mtime for stale detection (>5s → offline).

### 23. [P7] Checkpoint Queried on Every Insert
- **Status:** [x] resolved
- **Original:** Skip — caching has no effect.
- **Actual:** `insertConversation()` no longer queries checkpoints at all. Checkpoint range is managed entirely within the checkpoints table (`start_conversation_id`, `end_conversation_id`).

### 24. [P8] Missing `temp_store` PRAGMA
- **Status:** [-] skipped
- **Reason:** Queries are simple, no complex JOINs or large sorts. No practical benefit.

---

## Additional Notes from Review

### Positive Findings
- SQL injection safe — all queries use parameterized statements
- Clean module separation
- SQLite WAL mode correctly chosen
- Priority queue well-implemented
- ESM consistency throughout

### Items Explicitly Not Addressed
- [M4] No Access Control — acceptable for single-user design
- [L6] Channel interface has no formal validation/versioning

---

## Memory Sync Architecture (Designed, Implementation Pending)

### Overview
A dedicated **Memory Sync Skill** runs as a sub-agent (`context: fork`, isolated context window) to handle checkpoint creation and memory management. Equivalent to Claude Code's auto-compact, but under explicit control.

### Trigger Mechanism — Two Hooks

**Hook 1: Session Start** → `c4-session-init.js`
- Always outputs: last checkpoint summary + unsummarized conversations
- If unsummarized count ≤ `CHECKPOINT_THRESHOLD` (30): returns all conversations
- If unsummarized count > 30: returns last `SESSION_INIT_RECENT_COUNT` (6) conversations + instruction to invoke Memory Sync skill with conversation id range

**Hook 2: User Message** → `c4-threshold-check.js`
- Lightweight check: unsummarized conversation count > 30?
- If no → silent (no output)
- If yes → outputs Memory Sync instruction with conversation id range

### Memory Sync Skill Workflow
1. Receive trigger with `--begin <id> --end <id>`
2. Call `c4-fetch.js --begin <id> --end <id>` to get checkpoint summary + conversations
3. Process conversations: extract knowledge, decisions, action items
4. Generate summary of the checkpoint period
5. Call `c4-checkpoint.js <end_id> --summary "..."` to create checkpoint
6. Update memory files
7. Restart main session via restart-claude skill (fresh session > compacted session)

### Database Schema

```sql
-- Checkpoints: self-contained conversation range snapshots
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    summary TEXT,
    start_conversation_id INTEGER,  -- first conversation id in range
    end_conversation_id INTEGER     -- last conversation id in range
);

-- Conversations: no foreign keys, no checkpoint reference
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    direction TEXT NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 3,
    require_idle INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0
);
```

### Script Interfaces

| Script | Purpose | Caller |
|--------|---------|--------|
| `c4-session-init.js` | Session start: context + routing decision | Hook: session start |
| `c4-threshold-check.js` | Lightweight threshold check | Hook: user message |
| `c4-fetch.js --begin <id> --end <id>` | Fetch checkpoint summary + conversations by range | Memory Sync skill |
| `c4-checkpoint.js <end_id> [--summary "..."]` | Create checkpoint (caller provides boundary) | Memory Sync skill |

### Key Design Decisions
- `createCheckpoint()` requires caller to provide `end_conversation_id` — prevents race condition where new messages during processing get "swallowed" into a checkpoint that didn't actually process them
- `start_conversation_id` computed internally from previous checkpoint's `end_conversation_id + 1`
- Conversations table has no `checkpoint_id` column — checkpoint ranges are self-contained in the checkpoints table
- No checkpoint `type` column — all checkpoints uniformly handled by Memory Sync
- Forked sub-agent has clean context window (no parent context inheritance) — ideal for processing large conversation batches

### Status: Architecture designed, Memory Sync skill implementation pending
