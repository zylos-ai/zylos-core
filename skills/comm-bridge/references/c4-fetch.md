# c4-fetch.js — Fetch Conversations

Retrieves the last checkpoint summary and conversations within a specified id range. Used by Memory Sync to load conversation data for summarization.

## Usage

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --begin <id> --end <id>
```

## Output

Outputs to stdout:
1. Last checkpoint summary (if exists)
2. Formatted conversations in the specified range (chronological order)

## Example

```bash
~/zylos/.claude/skills/comm-bridge/scripts/c4-fetch.js --begin 10 --end 50
```

Output:
```
[Last Checkpoint Summary] Synced conversations 1-9
[Conversations] (id 10 ~ 50)
[2025-01-15 10:00:00] IN (telegram:8101553026):
hello

[2025-01-15 10:01:00] OUT (telegram:8101553026):
Hi there!
```
