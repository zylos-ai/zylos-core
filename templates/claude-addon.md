## Claude Code — Runtime-Specific Rules

The following rules apply when running on the **Claude Code** runtime.

### Tool Usage Rules

1. **NEVER use `EnterPlanMode`.** Do not enter plan mode under any circumstances. If a task needs planning, write the plan directly as a document or discuss it in conversation.

2. **NEVER use `AskUserQuestion` or interactive prompts.** Any tool that presents menus, choices, or interactive selections is forbidden. The input box must always remain in its default state, ready to receive the next message. Rationale: interactive prompts block the input pipeline and prevent heartbeat commands from being delivered, which would cause a false liveness timeout.

3. **Use background subagents for heavy workloads.** Two risks to manage: main loop blocking (heartbeat can't be delivered) and context overflow (subagent output floods the main context window).
   - **Single web call:** OK to use `WebSearch` or `WebFetch` directly in the main loop.
   - **Multiple web calls (2+):** MUST delegate to a background agent (`Task` tool with `run_in_background: true`). `WebSearch` and `WebFetch` have no timeout mechanism and can hang indefinitely, blocking heartbeat delivery.
   - **Research tasks (expected many searches or tool calls):** MUST use a background agent. A non-background Task subagent returns its full output into the parent context — dozens of web search results can overflow the context window and crash the session.

### Runtime Switching

When the user asks to switch to the Codex runtime, run:

```bash
zylos runtime codex
```

This auto-installs Codex if missing, checks authentication, updates config, rebuilds instruction files, and restarts services. Your Claude Code session will be terminated and Codex will start.

**If the command exits with code 2 (auth required)**, handle authentication via IM relay:

1. Ask the user which auth method they prefer:
   - **API key** (`sk-...`): ask user to send it, then run `zylos runtime codex --save-apikey <key>`
   - **Device auth** (headless, no browser): run `codex login --device-auth` in shell, capture the device URL/code from its output, send it to the user via IM. After the user confirms completion, retry `zylos runtime codex`.
   - **Browser login**: run `codex login` in shell, capture the login URL if available, send to user via IM.

Credentials are stored in both `~/.codex/auth.json` and `~/zylos/.env` to ensure auth persists across restarts.

### Heartbeat

When you receive a control message with content `Heartbeat check`, acknowledge it immediately:
```bash
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-control.js ack --id <id>
```
The `ack via:` path is included in the message.

### Memory Sync

When Memory Sync is triggered, launch a background subagent using the **Task tool** (`subagent_type: general-purpose`, `model: sonnet`, `run_in_background: true`). The subagent's prompt must instruct it to follow the full sync flow in `~/zylos/.claude/skills/zylos-memory/SKILL.md`. Do NOT use the Skill tool for this — it does not support background execution. Continue your main work without waiting.

### Available Skills

Skills are located in `~/zylos/.claude/skills/`. Claude auto-discovers skill descriptions; below are only supplementary notes.

| Skill | Component | Notes |
|-------|-----------|-------|
| activity-monitor | C2 | PM2 service, not directly invoked |
| create-skill | | `/create-skill <name>` to scaffold |
| zylos-memory | C3 | **Must run via Task tool** (`subagent_type: general-purpose`, `model: sonnet`, `run_in_background: true`) — never use the Skill tool for this. See SKILL.md for sync flow. |
| comm-bridge | C4 | |
| scheduler | C5 | CLI: `cli.js add\|update\|done\|pause\|resume\|remove\|list\|next\|running\|history`. See SKILL.md references/ for options and examples |
| web-console | C4 channel | |
| http | C6 | |
| component-management | | **Read SKILL.md before any install/upgrade/uninstall** |
