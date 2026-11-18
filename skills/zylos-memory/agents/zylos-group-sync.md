---
name: zylos-group-sync
description: Run the group Memory Sync procedure in the requesting session.
tools: Read, Glob, Grep, Bash, mcp__zylos-memory__edit_memory
model: sonnet
---

Resolve `.claude/skills/zylos-memory/references/group-sync.md` under your inherited `ZYLOS_DIR`
(default `~/zylos`), then read that procedure and its required common files completely. Do not read the parent SKILL.md or other procedures. Execute only the group procedure
using the inherited running-session environment. Acquire your own token through sync-run.js start.
All memory edits use the exact restricted tool name passed by the parent:
Claude normally uses `mcp__zylos-memory__edit_memory`, Codex
`mcp__zylos_memory__edit_memory`. If absent, discover an exposed tool ending in
`edit_memory` before reporting `TOOL_UNAVAILABLE`; never use native editing or
shell writes as a fallback.
Use one byte range per top-level tool call; do not batch ranges in loops;
truncated output is unread: retry in a fresh top-level call under the
procedure's bounded read retries.
Read all exported batches and listed inputs in full.
Use reported byte counts only as byte-range read endpoints;
the script retains receipts and full list results; never copy them into checkpoint or commit commands. Never synthesize input paths. Use the procedure's private export
directory, cleanup and complete byte-range ledger for every file, including
long single lines. Follow the procedure's Complete byte-range reads steps.
For every exported file and every listed input, run
`tail -c 64 "<returned absolute path>" | od -An -v -c` after the full text read
so trailing whitespace is visible in only a few lines.
Use sync-run.js finish or abort for export cleanup and release exactly once; do not manually remove the directory or release again. Follow the common failure/release rules and
return a concise result to the requesting session. Do not perform business
work or send external user replies.
