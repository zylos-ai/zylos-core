# C4 Hooks

Session-start hooks integrate C4 with Claude Code to provide conversation context and trigger Memory Sync when needed.

## c4-session-init.js (Session Start Hook)

Runs when a Claude Code session starts. Outputs:

1. **Last checkpoint summary** (always, if exists)
2. **Recent conversations** — all unsummarized conversations if under threshold; most recent N if over threshold
3. **Memory Sync instruction** — only if unsummarized conversation count exceeds the configured threshold; instructs Claude to invoke `/zylos-memory`

There is no per-message threshold hook in v5. Additional Memory Sync triggering comes from scheduled context checks, not user-message hooks.
