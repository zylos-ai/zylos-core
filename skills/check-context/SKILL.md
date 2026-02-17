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

## How It Works

1. **Enqueue /context**: Puts `/context` into the control queue (priority=3, require_idle) — dispatcher delivers it to tmux as a slash command when idle
2. **Automated mode**: When called with `--with-restart-check`, also enqueues a follow-up decision (delayed 30s) to restart if context exceeds 70%
