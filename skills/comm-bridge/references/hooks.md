# C4 Hooks

Session-start hooks integrate C4 with Claude Code to provide conversation context. They do not request Memory Sync; the activity-monitor supervisor does.

## c4-session-init.js (Session Start Hook)

Runs when a Claude Code session starts. Outputs:

1. **Scope instructions** — working-memory snapshot command, handoff pointer and alert target
2. **Recent conversations** — when the unsummarized count is at or below the Sync threshold (`sync_threshold`, default 15), every unsummarized delivered conversation, provided the whole section fits the shard budget (10,000 characters and 2,200 estimated tokens). Otherwise the latest 6, packed newest-first within that budget, with a command to read the omitted middle.

There is no per-message threshold hook. Memory Sync is requested by the supervisor when the backlog exceeds the Sync threshold or its oldest conversation is older than `sync_max_interval_seconds` (default 6 hours).
