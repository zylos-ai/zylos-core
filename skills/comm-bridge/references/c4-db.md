# c4-db.js — Database Module

Core database module for C4. Provides both a programmatic API (imported by other C4 scripts) and a standalone CLI for querying conversations and checkpoints.

## CLI Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-db.js <command> [args]
```

## Commands

### init

Initialize the database (creates tables if not present).

```bash
c4-db.js init
```

### recent

Get recent conversations (default: 20).

```bash
c4-db.js recent [limit]
```

**Output:** JSON array of conversation records, most recent first.

```json
[
  {
    "id": 3126,
    "timestamp": "2026-02-23 04:04:26",
    "direction": "in",
    "channel": "telegram",
    "endpoint_id": "1234567890",
    "content": "[TG DM] alice said: hello",
    "status": "delivered",
    "priority": 3,
    "require_idle": 0,
    "retry_count": 0
  }
]
```

### unsummarized

Show the range and count of conversations not yet covered by a checkpoint.

```bash
c4-db.js unsummarized
```

**Output:**

```json
{
  "begin_id": 3032,
  "end_id": 3125,
  "count": 94
}
```

### checkpoint

Create a checkpoint up to a given conversation id.

```bash
c4-db.js checkpoint <end_conversation_id> [summary]
```

### checkpoints

List all checkpoints in reverse chronological order.

```bash
c4-db.js checkpoints
```

### insert

Insert a conversation record (used by other scripts; rarely needed directly).

```bash
c4-db.js insert <direction> <channel> <endpoint_id> <content>
```

## Programmatic API

When imported by other C4 scripts, `c4-db.js` exports:

| Function | Purpose |
|----------|---------|
| `getDb()` | Get/initialize SQLite connection (WAL mode) |
| `insertConversation()` | Queue a new message |
| `getNextPending()` | Get highest-priority pending incoming message |
| `claimConversation(id)` | Atomically claim a pending message for delivery |
| `markDelivered(id)` | Mark a message as delivered |
| `getRecentConversations(limit)` | Get recent conversations |
| `getUnsummarizedRange()` | Get range/count of unsummarized conversations |
| `getConversationsByRange(begin, end)` | Fetch conversations by id range |
| `createCheckpoint(endId, summary)` | Create a sync checkpoint |
| `getLastCheckpoint()` | Get the most recent checkpoint |
| `formatConversations(records)` | Format records into readable text |
| `insertControl()` | Queue a control message |
| `getNextPendingControl()` | Get next pending control item |
| `claimControl(id)` | Claim a control item for processing |
| `ackControl(id)` | Mark a control item as done |
| `close()` | Close database connection |
