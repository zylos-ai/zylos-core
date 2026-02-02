---
name: memory
description: Persistent memory system for cross-session context. Core C3 component.
---

# Memory System (C3)

Maintains persistent memory across sessions via markdown files.

## Memory Files

Located at `~/zylos/memory/`:

| File | Purpose |
|------|---------|
| `context.md` | Current work focus, active tasks |
| `decisions.md` | Key decisions made |
| `projects.md` | Active and planned projects |
| `preferences.md` | User preferences |

## When to Use

**Read memory** at session start to restore context.

**Update memory** proactively:
- After completing significant tasks
- When switching topics
- During natural pauses
- Before context compaction
- When idle

## Best Practices

1. **Don't wait** for context to fill up - save early, save often
2. **Be concise** - memory files are read every session
3. **Use timestamps** - helps track freshness
4. **Commit regularly** - memory/ is git-tracked

## Commands

```bash
# Read all memory
cat ~/zylos/memory/*.md

# Quick status check
head -20 ~/zylos/memory/context.md
```

## Integration with C2

Activity Monitor sends recovery prompt that instructs Claude to read memory files after crash recovery.
