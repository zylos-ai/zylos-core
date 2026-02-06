# C4 Communication Bridge - Optimization Checklist

**Date:** 2026-02-06
**Based on:** [C4 Review Report](./c4-review-report.md)
**Status:** Pending confirmation

> Legend: [ ] pending | [x] confirmed | [-] skipped | [?] need discussion

---

## Phase 1: Critical Fixes

### 1. [C1] Poison Message Blocks Entire Queue — Dead Letter Mechanism
- **Status:** [x] confirmed
- **File:** `c4-dispatcher.js:124-173`
- **Problem:** Message delivery failure retries infinitely with no backoff. One bad message permanently blocks the entire queue.
- **Proposed Fix (final):**
  1. Add `retry_count INTEGER DEFAULT 0` column to conversations table
  2. On delivery failure, check `~/.claude-status` file modification time to distinguish failure cause:
     - Status file recently updated (within seconds) → channel healthy → message-specific issue → `retry_count + 1`
     - Status file missing or stale → channel/system issue → don't increment, back off and wait
  3. When channel healthy and retry needed, dispatcher **blocks in-place** with exponential backoff: `sleep(500ms * 2^retry_count)` — no skip, no reorder
     - Retry 1: 500ms, Retry 2: 1s, Retry 3: 2s, Retry 4: 4s → total 7.5s max
  4. `getNextPending()` query adds `AND (status != 'failed')` condition
  5. `retry_count >= 5` → mark `status = 'failed'`
  6. Log prominently when a message is marked failed (include message id and source)
- **Decision:** Adopted. Channel-health-aware retry with in-place exponential backoff. Leverages existing Activity Monitor (`~/.claude-status`) to avoid penalizing messages for channel failures. Dispatcher blocks during backoff to strictly preserve message ordering — max 7.5s queue stall for a poison message, acceptable.
- **Notes:** Rejected `skip_until` / message reordering approach to preserve same-source message sequencing. Rejected `dead_letter` status in favor of `failed`. Rejected `max_retries` config — hardcoded constant sufficient. Threshold 5 retries (not 3) for transient fault tolerance.

### 2. [H1/H6/M2] Unvalidated `source` Parameter — Path Traversal & Command Injection
- **Status:** [x] confirmed
- **Files:** `c4-send.js:58`, `c4-notify.js:37`, `c4-receive.js:39-71, 97-106`
- **Problem:** `source` from CLI args has no validation. `../../some/path` enables arbitrary JS execution. Unsanitized `endpoint` in reply-via string risks command injection when Claude executes it.
- **Proposed Fix (revised):**
  1. **Rename `source` → `channel`** across all scripts, DB schema (`source` column → `channel`), and CLI interface. No backward compatibility — clean cut.
  2. **c4-receive.js**: `--channel` optional when `--no-reply` is set, defaults to `'system'`. Required otherwise.
  3. **Path validation** (only when channel is used for path construction — c4-send.js and c4-receive.js non-`--no-reply` mode):
     - Reject values containing `..` or `/`
     - `path.resolve(SKILLS_DIR, channel)` must stay within `SKILLS_DIR` and directory must exist
  4. **`--no-reply` mode**: channel is just a DB label, no path validation needed.
  5. **endpoint validation**: regex `/^[a-zA-Z0-9_-]+$/`
  6. **reply-via string**: quote channel and endpoint values for defense-in-depth
  7. **Shared validation function** in a common module (e.g., `c4-validate.js`), called by c4-send.js and c4-receive.js
- **Decision:** Adopted with `source` → `channel` rename and context-aware validation. Rejected hardcoded allowlist — use path containment check instead, which is extensible (new channels just need a directory under skills).
- **Notes:** Rename involves DB migration (`source` → `channel` column). c4-notify.js unaffected (channel values are internal). This item also resolves H7 direction — no hardcoded channel list to maintain.

### 3. [H5] No SQLite `busy_timeout` — Concurrent Write Failures
- **Status:** [x] confirmed
- **File:** `c4-db.js:35-36`
- **Problem:** Multiple simultaneous `c4-receive.js` writes get `SQLITE_BUSY`, process exits with code 1, message is lost.
- **Proposed Fix:** Add `db.pragma('busy_timeout = 5000')` after WAL mode configuration.
- **Decision:** Adopted as-is. One line fix, zero risk.
- **Notes:**

### 4. [H3] Shutdown Race Condition — Duplicate Messages
- **Status:** [x] confirmed
- **File:** `c4-dispatcher.js:200-208`
- **Problem:** `process.exit(0)` in signal handler fires immediately. If SIGTERM arrives between tmux delivery and `markDelivered()`, message stays `pending` and gets re-delivered on restart.
- **Proposed Fix:** `shutdown()` only sets `isShuttingDown = true`（flag already exists at line 21, loop already checks it at line 179). Remove `close()` and `process.exit(0)` from signal handler. Move DB close + process exit to after `dispatcherLoop()` resolves.
- **Decision:** Adopted as-is. Existing flag mechanism was correct but bypassed by premature exit.
- **Notes:**

---

## Phase 2: High Priority

### 5. [H2] Tmux Escape Sequence / Newline Injection + Enter Delivery Reliability
- **Status:** [x] confirmed
- **File:** `c4-dispatcher.js:85-119`
- **Problem:** Two issues: (1) Control characters in message content can manipulate terminal. (2) `send-keys Enter` after `paste-buffer` is unreliable — sometimes Enter is lost (observed intermittent bug where messages appear in input box but are not submitted, behaving like Shift+Enter).
- **Proposed Fix (revised):**
  1. **Control character sanitization**: Strip 0x00-0x1F (except `\n` and `\t`) from message content before tmux paste.
  2. **Enter delivery confirmation via `tmux capture-pane`**: After sending Enter, verify the message was actually submitted by checking if the input box is empty:
     - `tmux capture-pane -p -t <session>` to capture pane text
     - Locate the input box area between the last two separator lines (lines matching `/^\u2500+$/` with length > 10)
     - Extract text in input box, strip prompt char (`\u276F`) and all whitespace/NBSP (`\u00A0`)
     - If remaining text length === 0 → submitted successfully
     - If remaining text length > 0 → Enter was lost or interpreted as Shift+Enter → resend Enter
  3. **Retry loop**: After Enter, wait 500ms, check input box. If not submitted, resend Enter. Max 3 retries. All retries fail → delivery failure, enters item 1's retry mechanism.
- **Decision:** Adopted. Combines content sanitization with capture-pane based submission verification. Handles both Enter-lost and Shift+Enter edge cases. Validated separator detection against real capture-pane output (`\u2500` regex works across window sizes).
- **Notes:** Does NOT rely on before/after snapshot comparison (rejected — Shift+Enter changes input box content, causing false positives). Does NOT rely on `~/.claude-status` (rejected — not a reliable signal for submission). Single post-Enter check: "does the input box still have content?"

### 6. [H4/P6] Recovery Misses Same-Second Messages
- **Status:** [x] confirmed
- **File:** `c4-db.js:208-231`
- **Problem:** `WHERE timestamp > ?` with second precision. Checkpoint and messages created in the same second share identical timestamps, causing recovery query to miss those messages.
- **Proposed Fix (final):** Replace timestamp-based recovery query with `last_checkpoint_id` field comparison. The field already exists on every conversation record (currently named `checkpoint_id`, set at insert time, line 120-122, 134). Change `getConversationsSinceLastCheckpoint()` to:
  ```sql
  SELECT * FROM conversations
  WHERE last_checkpoint_id = (SELECT id FROM checkpoints ORDER BY id DESC LIMIT 1)
  ORDER BY id ASC
  ```
  When no checkpoint exists, fall back to returning all conversations (with LIMIT, see item 9).
  **Additionally:** Rename column `checkpoint_id` → `last_checkpoint_id` for clarity (meaning: "the most recent checkpoint when this message was created"). Bundle into the same DB migration as item 2's `source` → `channel` rename.
- **Decision:** Adopted. Uses existing field with rename for semantic clarity — precise, no timestamp granularity issues, no cross-table id confusion.
- **Notes:** Rejected `WHERE id > (SELECT MAX(id) FROM checkpoints)` — conversation ids and checkpoint ids are independent auto-increment sequences, not comparable. Also addresses P6 (integer comparison faster than string datetime).

### 7. [H7] c4-notify.js Hardcodes Channel List
- **Status:** [-] skipped → **delete script entirely**
- **File:** `c4-notify.js`
- **Problem (original):** Telegram and Lark hardcoded. Adding a channel requires code modification.
- **Decision:** Remove `c4-notify.js` entirely. The "broadcast to all channels" concept is architecturally unnecessary — every message (including system events and scheduled tasks) enters via `c4-receive` with a specific reply-to (channel + endpoint), and Claude replies via `c4-send` to that destination. No legitimate use case for channel-wide broadcast. Also remove references in SKILL.md.
- **Notes:** This also eliminates items 11 (P3, parallel sends in notify) and the notify-related parts of item 2 (validation in notify). Future "notify a person" feature will be designed around the concept of people (primary partner / maintenance partner) with multiple channel endpoints — a different architecture entirely.

### 8. [M6] Migration Operations Lack Transactions
- **Status:** [x] confirmed
- **File:** `c4-db.js:60-103`
- **Problem:** Multi-step migrations not wrapped in transactions. Crash mid-migration leaves DB inconsistent.
- **Proposed Fix:** Wrap each migration in `BEGIN`/`COMMIT`.
- **Decision:** Adopted as-is.
- **Notes:**

### 9. [P1] No Database Cleanup / Archival Strategy
- **Status:** [x] confirmed
- **File:** `c4-db.js`, `init-db.sql`
- **Problem:** `getConversationsSinceLastCheckpoint()` queries can return unbounded results, loading entire history into memory.
- **Proposed Fix (revised):**
  1. **No deletion/cleanup** — conversation history is a critical asset (memory, traceability, future agent retrieval). ~50-100MB/year growth is negligible for SQLite.
  2. **Add LIMIT to both query paths** in `getConversationsSinceLastCheckpoint()`:
     - With checkpoint: `WHERE last_checkpoint_id = ? ORDER BY id ASC LIMIT 200`
     - Without checkpoint: `ORDER BY id DESC LIMIT 200`
  3. No periodic VACUUM needed at this scale.
- **Decision:** Adopted. Keep all data, add LIMIT to recovery queries only. Rejected 30-day cleanup — data is too valuable.
- **Notes:** Future consideration: if agent needs to search full history, provide a separate paginated query API rather than loading everything at once.

---

## Phase 3: Performance & Hardening

### 10. [P2] 200ms Delivery Delay + [M7] Message Size Handling (merged with item 13)
- **Status:** [x] confirmed
- **File:** `c4-dispatcher.js:18, 85-119`, `c4-receive.js`, `c4-db.js`
- **Problem:** (1) Fixed 200ms delay doesn't account for message size or system performance variation. (2) No message size validation — large messages fail unreliably via tmux paste. (3) No handling for non-text content (files, images).
- **Proposed Fix (final):**
  1. **Threshold: 1.5KB (bytes)**, not character count — normalizes across languages (≈ 500 Chinese chars ≈ 1,500 English chars).
  2. **Two delivery modes:**
     - **≤ 1.5KB**: tmux paste-buffer with adaptive delay
     - **> 1.5KB**: write to persistent file, paste a short instruction telling Claude to read the file
  3. **Adaptive delay for paste-buffer mode:**
     ```javascript
     function getDeliveryDelay(byteLength) {
       const base = 200;
       const perKb = 100;
       const extra = Math.floor(byteLength / 1024) * perKb;
       return Math.min(base + extra, 1000);
     }
     ```
  4. Both modes use capture-pane confirmation (item 5) as safety net.
  5. **Unified file-based content storage** for all large text, files, and images:
     - Persistent directory: `~/zylos/comm-bridge/attachments/{message_id}/`
     - DB `content` field stores only a short summary/description, NOT full content
     - Conversations table adds `attachment_path TEXT` column for file reference
     - Keeps DB lean and queries fast
  6. **Memory Sync Skill integration**: Sub-agent sees summary in DB; reads attachment files only when it judges the content is relevant to the summary (defined in skill prompt, not forced).
- **Decision:** Adopted. Byte-based threshold from production experience. All large/non-text content stored as files, DB stays lightweight. Sub-agent reads files on-demand.
- **Notes:** Replaces item 13 (M7). The original report's suggestion to "reduce to 0-50ms" is rejected. `attachment_path` column added to DB migration (alongside `source` → `channel` and `checkpoint_id` → `last_checkpoint_id` from items 2 and 6).

### 11. [P3] Sequential Channel Sends in c4-notify.js
- **Status:** [-] skipped
- **Decision:** N/A — c4-notify.js will be deleted (see item 7).
- **Notes:**

### 12. [M5] Database Schema Constraint Gaps
- **Status:** [x] confirmed (partial)
- **File:** `c4-db.js`, `init-db.sql`
- **Problem:** No CHECK constraints on enum columns; `PRAGMA foreign_keys` never enabled.
- **Proposed Fix (revised):**
  1. **Skip CHECK constraints** — system still evolving (new `status` values from item 1, new checkpoint types from Future section). SQLite doesn't support ALTER CHECK, would require table rebuild to change. Application-layer validation is sufficient.
  2. **Enable `PRAGMA foreign_keys = ON`** in `getDb()` after WAL mode config — prevents orphaned references (e.g., conversation pointing to non-existent checkpoint).
- **Decision:** Adopted partially. Only foreign_keys pragma, no CHECK constraints.
- **Notes:**

### 13. [M7] No Message Size Validation
- **Status:** [-] merged into item 10
- **Decision:** See item 10. Messages > 500 chars use file-based delivery instead of tmux paste.
- **Notes:**

### 14. [M8] Silent Queue Accumulation When Tmux Missing
- **Status:** [x] confirmed
- **Problem:** Dispatcher silently returns false when tmux session missing. Messages accumulate with no alert.
- **Proposed Fix:** After ~60 consecutive tmux-missing checks (~30 seconds), log a prominent warning. No channel notification needed (notify is being removed, and message accumulation is by-design — they'll be delivered when session comes back).
- **Decision:** Adopted. Warning log only, accumulation is expected behavior.
- **Notes:**

### 15. [L2] package.json `main` Field Path Error
- **Status:** [x] confirmed
- **File:** `package.json`
- **Problem:** `main` points to `c4-db.js` not `scripts/c4-db.js`.
- **Proposed Fix:** Correct the path.
- **Decision:** Adopted as-is.
- **Notes:**

### 16. [L4] Hardcoded Config Values Scattered Across Files
- **Status:** [x] confirmed
- **Problem:** Poll interval, delays, etc. hardcoded in multiple files.
- **Proposed Fix:** Create `c4-config.js` module with all shared constants (poll interval, delivery delay params, retry thresholds, tmux session name, file size threshold, etc.). All scripts import from this single source.
- **Decision:** Adopted as-is.
- **Notes:**

---

## Phase 4: Quality & Optimization

### 17. [M9] No Test Suite
- **Status:** [x] confirmed
- **Proposed Fix (scoped):** Add targeted tests after implementation, covering critical paths only:
  1. **DB operations**: retry_count increment, status transitions, recovery query (`last_checkpoint_id`), schema migration
  2. **Input validation**: channel path containment check, endpoint regex
  3. **Capture-pane parsing**: separator detection (`\u2500` regex), input box content extraction, empty/non-empty判定
- **Decision:** Adopted. Implement first, then write tests to lock in behavior. Skip tmux interaction / e2e tests (manual verification).
- **Notes:**

### 18. [M3] Doc-Code Path Mismatch
- **Status:** [x] confirmed
- **Problem:** SKILL.md says `scripts/send.js` but code looks for `send.js` at channel root.
- **Proposed Fix:** **Fix the code**, not the docs. Project convention (CLAUDE.md) places scripts in `scripts/` subdirectory. Change `c4-send.js` to look for `scripts/send.js` instead of `send.js`.
- **Decision:** Adopted. Code follows convention, not the other way around.
- **Notes:**

### 19. [L3] Dispatcher Fallback Query Duplicates `getNextPending()` Logic
- **Status:** [x] confirmed — severity upgraded from Low to **High** (message starvation bug)
- **File:** `c4-dispatcher.js:140-157`
- **Problem (revised):** Not just a DRY issue — the fallback query skips `require_idle` messages when Claude is busy, delivering later messages instead. This breaks message ordering and causes starvation: if Claude stays busy, `require_idle` messages are permanently skipped.
- **Proposed Fix:** **Delete the entire fallback query block** (lines 140-157). When `require_idle` message is next but Claude isn't idle, simply `return false` and wait. The dispatcher loop will retry on next poll when Claude becomes idle. This preserves ordering, prevents starvation, and eliminates the code duplication.
- **Decision:** Adopted. Fallback logic is a bug, not a feature — remove it entirely.
- **Notes:** This is a correctness fix, not just a cleanup. Discovered during checklist review.

### 20. [L5] Error Logs Lack Stack Traces + [L1] Silent DB Error Swallowing
- **Status:** [x] confirmed
- **Files:** `c4-dispatcher.js:74,115,191`, `c4-receive.js:113`, `c4-recover.js:23`, `c4-checkpoint.js:44`, `c4-send.js:53`
- **Proposed Fix:**
  1. **All `err.message` logging → `err.stack`** (stack already includes message). Applies to: dispatcher (lines 74, 115, 191), receive (113), recover (23), checkpoint (44).
  2. **c4-send.js:53 — stop silently swallowing DB errors**. Change from `// Silently ignore` to at least `console.error('[C4] Warning: DB audit write failed:', err.stack)`. Audit trail loss should be visible in logs.
  3. **Keep tmux catch blocks as-is** (dispatcher lines 42, 110) — expected control flow, not real errors.
- **Decision:** Adopted. Stack traces enable agent-assisted debugging via log inspection.
- **Notes:** Also resolves report item L1 (c4-send.js silent error swallowing).

### 21. [P5] Multiple Synchronous tmux Spawns per Delivery
- **Status:** [-] absorbed into items 5 and 10
- **Decision:** The delivery flow (`sendToTmux`) is being rewritten as part of items 5 (capture-pane confirmation) and 10 (adaptive delay + file-based delivery). tmux call optimization will be addressed naturally during that rewrite.
- **Notes:**

### 22. [P4] 500ms Polling Loop — Wasteful When Idle
- **Status:** [x] confirmed
- **File:** `c4-dispatcher.js:17, 35-45, 51-80`
- **Problem:** 500ms fixed polling spawns a `tmux has-session` process every cycle (~172,800/day). Main cost is process spawn preventing CPU deep idle. Additionally, `tmuxHasSession()` (line 35-45) redundantly checks tmux session existence when Activity Monitor already does this every second and writes the result to `~/.claude-status`.
- **Proposed Fix (final):**
  1. **Adaptive backoff**: base interval 1s, back off to max 3s when idle, reset to 1s after message delivery. Reject `fs.watch()` (unreliable with SQLite WAL mode across OS).
  2. **Replace `tmuxHasSession()` process spawn with `~/.claude-status` file read**: Activity Monitor already checks tmux session + Claude process status every second, writing JSON to `~/.claude-status` with states: `offline` (no tmux), `stopped` (tmux but no Claude), `busy`, `idle`. Reading a file is orders of magnitude cheaper than spawning a process.
  3. **Merge `tmuxHasSession()` and `isClaudeIdle()` into a single `getClaudeState()` function** that reads `~/.claude-status` once per poll cycle and returns the state object. All callers use this unified function:
     - `state === 'offline'` or `state === 'stopped'` → no delivery (was `tmuxHasSession()`)
     - `state === 'idle'` → can deliver `require_idle` messages (was `isClaudeIdle()`)
     - `state === 'busy'` → can deliver normal messages, skip `require_idle`
     - Stale status file (mtime > 5s) → treat as offline (Activity Monitor may have crashed)
- **Decision:** Adopted. Eliminates all per-poll `tmux has-session` process spawns. Combined with adaptive backoff, reduces per-poll cost from "process spawn + file read" to "file read only", and reduces idle poll frequency by ~3x.
- **Notes:** Depends on Activity Monitor being running (managed by PM2, auto-restart). Stale mtime check provides safety net if Activity Monitor dies.

### 23. [P7] Checkpoint Queried on Every Insert
- **Status:** [-] skipped
- **File:** `c4-db.js:120-122`
- **Problem:** `insertConversation()` runs `SELECT id FROM checkpoints ORDER BY id DESC LIMIT 1` on every call.
- **Decision:** Skip — caching has no effect. Callers (`c4-receive.js`, `c4-send.js`) are short-lived CLI processes that insert one message per execution then exit. Cache never survives to a second call.
- **Notes:**

### 24. [P8] Missing `temp_store` PRAGMA
- **Status:** [-] skipped
- **File:** `c4-db.js:35-36`
- **Problem:** SQLite temp tables/indices use disk by default.
- **Decision:** Skip — queries简单，无复杂 JOIN 或大排序，SQLite 基本不会创建临时表。无实际收益。
- **Notes:**

---

## Additional Notes from Review

### Positive Findings (No Action Needed)
- SQL injection safe — all queries use parameterized statements
- Clean module separation
- SQLite WAL mode correctly chosen
- Priority queue well-implemented
- ESM consistency
- Good SKILL.md documentation

### Items Explicitly Not Addressed
- [M4] No Access Control — acceptable for single-user design
- [L6] Channel interface has no formal validation/versioning
- ~~[L1] c4-send.js silently swallows DB errors~~ → covered by item 20
- ~~[L7] Scattered SKILLS_DIR path definition~~ → covered by item 16 (c4-config.js)

---

## Future: Memory Sync Skill (To Be Designed)

> Identified during item 9 discussion. Requires separate design session.

### Overview
A dedicated **Memory Sync Skill** that runs as a **sub-agent** (`context: fork`) to handle checkpoint creation and memory management.

### Trigger Conditions
1. **Crash recovery** — on session restart, automatically triggered
2. **Proactive context management** — periodically check context usage; before auto-compact triggers, proactively initiate memory cycle (possibly restart session)
3. **Scheduled safety net** — periodic fallback; not critical since auto-compact is the ultimate safety net and recover+read ensures checkpoints get created

### Skill Workflow
1. Receive trigger (recovery / proactive / scheduled)
2. Call C4 DB to retrieve un-checkpointed conversations (`getConversationsSinceLastCheckpoint(limit=200)`)
3. Process conversations through a defined memory workflow:
   - Extract key knowledge, decisions, action items
   - Update memory files (CLAUDE.md or dedicated memory files)
4. Generate summary of the checkpoint period
5. Create new checkpoint in C4 DB **with summary stored in checkpoints table**
6. Return summary to main agent

### Schema Change: checkpoints table
Add `summary TEXT` column to checkpoints table. Each checkpoint records a summary of the conversations in its period.
- Recovery can read checkpoint summaries directly without re-processing raw conversations
- Agents can browse checkpoint summaries to locate relevant historical context
- Forms a memory chain: `checkpoint 1 summary → checkpoint 2 summary → ...`

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,    -- 'session_recovery' | 'memory_sync' | 'scheduled_sync'
    summary TEXT           -- summary of conversations in this checkpoint period
);
```

### Architecture Implications
- `getConversationsSinceLastCheckpoint()` needs configurable `limit` parameter (item 9)
- `c4-recover.js` may be absorbed into this skill or become its lightweight entry point
- Checkpoint types may expand: `session_recovery`, `memory_sync`, `scheduled_sync`
- Activity Monitor (context usage detection) becomes a trigger source for this skill
- `createCheckpoint()` API needs to accept optional `summary` parameter

### Status: Pending design — to be detailed in a separate session
