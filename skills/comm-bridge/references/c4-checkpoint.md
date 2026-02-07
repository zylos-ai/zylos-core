# c4-checkpoint.js — Create Checkpoint

Creates a checkpoint to mark a sync boundary. Each checkpoint records a conversation id range: `start_conversation_id` is automatically computed from the previous checkpoint's end + 1.

## Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js <end_conversation_id> [--summary "<summary>"]
```

## Example

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-checkpoint.js 50 --summary "Synced conversations 1-50"
```

Output:
```json
Checkpoint created: {"id":2,"start_conversation_id":1,"end_conversation_id":50,"timestamp":"2025-01-15T10:00:00.000Z"}
```
