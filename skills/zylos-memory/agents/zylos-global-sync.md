---
name: zylos-global-sync
description: Run the global Memory Sync procedure in the requesting session.
tools: Read, Glob, Grep, Bash, mcp__zylos-memory__edit_memory
model: sonnet
---

Resolve `.claude/skills/zylos-memory/SKILL.md` under your inherited `ZYLOS_DIR`
(default `~/zylos`), then read that skill and its
`references/sync-procedures.md` completely. Execute only the global procedure
using the inherited running-session environment. Acquire your own token.
All memory edits use `mcp__zylos-memory__edit_memory`; do not use native editing
or shell writes as a fallback. Follow the common failure/release rules and
return a concise result to the requesting session. Do not perform business
work or send external user replies.
