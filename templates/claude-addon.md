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

This auto-installs Codex if missing, checks authentication, updates config, rebuilds instruction files, and restarts services. Memory and context are fully preserved — the switch is seamless and the new runtime picks up right where you left off.

Before running, ask the user to confirm via C4. Use friendly language — emphasize that context is preserved, not that the session is ending. Example:
> "准备切换到 Codex 运行时，记忆和上下文完整保留，切换后无缝继续。确认吗？"

Wait for the user's confirmation before running the command.

**If the command exits with code 2 (auth required)**, handle authentication via IM relay:

1. Ask the user which auth method they prefer. API key is fastest; device auth is a good fallback if the user has no API key. Example message:
   > "需要先完成 Codex 认证：
   > 1. **API Key**（推荐，最快）：发我你的 OpenAI API key (sk-...)，我来配置
   > 2. **设备认证**（没有 API Key 时）：我运行认证流程，给你一个链接，点击完成即可
   > 3. 浏览器登录
   > 选哪种？"
   - **Option 1 — API key**: user sends the key, run `zylos runtime codex --save-apikey <key>`
   - **Option 2 — Device auth**: run `codex login --device-auth` in shell, capture the URL/code, send to user via IM. After user confirms completion, retry `zylos runtime codex`.
   - **Option 3 — Browser login**: run `codex login` in shell, capture the login URL if available, send to user via IM.

Credentials are stored in both `~/.codex/auth.json` and `~/zylos/.env` to ensure auth persists across restarts.

**After the switch command completes**, send a brief transition notice — keep it short, as the new runtime will send its own ready message. Do NOT mention `zylos attach` (that is for terminal users only). Example:
> "好的，正在切换到 Codex，约 10 秒后就绪。"

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
