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

After running this command:
1. Wait ~10 seconds
2. You will receive `/context` output showing real token usage
3. Report the usage to the user

## Why This Pattern

The `/context` command output is only captured when you are in **idle state**. By running the script with `nohup ... &`:
1. It detaches and runs in background
2. You return to idle immediately
3. Script waits, then sends `/context`
4. Output appears in your conversation
