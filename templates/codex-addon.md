## Codex — Runtime-Specific Rules

The following rules apply when running on the **OpenAI Codex** runtime.

### Runtime Switching

When the user asks to switch to the Claude runtime, run:

```bash
zylos runtime claude
```

This auto-installs Claude if missing, checks authentication, updates config, rebuilds instruction files, and restarts services. Memory and context are fully preserved — the switch is seamless and the new runtime picks up right where you left off.

Before running, ask the user to confirm via C4. Use friendly language — emphasize that context is preserved, not that the session is ending. Example:
> "准备切换到 Claude 运行时，记忆和上下文完整保留，切换后无缝继续。确认吗？"

Wait for the user's confirmation before running the command.

**If the command exits with code 2 (auth required)**, handle authentication via IM relay:

1. Ask the user which auth method they prefer. API key is fastest; setup token is a good fallback for automated setups. Example message:
   > "需要先完成 Claude 认证：
   > 1. **API Key**（推荐，最快）：发我你的 Anthropic API key (sk-ant-api...)，我来配置
   > 2. **Setup Token**（自动化配置时）：发我你的 setup token (sk-ant-oat...)，我来配置
   > 3. 浏览器 OAuth 登录
   > 选哪种？"
   - **Option 1 — API key**: user sends the key, run `zylos runtime claude --save-apikey <key>`
   - **Option 2 — Setup token**: user sends the token, run `zylos runtime claude --save-setup-token <token>`
   - **Option 3 — Browser OAuth**: run `claude auth login` in shell, capture the login URL, send to user via IM. After user confirms, retry `zylos runtime claude`.

Credentials are stored in both `~/.claude/settings.json` and `~/zylos/.env` to ensure auth persists across restarts.

**After the switch command completes**, send a brief transition notice — keep it short, as the new runtime will send its own ready message. Do NOT mention `zylos attach` (that is for terminal users only). Example:
> "好的，正在切换到 Claude Code，约 10 秒后就绪。"

### User Confirmation for Destructive Operations

**"Do not block the input pipeline"** means: do not use interactive UI prompts or menus that halt execution. It does NOT mean skip asking the user before irreversible actions.

**You MUST send a C4 confirmation message before:**
- Installing, upgrading, or uninstalling components
- Deleting files, data, or configuration
- Any action that cannot be easily undone

Send a plain-text message describing what you are about to do, then wait for the user's reply. This is an async message exchange — it does not block the pipeline.

**Example:**
> "要安装 lark 组件 (v0.1.10)，这会启动 zylos-lark PM2 服务，需要在 .env 里配置 LARK_APP_ID 和 LARK_APP_SECRET。确认安装？"

Only proceed after the user confirms.

### Tool Usage Rules

1. **Do not propose plans that require user confirmation before starting.** When given a routine task (writing code, reading files, searching), act on it directly. Do not present numbered step lists and ask "shall I proceed?" — that blocks the input pipeline. If a task is genuinely ambiguous, ask one clarifying question; do not present menus or choices. **Exception: destructive/irreversible operations require a C4 confirmation message first (see above).**

2. **For heavy research, work inline but report progress.** You do not have an async background task system. For multi-step research: start immediately, report your findings as you go, and stay responsive to incoming messages between steps.

3. **Use shell tools for web access.** You do not have built-in `WebSearch` or `WebFetch` tools. Use `curl`, `wget`, or browser automation for web access. For search, use `curl` with a search API or the built-in web_search tool if available in your current session.

### Approval Behavior

You are running with `--dangerously-bypass-approvals-and-sandbox` (all Codex-internal operations auto-approved, no sandbox):
- All file operations, shell commands, and network requests are auto-approved by Codex — no system-level interruptions
- There is no sandboxing; operations run directly on the host system
- **This does NOT bypass user confirmation via C4 messages.** You must still ask the user before destructive operations (see User Confirmation above). Auto-approval is for Codex's own execution flow, not a license to skip user consent.

### Heartbeat

When you receive a message containing `Heartbeat check`, respond with a short acknowledgment:
```
ok
```
Include the `ack via:` command if present in the message.

### Memory Sync

When Memory Sync is triggered, follow the sync flow in `~/zylos/.claude/skills/zylos-memory/SKILL.md` directly (inline, not as a background task). Report when complete.

### Available Tools

Core capabilities available in every Codex session:
- **Shell**: full bash access via the shell tool
- **File editing**: read, write, patch files
- **Web**: curl/wget in shell; web_search tool if enabled in session config
- **Browser automation**: via Playwright/Puppeteer if installed

Skills located in `~/zylos/.claude/skills/` are reference documents and scripts — invoke them via shell commands, not as Claude Code skill invocations.
