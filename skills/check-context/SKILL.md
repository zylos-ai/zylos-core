---
name: check-context
description: Use when the user asks about current context or token usage.
---

# Check Context Skill

Accurately check your current context/token usage.

## When to Use

- When the user asks about context usage
- When the user wants to know token consumption

## How to Use

**IMPORTANT: Must use `nohup ... &` pattern!**

```bash
nohup node ~/.claude/skills/check-context/check-context.js > /dev/null 2>&1 &
```

The `/context` output will appear in your conversation after the script completes.
