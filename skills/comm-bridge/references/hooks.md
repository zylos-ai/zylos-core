# C4 Hooks

Session-start hooks provide C4 conversation context to the agent runtime.

## c4-session-init.js (Session Start Hook)

At session start, the hook supplies:

1. **Scope instructions** — working-memory snapshot command, handoff pointer and alert target
2. **Recent conversations** — the newest delivered messages recorded strictly after the current scope's handoff modification time, or up to six recent messages if the scope has no handoff. Within the shard budget of 10,000 characters and 2,200 estimated tokens, the hook gives newer messages priority and shows a contiguous tail in chronological order. If any messages after the handoff are omitted, the same budget includes a notice with their count and a command to retrieve the ID range for the current scope.
