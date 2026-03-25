---
name: new-session
description: Start a fresh session with a graceful handoff when context is high. Claude uses /clear; Codex uses /exit + activity-monitor relaunch. Use when context is high or when a clean session is needed.
---

# New Session Skill

Start a fresh session with a graceful handoff so work continuity is preserved.

## When to Use

- Context usage exceeds the runtime threshold (auto-triggered by context monitoring)
- User explicitly asks for a new session or context reset
- When you need a clean context but do not need full component/service restart

## Pre-Switch Checklist

Before switching sessions, complete these steps in order:

### 1. Inventory running background tasks

If your runtime supports background task APIs, list active background tasks and record:
- Agent ID
- What it is doing
- Output path for follow-up

Do not stop tasks unless explicitly requested.

### 2. Sync memory

Run the `zylos-memory` sync flow so the next session starts with up-to-date memory/checkpoint context.

### 3. Write a session handoff summary

Write a brief message covering:
- What was being worked on
- Current state (done, pending, blockers)
- Running background tasks (if any)
- What the next session should pick up first

### 4. Send the handoff summary

Determine who to notify:
- If actively collaborating with a user: send the summary to that user's channel via C4
- If no active user conversation: send to the web-console channel

This both informs the user and persists context in C4 history for startup injection.

### 5. Trigger session switch (runtime-specific)

Claude runtime:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/clear" --priority 1 --require-idle
```

Codex runtime:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js enqueue --content "/exit" --priority 1 --require-idle
```

## How It Works

1. Build and send a handoff summary to C4.
2. Enqueue a runtime-specific switch command with `--require-idle`.
3. Claude path: `/clear` resets context in-process.
4. Codex path: `/exit` ends the process; activity-monitor relaunches `codex-main`.
5. New session runs startup injection hooks/instructions and resumes from C4 + memory context.
