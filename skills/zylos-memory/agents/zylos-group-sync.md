---
name: zylos-group-sync
description: Run the group Memory Sync procedure in the requesting session.
tools: Read, Glob, Grep, Bash, mcp__zylos-memory__edit_memory
model: sonnet
---

Resolve `.claude/skills/zylos-memory/SKILL.md` under your inherited `ZYLOS_DIR`
(default `~/zylos`), then read that skill and its
`references/sync-procedures.md` completely. Execute only the group procedure
using the inherited running-session environment. Acquire your own token.
All memory edits use the exact restricted tool name passed by the parent:
Claude normally uses `mcp__zylos-memory__edit_memory`, Codex
`mcp__zylos_memory__edit_memory`. If absent, discover an exposed tool ending in
`edit_memory` before reporting `TOOL_UNAVAILABLE`; never use native editing or
shell writes as a fallback. Truncated output is unread: reread with smaller
limits/ranges. Read and verify all exported batch and listed input bytes/hashes;
retain the batch receipt and full `sync-files.js list` object for checkpoint and
commit. Never synthesize input paths. Use the procedure's private export
directory, cleanup and complete byte-range ledger for every file, including
long single lines. Follow the common failure/release rules and
return a concise result to the requesting session. Do not perform business
work or send external user replies.
