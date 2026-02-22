---
name: check-context
description: Accurately check current context window and token usage. Use when the user asks about context usage, token consumption, or when monitoring context levels.
---

# Check Context Skill

Check current context/token usage by reading the statusLine data file.

## When to Use

- When the user asks about context usage
- When the user wants to know token consumption

## How to Use

Read the statusLine data file:

```bash
cat ~/zylos/activity-monitor/statusline.json
```

This file is updated by `context-monitor.js` after every turn via Claude Code's statusLine feature — it's always current.

## What to Report

From the JSON, report:
- **Context usage**: `context_window.used_percentage`% used, `context_window.remaining_percentage`% remaining
- **Tokens**: `context_window.total_input_tokens` input, `context_window.total_output_tokens` output (window size: `context_window.context_window_size`)
- **Session cost**: `cost.total_cost_usd`
- **Model**: `model.display_name`
