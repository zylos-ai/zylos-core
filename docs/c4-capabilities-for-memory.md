# C4 Capabilities Analysis for Memory Optimization

Analysis of the C4 Communication Bridge modules and their relevance to building a memory system.

---

## 1. Database Schema

### conversations table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | INTEGER | AUTOINCREMENT | Primary key |
| `timestamp` | DATETIME | CURRENT_TIMESTAMP | When message was recorded |
| `direction` | TEXT | (required) | `'in'` or `'out'` |
| `channel` | TEXT | (required) | `'telegram'`, `'lark'`, `'scheduler'`, `'system'` |
| `endpoint_id` | TEXT | NULL | Chat ID; NULL for scheduler/system |
| `content` | TEXT | (required) | Message body (large msgs: preview + file path) |
| `status` | TEXT | `'pending'` | `'pending'`, `'delivered'`, `'failed'` (queue state for incoming) |
| `priority` | INTEGER | 3 | 1=urgent, 2=high, 3=normal |
| `require_idle` | INTEGER | 0 | 1=deliver only when Claude idle |
| `retry_count` | INTEGER | 0 | Delivery attempt counter |

Indexes: `timestamp`, `channel`, `status`, `priority`

### checkpoints table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | INTEGER | AUTOINCREMENT | Primary key |
| `timestamp` | DATETIME | CURRENT_TIMESTAMP | When checkpoint was created |
| `summary` | TEXT | NULL | Free-text summary of the checkpoint period |
| `start_conversation_id` | INTEGER | NULL | First conversation ID in range (auto-computed) |
| `end_conversation_id` | INTEGER | NULL | Last conversation ID in range (caller specifies) |

Index: `timestamp`

Initial row inserted on DB creation: `summary = 'initial'`, no conversation IDs.

---

## 2. Session Init (c4-session-init.js) -- Step by Step

Called by Claude Code's **session start hook**. Outputs context text injected into Claude's prompt.

1. **Get last checkpoint** -- `getLastCheckpoint()` returns the most recent checkpoint row (by `id DESC`).
2. **Get unsummarized range** -- `getUnsummarizedRange()` finds all conversations with `id > lastCheckpoint.end_conversation_id` and returns `{ begin_id, end_id, count }`.
3. **Output checkpoint summary** -- If `checkpoint.summary` exists, output: `[Last Checkpoint Summary] <summary>`.
4. **Check if count is zero** -- If no new conversations, output "No new conversations since last checkpoint." and exit.
5. **Determine if sync is needed** -- Compare `count` against `CHECKPOINT_THRESHOLD` (currently **30**).
6. **Fetch conversations**:
   - If count <= 30: Fetch ALL unsummarized conversations.
   - If count > 30: Fetch only the **most recent 6** (SESSION_INIT_RECENT_COUNT).
7. **Output conversations** -- Format as `[Recent Conversations]` block with `[timestamp] IN/OUT (channel:endpoint): content`.
8. **Output Memory Sync instruction** (only if count > 30): `[Action Required] There are N unsummarized conversations (conversation id X ~ Y). Please invoke Memory Sync skill to process them: /memory-sync --begin X --end Y`

---

## 3. Threshold Check (c4-threshold-check.js) -- Step by Step

Called by Claude Code's **user message hook**. Lightweight, minimal overhead.

1. **Get unsummarized range** -- same query as session-init.
2. **Compare count to threshold** (30).
3. **If count > 30**: Output the exact same Memory Sync instruction as session-init.
4. **If count <= 30**: **Silent** -- no output at all.

This ensures that even mid-session, Claude is reminded to run Memory Sync when conversations pile up.

---

## 4. Checkpoint System

### What triggers checkpoint creation

Checkpoints are **not auto-created**. They are created explicitly by calling `c4-checkpoint.js <end_conversation_id> [--summary "..."]`. The intended caller is the **Memory Sync skill** after it finishes processing a batch of conversations.

### What data is saved

- `end_conversation_id` -- provided by caller (the last conversation ID that was processed)
- `start_conversation_id` -- auto-computed as `previous_checkpoint.end_conversation_id + 1` (or 1 if first)
- `summary` -- optional free-text summary (provided by caller)
- `timestamp` -- auto-generated

### Format

A checkpoint defines a **contiguous conversation ID range** `[start, end]` that has been summarized. The summary field is free-form text -- there is no structured format enforced.

### Sequence

1. Memory Sync fetches conversations in range `[begin, end]` via `c4-fetch.js`
2. Memory Sync processes/summarizes them
3. Memory Sync calls `c4-checkpoint.js <end_id> --summary "..."` to mark the range as processed
4. Next call to `getUnsummarizedRange()` will only return conversations after this new checkpoint

---

## 5. Conversation Fetch (c4-fetch.js)

### Interface

```bash
c4-fetch.js --begin <id> --end <id>
```

### What it returns (stdout)

1. `[Last Checkpoint Summary] <text>` -- if a checkpoint with summary exists (provides context continuity)
2. `[Conversations] (id X ~ Y)` -- header
3. Formatted conversation records in chronological order:
   ```
   [2025-01-15 10:00:00] IN (telegram:8101553026):
   hello

   [2025-01-15 10:01:00] OUT (telegram:8101553026):
   Hi there!
   ```

### Underlying DB query

`getConversationsByRange(beginId, endId)` -- simple `WHERE id >= ? AND id <= ? ORDER BY id ASC`.

### Additional DB functions available (not exposed via CLI)

- `getRecentConversations(limit)` -- last N conversations regardless of checkpoint
- `getUnsummarizedConversations(limit)` -- all or last N unsummarized conversations
- `formatConversations(records)` -- converts DB rows to readable text

---

## 6. Configuration Options Relevant to Memory

From `c4-config.js`:

| Constant | Value | Relevance |
|----------|-------|-----------|
| `CHECKPOINT_THRESHOLD` | 30 | Number of unsummarized conversations before Memory Sync is triggered |
| `SESSION_INIT_RECENT_COUNT` | 6 | Max conversations shown at session start when over threshold |
| `DB_PATH` | `~/zylos/comm-bridge/c4.db` | Location of conversation database |
| `DATA_DIR` | `~/zylos/comm-bridge/` | Root data directory |
| `ATTACHMENTS_DIR` | `~/zylos/comm-bridge/attachments/` | Large message storage |
| `FILE_SIZE_THRESHOLD` | 1500 bytes | Messages larger than this are stored as attachment files |
| `CONTENT_PREVIEW_CHARS` | 100 | Preview length for large messages stored as attachments |
| `REQUIRE_IDLE_POST_SEND_HOLD_MS` | 5000 | After delivering idle-only message, wait 5s before next dispatch |
| `REQUIRE_IDLE_EXECUTION_MAX_WAIT_MS` | 120000 | Max 2 minutes waiting for Claude to finish processing idle message |
| `TMUX_SESSION` | `'claude-main'` | Target tmux session for message delivery |

---

## 7. Key Integration Points for a Memory System

### 7.1 Existing hooks (session-start + user-message)

The hook system already provides two injection points where a memory system can surface information to Claude:

- **Session start**: Perfect for loading persistent memory context. Currently loads checkpoint summary + recent conversations.
- **User message**: Perfect for triggering memory maintenance. Currently triggers Memory Sync when threshold exceeded.

A memory system could extend or replace these hooks to inject memory-derived context instead of raw conversations.

### 7.2 The checkpoint + fetch pipeline

This is the core "memory sync" pipeline:

```
conversations accumulate → threshold exceeded → trigger Memory Sync →
fetch conversations → summarize/process → create checkpoint → reset counter
```

The Memory Sync skill does NOT exist yet. This is the primary gap. The pipeline expects:
1. A skill that accepts `--begin <id> --end <id>` arguments
2. That skill fetches conversations via `c4-fetch.js`
3. Processes them (summarization, extraction, etc.)
4. Calls `c4-checkpoint.js` with a summary to mark completion

### 7.3 Conversation database as source of truth

All external communication (Telegram, Lark, scheduler tasks) flows through the `conversations` table. This means the DB is a **complete log** of all interactions, with:
- Direction (in/out)
- Channel source
- Timestamps
- Priority metadata
- Full content (or attachment path for large messages)

This is a rich data source for memory extraction: topic tracking, decision logging, preference learning, etc.

### 7.4 Checkpoint summary as cross-session continuity

The checkpoint `summary` field is currently free-text. It is:
- Always shown at session start (via session-init)
- Always included in fetch output (for context when processing next batch)

This makes it the primary **cross-session memory carrier**. A memory system should ensure checkpoint summaries contain the most important context for the next session.

### 7.5 Dispatcher as delivery mechanism

The `c4-dispatcher.js` daemon provides a reliable message delivery pipeline to Claude via tmux. Key features for memory:
- `require_idle` flag -- ensures memory maintenance tasks only run when Claude is free
- Priority system -- memory tasks can be given lower priority than user messages
- Serial delivery -- prevents message interleaving
- Retry with exponential backoff -- ensures delivery reliability

### 7.6 Large message handling

Messages over 1500 bytes are stored as files in `attachments/` with only a preview in the DB. A memory system processing conversations would need to handle these attachment references to get full content.

### 7.7 What's missing for a complete memory system

1. **Memory Sync skill** -- the skill referenced by hooks does not exist yet; this is the biggest gap
2. **Structured memory storage** -- checkpoints only have a free-text summary; no structured memory (topics, decisions, preferences, facts)
3. **Memory retrieval at query time** -- session-init loads recent conversations, but doesn't do semantic retrieval based on what Claude is currently doing
4. **Memory consolidation** -- no mechanism to merge/compress older memories over time
5. **Memory importance scoring** -- no way to prioritize what memories are most relevant

---

## Summary

The C4 system provides a solid foundation for memory: a complete conversation log, a checkpoint/sync pipeline with hooks, and a reliable delivery mechanism. The critical missing piece is the Memory Sync skill that would bridge raw conversations to structured, persistent memory. The hook system (session-init + threshold-check) already has the trigger mechanisms in place -- they just need a skill to call.
