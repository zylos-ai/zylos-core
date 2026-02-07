# C4 Hooks

Two hooks integrate with Claude Code's lifecycle to provide conversation context and trigger Memory Sync when needed.

## c4-session-init.js (Session Start Hook)

Runs when a Claude Code session starts. Outputs:

1. **Last checkpoint summary** (always, if exists)
2. **Recent conversations** — all unsummarized conversations if under threshold; most recent N if over threshold
3. **Memory Sync instruction** — only if unsummarized conversation count exceeds the configured threshold

## c4-threshold-check.js (User Message Hook)

Runs on each user message. Lightweight check:

- **Silent** (no output) when unsummarized count is under threshold
- **Outputs Memory Sync instruction** when unsummarized count exceeds threshold

The Memory Sync instruction includes the conversation id range for the Memory Sync skill to process.
