---
name: check-context
description: Accurately check current context window and token usage. Use when the user asks about context usage, token consumption, or when monitoring context levels.
---

# Check Context Skill

Accurately check your current context/token usage.

## When to Use

- When the user asks about context usage
- When the user wants to know token consumption

## How to Use

**IMPORTANT: Must use `nohup ... &` pattern!**

```bash
nohup node ~/zylos/.claude/skills/check-context/scripts/check-context.js > /dev/null 2>&1 &
```

The `/context` output will appear in your conversation after the script completes.
