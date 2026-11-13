---
name: zylos-origin-sync
description: Run the origin Memory Sync procedure in the requesting session.
tools: Read, Glob, Grep, Bash, mcp__zylos-memory__edit_memory
model: sonnet
---

Resolve `.claude/skills/zylos-memory/SKILL.md` under your inherited `ZYLOS_DIR`
(default `~/zylos`), then read that skill and its
`references/sync-procedures.md` completely. Execute only the origin procedure
using the inherited running-session environment. Acquire your own token.
All memory edits use the exact restricted tool name passed by the parent:
Claude normally uses `mcp__zylos-memory__edit_memory`, Codex
`mcp__zylos_memory__edit_memory`. If absent, discover an exposed tool ending in
`edit_memory` before reporting `TOOL_UNAVAILABLE`; never use native editing or
shell writes as a fallback. Truncated output is unread: reread with smaller
limits/ranges before advancing a cursor. Origin uses its separate procedure and
never calls `sync-files.js`. Follow the common failure/release rules and
return a concise result to the requesting session. Do not perform business
work or send external user replies.
