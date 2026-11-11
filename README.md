<div align="center">

<img src="./assets/logo.png" alt="Zylos" height="120">

# Zylos

> **Zylos** (/ˈzaɪ.lɒs/ 赛洛丝) — Give your AI a life

### Give your AI a life.


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/GS2J39EGff)
[![X](https://img.shields.io/badge/X-follow-000000?logo=x&logoColor=white)](https://x.com/ZylosAI)
[![Website](https://img.shields.io/badge/website-zylos.ai-blue)](https://zylos.ai)
[![Built by OpenMax](https://img.shields.io/badge/Built%20by-OpenMax-orange)](https://openmax.com)

[中文](./README.zh-CN.md)

</div>

---

LLMs are geniuses — but they wake up with amnesia every session. No memory of yesterday, no way to reach you, no ability to act on their own.

Zylos gives it a life. Memory that survives restarts. A scheduler that works while you sleep. Communication through Telegram, Lark, or Dashboard conversations. Self-maintenance that keeps everything running. And because it can program, it can evolve — building new skills, integrating new services, growing alongside you.

Supports Claude Code (Anthropic) and Codex (OpenAI). Fully compatible with the [OpenClaw](https://github.com/openclaw/openclaw) ecosystem.

---

## Quick Start

**Prerequisites:** A Linux server (or Mac) with tmux 3.2a or later (the installer installs tmux if it is missing), a [Claude](https://claude.ai) subscription (or [OpenAI Codex](https://github.com/openai/codex) as an alternative runtime — Codex CLI v0.129.0+ required, 0.146+ recommended).

Zylos-managed Codex sessions use `--no-daemon` when the installed CLI advertises it, isolating startup from shared background-server settings. Older CLIs without this option keep their existing launch behavior. This does not change the shared daemon or your standalone Codex configuration.


```bash
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash
```

This installs everything you need (git, tmux, Node.js, zylos CLI) and automatically runs `zylos init` to set up your agent.

<details>
<summary>Non-interactive install (Docker, CI/CD, headless servers)</summary>

All `zylos init` flags can be passed directly through the install script. The script installs dependencies, then runs `zylos init` with the flags you provide.

**Full example:**

```bash
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash -s -- \
  -y \
  --setup-token sk-ant-oat01-xxx \
  --timezone Asia/Shanghai \
  --domain agent.example.com \
  --https \
  --caddy \
  --web-password MySecurePass123
```

**When is non-interactive mode active?**

Automatically when no TTY is available — e.g. Docker containers (without `-it`), CI runners, or cron jobs. Also when `CI=true` or `NONINTERACTIVE=1` is set. Note: `curl | bash` in a terminal is still interactive (the install script redirects from `/dev/tty`). Use `-y` to force non-interactive in a terminal.

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `-y`, `--yes` | Force non-interactive mode (skip all prompts) | Auto-detected |
| `-q`, `--quiet` | Minimal output | Off |
| `--runtime <name>` | AI runtime: `claude` or `codex` | `claude` |
| `--setup-token <token>` | Claude [setup token](https://code.claude.com/docs/en/authentication) (starts with `sk-ant-oat`) | — |
| `--api-key <key>` | Claude credential sent in `x-api-key`; official Anthropic keys start with `sk-ant-` | — |
| `--auth-token <token>` | Claude credential sent as `Authorization: Bearer` | — |
| `--codex-api-key <key>` | API key for Codex, including keys accepted by a compatible custom endpoint | — |
| `--base-url <url>` | Custom API base URL for Claude Code | — |
| `--codex-base-url <url>` | Custom API base URL for Codex | — |
| `--timezone <tz>` | [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `Asia/Shanghai`, `America/New_York`, `Europe/London` | System default |
| `--domain <domain>` | Domain for Caddy reverse proxy, e.g. `agent.example.com` | None |
| `--https` / `--no-https` | Enable or disable HTTPS | `--https` when domain is set |
| `--caddy` / `--no-caddy` | Install or skip Caddy web server | Install |

**Environment variables:**

Flags can also be set via environment variables during `zylos init`. Resolution order: CLI flag > env var > existing `.env` > interactive prompt.

| Environment Variable | Equivalent Flag |
|---------------------|-----------------|
| `ZYLOS_RUNTIME` | `--runtime` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `--setup-token` |
| `ANTHROPIC_API_KEY` | `--api-key` |
| `ANTHROPIC_AUTH_TOKEN` | `--auth-token` |
| `ANTHROPIC_BASE_URL` | `--base-url` |
| `OPENAI_API_KEY` | `--codex-api-key` |
| `OPENAI_BASE_URL` | `--codex-base-url` |
| `ZYLOS_DOMAIN` | `--domain` |
| `ZYLOS_PROTOCOL` (`https` or `http`) | `--https` / `--no-https` |

**Custom API endpoints:**

Choose the Claude credential type required by your provider: `--api-key` writes
`ANTHROPIC_API_KEY` and uses `x-api-key`; `--auth-token` writes
`ANTHROPIC_AUTH_TOKEN` and uses `Authorization: Bearer`. These options and
`--setup-token` are mutually exclusive. Only an explicit `--api-key` or
`--auth-token` flag replaces an existing Claude login. If Claude is already
authenticated, `--setup-token` retains the existing login without re-verifying
or saving the supplied token. Without an explicit API-key or Bearer flag,
credential environment variables are also ignored, even when both API-key and
Bearer variables are set. When authentication is needed, `--setup-token`
continues through the existing save-and-verify flow. Environment input keeps
its existing OAuth-token priority; without an OAuth token, setting both
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` is an error. Interactive init
asks which header to use for a custom Claude endpoint; it does not try both.
Only when an API credential will actually be verified does init look up its
base URL: CLI flag > environment > saved `~/zylos/.env` > native Claude settings
or Codex config. An unreadable or invalid selected saved address produces a
generic error before verification instead of falling back to the official
address. Existing-login and subscription/setup-token paths do not parse saved
endpoint files just to re-run init.

```bash
# Bearer-authenticated Anthropic-compatible endpoint; placeholders only.
ANTHROPIC_BASE_URL=https://relay.example.com \
ANTHROPIC_AUTH_TOKEN=... zylos init -y --runtime claude

# The x-api-key form is separate; do not set both credential variables.
ANTHROPIC_BASE_URL=https://relay.example.com \
ANTHROPIC_API_KEY=... zylos init -y --runtime claude
```

The `sk-ant-` format check remains for the `api.anthropic.com` hostname and is
not applied to other hosts. Credentials are saved in Claude's
`~/.claude/settings.json` environment and `~/zylos/.env`; switching credential
types removes the other Claude credential variables from both stores and the
current process. Subscription login remains available through the existing
setup-token and OAuth paths. Prefer environment variables on shared machines,
because credential flags are visible in process listings.
If credential or base-URL persistence fails, init stops with an error before
starting services; native settings may already have changed. A credential
that contains non-printable or non-ASCII characters, or cannot be represented
losslessly in `.env`, fails generically before any credential store is changed.
The shared writers also make `zylos runtime claude --save-apikey` and
`--save-setup-token` remove competing Claude credential variables.
`zylos runtime ... --save-base-url` now rejects addresses containing userinfo,
query strings, or fragments, as init does.

Verification sends one request to the selected address with the selected
header, without following redirects or probing another address. Claude appends
`/v1/messages` to its base URL, matching the runtime SDK: supply a root or path
prefix such as `https://relay.example.com/anthropic`, without a trailing `/v1`
unless your provider requires it. Codex appends `/models` to its base URL; its
default is `https://api.openai.com/v1`, and a compatible custom base commonly
ends in `/v1`. Codex keeps its API key in `~/.codex/auth.json` under
`OPENAI_API_KEY` and uses Bearer authentication.
When initializing Claude, an explicit `--codex-base-url` still updates only the
Codex endpoint; an ambient `OPENAI_API_KEY` does not suppress this update or
cause Codex authentication.

A 2xx response verifies the credential; 401 or 403 rejects it. The official
Anthropic origin (`https://api.anthropic.com`) also treats a 400 response to the
empty validation request as verified. Other HTTP responses, network failures, and timeouts are
inconclusive: init warns and saves the supplied credential so the runtime can
report the actual endpoint behavior. In particular, a custom endpoint's 400
response is not treated as proof of valid authentication.

CI, Kubernetes, and shared E2E environments should also provide `GITHUB_TOKEN`
so `zylos add` and `zylos upgrade` use GitHub's authenticated API quota instead
of the shared unauthenticated quota. See the
[GitHub authentication operations guide](docs/github-authentication.md) for
configuration examples and fallback behavior.

**Exit codes:** `0` = success, `1` = fatal error (e.g. invalid token), `2` = partial success (e.g. Caddy download failed but everything else succeeded).

</details>

<details>
<summary>Install without running init</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash -s -- --no-init
```

Installs dependencies and the zylos CLI, but skips `zylos init`. Run `zylos init` separately when ready.

</details>

<details>
<summary>Install from a specific branch (for testing)</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash -s -- --branch <branch-name>
```

</details>

<details>
<summary>Manual install (if you already have Node.js >= 20)</summary>

Choose the latest stable release from [Releases](https://github.com/zylos-ai/zylos-core/releases),
excluding releases marked **Pre-release**. Replace `vX.Y.Z` below with that release's tag.

```bash
npm install -g --install-links 'https://github.com/zylos-ai/zylos-core#vX.Y.Z'
zylos init
```

</details>

### Upgrading an existing installation

Use `zylos upgrade --self` for normal upgrades; do not upgrade an initialized
machine with `npm install -g` directly. Direct npm installation updates the
package but does not finish service, dependency or data initialization. If you
already installed this way, run `zylos init` to finish setup, then check:

```bash
zylos status
sqlite3 -readonly "${ZYLOS_DIR:-$HOME/zylos}/scheduler/scheduler.db" 'PRAGMA user_version;'
```

For 1.0, status must show all four core services online: `scheduler`,
`c4-dispatcher`, `activity-monitor`, and `zylos-dashboard`
(`caddy` is optional). The SQLite command must print `2`. Open the Dashboard
URL printed by init and confirm the login page loads. For the default local
Dashboard port, `curl --fail --location http://127.0.0.1:3470/` checks that page; use the
configured port if different. SQLite CLI must be installed for the database
check. A notice alone does not complete this setup.

The notice uses stdout when it is a terminal; otherwise it tries `/dev/tty`
so interactive npm installs can show it even when npm captures hook output.
If no terminal is available (including platforms without `/dev/tty`), it falls
back to stdout, which npm may hide. Follow the recovery checks even if npm
displayed no notice.

<details>
<summary>Docker deployment</summary>

```bash
docker run -d --name zylos \
  -e CLAUDE_CODE_OAUTH_TOKEN=YOUR_TOKEN_HERE \
  -p 3456:3456 \
  -v zylos-data:/home/zylos/zylos \
  -v claude-config:/home/zylos/.claude \
  ghcr.io/zylos-ai/zylos-core:latest
```

Docker startup uses quiet mode and does not print the Dashboard password to logs.
After startup, run `docker exec -it zylos zylos dashboard reset-password` in your
terminal to generate and display a new Dashboard password once. This also clears
old Dashboard sessions. Non-quiet interactive init displays its initial password once.

Open `http://localhost:3470/` to access Dashboard and its Origin conversation. Set or reset the password with `docker exec -it zylos zylos dashboard reset-password`; startup logs never show it. See the [Docker Deployment Guide](docs/docker.md) for Docker Compose setup, environment variables, Synology NAS instructions, and more.

</details>

<details>
<summary>Unsupported platforms (Windows, NAS, etc.) — install via SSH</summary>

On platforms without native support, use Claude Code's SSH feature to install Zylos on a remote Linux/macOS machine:

```bash
# From your local machine (any OS that runs Claude Code)
claude --ssh user@your-linux-server
```

Once connected, Claude is running on the remote machine. Ask it to install Zylos:

```
> Install Zylos on this machine
```

Or run the installer directly in the SSH session:

```bash
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash
```

This works from Windows, ChromeOS, or any platform that can run Claude Code locally. The AI handles the setup on the remote server — no need for native platform support.

</details>

> **Node.js requirement:** Zylos requires Node.js 20 or later. We recommend installing via [nvm](https://github.com/nvm-sh/nvm) — the install script does this automatically. If you manage Node.js yourself, make sure to use a single, stable version and avoid switching versions after installation, as globally installed npm packages (including Zylos) are tied to the Node.js version that installed them.
>
> ```bash
> # Recommended: let the install script handle it, or install manually via nvm
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
> nvm install 24
> nvm alias default 24
> ```

`zylos init` is idempotent and supports both interactive and non-interactive modes. It will:
1. Install missing tools (tmux, git, PM2, Claude Code or Codex)
2. Set up authentication (Claude: browser login, API key, Bearer token, or [setup token](https://code.claude.com/docs/en/authentication); Codex: API key or device auth)
3. Create the `~/zylos/` directory with memory, skills, and services
4. Start all background services and launch your AI agent in a tmux session

**Talk to your agent:**

```bash
# Interactive CLI — the simplest way to chat
zylos shell

# Or attach to the Claude tmux session (Ctrl+B d to detach)
zylos attach

# Or add a messaging channel
zylos add telegram
zylos add lark
```

---

## Architecture

<div align="center">
<img src="./assets/posters/architecture-en.png" alt="Zylos Architecture" width="480">
</div>

```mermaid
graph TB
    subgraph Channels["📡 Communication Channels"]
        TG["Telegram"]
        LK["Lark"]
        DB["Dashboard conversations / Origin"]
    end

    subgraph Zylos["🧬 Zylos — The Life System"]
        C4["C4 Comm Bridge<br/>(unified gateway · SQLite audit)"]
        MEM["Memory<br/>(Inside Out architecture)"]
        SCH["Scheduler<br/>(autonomous task dispatch)"]
        AM["Activity Monitor<br/>(guardian · heartbeat · auto-recovery)"]
        HTTP["HTTP Layer<br/>(Caddy · file sharing · HTTPS)"]
    end

    subgraph Brain["🧠 AI Runtime — The Brain"]
        CC["Claude Code / Codex<br/>(in tmux session)"]
    end

    TG & LK & DB --> C4
    C4 <--> CC
    MEM <--> CC
    SCH --> CC
    AM --> CC
    HTTP <--> CC
```

| Component | Role | Key Tech |
|-----------|------|----------|
| C4 Comm Bridge | Unified message gateway with audit trail | SQLite, priority queue |
| Memory | Persistent identity and context across restarts | Inside Out tiered architecture |
| Scheduler | Autonomous task dispatch while you are away | Cron, NL input, idle-gating |
| Activity Monitor | Crash recovery, heartbeat, health checks | PM2, multi-layer protection |
| HTTP Layer | Web access, file sharing, component routes | Caddy, auto-HTTPS |

---

## Features

### One AI, One Consciousness

<div align="center">
<img src="./assets/posters/unified-context-en.png" alt="Unified Context" width="360">
</div>

Most agent frameworks isolate sessions per channel — your AI on Telegram doesn't know what you said on Slack. Zylos is agent-centric: your AI is one person across every channel. The C4 communication bridge routes all messages through a single gateway — one conversation, one memory, one personality. Every message persisted to SQLite and fully queryable.

### Your Context, Guaranteed

<div align="center">
<img src="./assets/posters/memory-en.png" alt="Inside Out Memory" width="360">
<img src="./assets/posters/infinite-context-en.png" alt="Infinite Context" width="360">
</div>

Other frameworks lose your AI's memory during context compaction — silently, without warning. Zylos prevents this with a two-step safeguard: when context reaches 75%, the system automatically saves all memory before compaction runs. Five-layer Inside Out memory (identity → state → references → sessions → archive) ensures the AI always knows what to keep and what to compress. Your AI never wakes up with amnesia.

### Self-Healing by Default

<div align="center">
<img src="./assets/posters/lifecycle-en.png" alt="Lifecycle Management" width="360">
</div>

No third-party monitoring tools needed. Zylos includes native crash recovery, heartbeat liveness probes, health monitoring, context window management, and automatic upgrades — all built in. Your AI detects its own problems and fixes them. It stays alive while you sleep.

### $20/month, Not $3,600

Other frameworks charge per API token. Community reports show monthly bills of $500–$3,600 for always-on agents. Zylos runs on your Claude subscription — flat rate, no per-token billing. Same AI capabilities, a fraction of the cost.

### Powered by Best-in-Class AI Runtimes

Zylos supports Claude Code (Anthropic) and Codex (OpenAI) as interchangeable AI runtimes. Start with one, switch to the other anytime with `zylos runtime codex` — your memory, skills, and channels are preserved. When AI providers ship new capabilities, your agent benefits automatically. And because both runtimes can program, your AI writes new skills, integrates services, and evolves with your needs.

#### Codex unattended permission defaults

Zylos backfills `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`
in its project `.codex/config.toml` during init, runtime setup, configuration sync,
self-upgrade, and launch. This lets Codex's own backend restart/resume load the
same defaults even when its reconnect request carries only a thread ID. Project
configuration updates use a temporary file and atomic replacement, preserving
existing file modes and symlinks. The AM
launch flag remains in place. Global permission settings for other projects are
not changed; Zylos's existing setup creates the project trust entry required for
Codex to load project configuration.

Existing project permission choices are preserved, including `default_permissions`
named profiles and workspace-write options. If those settings restrict unattended resume or require approval,
setup/upgrade/launch emits a warning rather than silently replacing them. A project
permission default overrides a lower-priority global default while inside Zylos.

Set `CODEX_BYPASS_PERMISSIONS=false` in the deployment `.env` to opt out. Explicit
launch options take precedence, then the process environment, then `.env`. On the
next setup/sync/launch, Zylos retracts only the permission defaults it inserted
whose values remain unchanged; user-edited values stay. A comment in the TOML
tracks those inserted keys. Preserve that comment: if another editor removes it,
the values are treated as user-owned and must be adjusted manually. A manual edit
to the exact same value cannot be distinguished from an unchanged generated value.

Opt-out omits the bypass launch flag and returns to the user's Codex settings; it
does not enforce a specific restricted policy. It does not reconfigure an already
running thread. Stored thread approval choices can also survive resume, so check
the effective settings when reusing an older thread. This configuration addresses
default resolution; it is not a guarantee against every TUI reconnect defect.

### Idle reclaim environment

`ZYLOS_SESSION_HOT_TTL_SECONDS` must be set uniformly in the environment used
to start the Zylos services, so Dashboard and activity-monitor both inherit it.
Setting this variable only for an individual PM2 service is unsupported:
Dashboard cannot detect another service's environment, so its displayed value
and read-only state may otherwise differ from the effective reclaim setting.
After changing the variable, restart both services from that environment, for
example `pm2 restart zylos-dashboard activity-monitor --update-env`.
`zylos restart` alone is not enough: it restarts activity-monitor with the
caller's environment but does not restart Dashboard.
This is the authoritative scope rule for this variable; the reclaim settings
reference is in [activity-monitor](skills/activity-monitor/SKILL.md#multi-session-reclaim-configuration).


### Instance time zone

Dashboard Settings reads the instance time zone from `.env` `TZ`. Admins choose
from a region-grouped list based on `Intl.supportedValuesOf('timeZone')`, with
older ICU names mapped to their current IANA location names and duplicates
removed. UTC is included. A current value outside the list remains visible;
it is not silently changed. Choose a supported option before saving.

The writer accepts only those current IANA names or UTC, rejecting aliases,
incorrect case and numeric offsets. When system zoneinfo is installed, the name
must also match an installed TZif file with exact case; unsupported names show
a clear error and leave `.env` unchanged. Without system zoneinfo, the same
current-name list still applies. Other assignments, comments and formatting
are preserved, and `.env` stays private (0600), including unchanged saves.
Symlinked, missing or nonregular `.env` files are read-only. The setting does
not depend on whether `.zylos/config.json` is readable.

The writer shares the existing config-lock protocol for `.env` writes; it does
not lock external editors or serialize service restarts against later saves.
Saving does not restart anything. A separate confirmation offers running core
services from this instance that need a restart: scheduler,
activity-monitor and c4-dispatcher. Restarts use their existing PM2 names without `--update-env` or injecting the Dashboard environment. The dispatcher restart sets PM2’s
stop timeout to 10 seconds so in-flight verification can finish; stopping also
cancels its post-send idle pacing waits. This protects ordinary graceful
restarts, not an externally forced kill. Each service loads `.env` TZ at startup; if TZ is absent, activity-monitor and
c4-dispatcher preserve their inherited value. Other components may still need
a restart and are outside this action's service list.

Only names shown in the confirmation and still eligible are restarted.
Failed-service retries exclude successful services, and unknown process
discovery disables restart. Dashboard reads the file on each request and needs
no restart. Existing runtime sessions keep running; the new time zone applies
when they next launch. Memory log dates may cross a new day boundary after a
change.

Read-only Fleet connections can view the setting. Admin connections write and
restart through the remote instance's own endpoints. The read-only input uses
the same disabled style as the reclaim setting.

---

## Communication Channels

### Built-in
- **Dashboard conversations** — Browser-based chat, with Origin as the fixed conversation with your agent. Included with `zylos init`.

### Official Channels
Install with one command:
```bash
zylos add telegram
zylos add lark
```

### Build Your Own
All channels connect through the C4 communication bridge. To add a new channel (Slack, Discord, WhatsApp, etc.), implement the C4 protocol — a simple HTTP interface that pushes messages into the unified gateway. Your custom channel gets the same unified session, audit trail, and memory as every other channel.

---

## OpenClaw Compatibility

Zylos is fully compatible with the [OpenClaw](https://github.com/openclaw/openclaw) ecosystem. Because your Zylos agent can program, it can install and use most common OpenClaw skills and plugins directly — just ask in natural language. Most OpenClaw extensions are one conversation away. Zylos agents and OpenClaw agents communicate in real-time through the [HXA-Connect](https://github.com/coco-xyz/hxa-connect) B2B protocol — no custom bridges needed.

### Capability Mapping

| OpenClaw Capability | Zylos Equivalent | Status |
|---|---|---|
| Skills / ClawHub | Component System + [Registry](https://github.com/zylos-ai/zylos-registry) | ✅ Available |
| Multi-agent routing | [HXA-Connect](https://github.com/coco-xyz/hxa-connect) B2B Protocol | ✅ Available |
| Gateway (control plane) | C4 Comm Bridge (unified gateway, SQLite audit) | ✅ Available |
| Memory / persistence | Inside Out Memory (5-layer architecture) | ✅ Available |
| Context compression | Auto memory save + infinite context | ✅ Available |
| Browser automation | [zylos-browser](https://github.com/zylos-ai/zylos-browser) | ✅ Available |
| Cron / webhooks | Scheduler (cron, NL input, idle-gating) | ✅ Available |

> **Architecture note:** OpenClaw supports multi-session routing to isolated workspaces. Zylos takes a different approach — unified session (one AI, one consciousness across all channels). This is a deliberate design choice, not a missing feature.

### For OpenClaw Users

Connect your OpenClaw agent to Zylos agents via [openclaw-hxa-connect](https://github.com/coco-xyz/openclaw-hxa-connect):

```bash
cd ~/.openclaw/extensions
git clone https://github.com/coco-xyz/openclaw-hxa-connect.git hxa-connect
cd hxa-connect && npm install
```

Once configured, your OpenClaw agent joins the same collaboration network as Zylos agents — with full thread support, @mentions, and real-time messaging.

### For Zylos Users

Connect to OpenClaw agents by installing the HXA-Connect component:

```bash
zylos add hxa-connect
```

Your Zylos agent can then communicate with any OpenClaw agent on the same HXA-Connect hub — same unified session, same memory, same personality.

---

## CLI

```bash
zylos init                    # Set up Zylos environment
zylos attach                  # Attach to the agent tmux session
zylos runtime <name>          # Switch AI runtime (claude or codex)
zylos doctor                  # Diagnose and auto-repair installation
zylos status                  # Check running services
zylos logs [service]          # View service logs
zylos add <component>         # Install a channel or capability
zylos upgrade <component>     # Upgrade a component
zylos upgrade --self          # Upgrade zylos-core itself
zylos recovery status         # Inspect file-only self-upgrade recovery
zylos upgrade --self --beta   # Check for beta/prerelease versions
zylos uninstall --self        # Uninstall zylos entirely
zylos list                    # List installed components
zylos search [keyword]        # Search component registry
zylos upstream status --resolved # Inspect upstream configuration without networking
zylos upstream refresh       # Refresh the selected remote profile now
```

### Upstream routing

After installing Zylos through the official installation method, you can route
core's GitHub requests through your deployment's API, raw-file and download
endpoints. Caddy uses the same routes. npm settings remain deployment-owned;
LLM endpoints and the official Claude installer keep their existing behavior.

```bash
# Use the URLs supplied by your deployment administrator.
export npm_config_registry=https://registry.example.com
export npm_config_better_sqlite3_binary_host_mirror=https://binary.example.com/better-sqlite3
zylos init --upstream-config https://config.example.com/profile.json

# Or select a fixed local profile:
zylos init --upstream-config /absolute/path/profile.json
```

Editable profile template: [templates/upstreams.example.json](templates/upstreams.example.json).
It starts with the official endpoints; copy it outside the repository and edit
your private deployment copy before selecting it with `--upstream-config`:

```json
{
  "schemaVersion": 1,
  "revision": "official-1",
  "providers": {
    "github": {
      "apiBase": "https://api.github.com/",
      "rawBase": "https://raw.githubusercontent.com/",
      "downloadBase": "https://github.com/"
    }
  }
}
```

Bases may include a fixed path prefix, but must not include credentials, query
parameters or fragments. Profiles cannot supply secrets, npm settings or trust
permissions. Remote profiles require HTTPS.
There is no built-in regional preset or public proxy service. Private proxy
addresses belong in deployment-owned files or configuration services, outside
the open-source repository. A local file may be named `cn.json`; its filename
has no special meaning to core. `--upstream-config direct` explicitly selects
the official endpoints. The same option accepts a local file or HTTPS URL.
The exact value `direct` is reserved; use `./direct` for a file with that name.
Other URL schemes are rejected; ordinary paths select local files.

**Redirect ownership:** the profile replaces only the initial GitHub request
entry. Zylos follows subsequent `Location` URLs with HTTPS and token checks for
custom routes; it does not rewrite each redirect through the profile again.
The mirror service must handle the complete archive/release download chain,
including codeload and asset hosts: either follow redirects server-side and
stream the file, or return mirror URLs with explicit routes to the original
targets. Preserve target paths, query strings and signed URL semantics. A mirror
that promises full coverage must fail explicitly on unsupported targets instead
of sending clients back to an unreachable official host. Client token trust does
not control the mirror's internal credential forwarding; the service must enforce
that separately. Validate the deployed mirror with cold-cache archive and release
downloads while client access to official hosts is blocked. A successful first
request alone does not establish mirror compatibility.

Remote profile retrieval requires **curl 7.54.0 or newer** for
`--suppress-connect-headers`; check with `curl --version`. On older curl, use a
local profile via `--upstream-config` or have the deployment administrator
provide a supported curl before selecting a remote profile.

Profile retrieval uses curl, like the GitHub downloads, and inherits curl's
proxy environment (`HTTPS_PROXY`, `https_proxy`, `ALL_PROXY`, `NO_PROXY`, etc.).
Set these in the environment that launches Zylos. No `NODE_USE_ENV_PROXY`
setting is needed. JSON and schema validation remain in Node. Profiles never
receive the GitHub token, and HTTPS and redirect checks still apply at every
hop. The profile downloader disables `.curlrc` loading so local curl options
cannot inject authentication or bypass those checks. A local profile file
selected with `--upstream-config` avoids the configuration-service request.

Source selection is CLI > process environment > saved settings > direct.
The sole source environment variable is `ZYLOS_UPSTREAM_CONFIG`, accepting
the same file, HTTPS URL or `direct` values as `--upstream-config`.
An empty selected value is an error; unset the variable to use the saved/default source.
Endpoints combine official defaults with the selected profile; local settings
do not contain endpoint overrides. `direct` always uses the official endpoints,
while the local token trust policy remains independent. Unknown or removed
source inputs and invalid local settings fail explicitly; a valid CLI source
does not bypass validation of removed environment inputs.
Both CLI flags and environment source overrides apply only to the current process,
including successful init; neither changes the saved default source. To configure
later commands explicitly:

```bash
zylos upstream set ./cn.json     # validate a local profile and save its absolute path
zylos upstream set https://config.example.com/upstream.json  # save URL without fetching
zylos upstream set direct        # save an explicit official default
zylos upstream clear             # remove only the saved source
zylos upstream                   # read-only status, including source and selectedBy
```

Only `upstream set/clear` writes the saved source in
`$ZYLOS_DIR/.zylos/upstreams.json`. Set validates local profile content or HTTPS
URL syntax before writing; the next consuming command fetches a saved URL.
These configuration commands ignore `ZYLOS_UPSTREAM_CONFIG` and reject the
`--upstream-config` flag: the positional value is what gets saved.
Clear preserves trust, remote cache and user profile files, and creates no
settings file if absent. `set direct` and `clear` choose the same endpoints
without overrides, but status reports `saved` for the former and `default` for
the latter. Both are still overridden by CLI/environment selections.
For continued ENV use, the deployment must keep providing the variable.
Removing it restores the saved source or official default; response caching
never selects a source by itself. An unconfigured init creates neither an
upstream settings file nor an upstream cache.

Remote snapshots are cached separately in `.zylos/upstreams-cache.json` for
24 hours. Upstream-consuming operations refresh expired snapshots, then keep
one snapshot through the operation and rollback. Ordinary agent startup does
not refresh profiles. Failed automatic refresh warns and uses a valid cache
from the same source; first use without a valid cache fails. Explicit refresh
failure returns nonzero. `upstream status --resolved` is read-only and shows
the effective routes, cache state and token policy.

Custom hosts do not receive GitHub tokens by default. Any opt-in belongs in
the local settings' `trust` object (`forwardGitHubToken` and `allowedHosts`),
never in a remote profile; redirects are checked at each hop. A request that
starts at a custom endpoint retains this rule throughout its redirect chain,
even when redirected to an official GitHub host. For private downloads, include
each host that needs authentication in `allowedHosts` (including official
redirect destinations), and set `forwardGitHubToken: true`. Redirecting does
not grant token permission automatically. Custom GitHub routes also disable
`.curlrc` loading so its auto-follow or authentication options cannot bypass
these checks. The legacy official direct transport retains its existing behavior.

Deployments can supply that trust through the environment instead of editing
the settings file: `ZYLOS_UPSTREAM_TRUST_HOSTS` takes a comma-separated list of
exact hosts (`host[:port]`, no wildcards); listing a host is the consent, so the
variable is equivalent to `forwardGitHubToken: true` with those `allowedHosts`.
The reserved value `none` disables token forwarding to custom hosts for the
current process, shadowing any saved trust; official GitHub hosts keep their
existing authentication either way. Trust
precedence is environment > saved `trust` > default (no forwarding), selected
independently of the source. Like `ZYLOS_UPSTREAM_CONFIG`, the variable applies
only to the current process and is never written to `upstreams.json`;
`zylos upstream set/clear` keep the saved trust unchanged. An empty or invalid
value fails explicitly; unset it to fall back to the saved trust.
`zylos upstream status` reports `trustSelectedBy` (`environment`, `saved` or
`default`), and `--resolved` shows the resulting per-endpoint token policy.

```bash
export ZYLOS_UPSTREAM_CONFIG=/etc/zylos/cn.json
export ZYLOS_UPSTREAM_TRUST_HOSTS=ghmirror.example.com
zylos upstream status --resolved   # trustSelectedBy: environment
```

Persist the two npm variables, and `ZYLOS_UPSTREAM_CONFIG` and
`ZYLOS_UPSTREAM_TRUST_HOSTS` if used, in the environment that starts your
supervisor, including after a reboot. The default runtime manifest inherits all
four names.
Existing installations retain their customized `.zylos/runtime-env.manifest`:
add `inherit ZYLOS_UPSTREAM_CONFIG`, `inherit ZYLOS_UPSTREAM_TRUST_HOSTS`,
`inherit npm_config_registry` and `inherit npm_config_better_sqlite3_binary_host_mirror`
there if absent. If you
store the values in `.env` instead, add the corresponding `env NAME` directives.
A shell export alone does not update an already-running supervisor. Use the
same ordinary user and writable npm global prefix for init and upgrades;
`sudo npm` requires separate environment/permission verification.

The npm registry does not redirect git dependencies or arbitrary installer
downloads. The binary-host variable covers better-sqlite3's supported
prebuild-install path, not source-build Node headers; validate prebuilds with
empty caches and no compiler. China-network and international acceptance must
run in isolated environments. Official first install, OS setup, Claude's
official installer and LLM traffic are outside the zero-direct-request claim.

---

## Uninstall

```bash
zylos uninstall --self
```

This will stop all services, remove the `zylos` npm package, delete `~/zylos/`, and clean shell PATH entries. You'll be prompted to optionally remove PM2 and Claude CLI.

Use `--force` to skip all prompts (only performs core removal, no optional cleanup).

Node.js and nvm are not touched.

---

## Built by OpenMax

Zylos is the open-source core of [OpenMax](https://openmax.com/) — the Human × Agent Collaboration Platform.

We built Zylos because we needed it ourselves: reliable infrastructure to keep AI agents running 24/7 on real work. Every component is battle-tested in production at OpenMax, serving teams that depend on their AI employees every day.

Want a managed experience? [OpenMax](https://openmax.com/) gives you a ready-to-work AI employee — persistent memory, multi-channel communication, and skill packages — deployed in 5 minutes.

## License

[MIT](./LICENSE)

See [protected self-upgrade and recovery](docs/self-upgrade-recovery.md) for supported source versions, installation protection, retained material, recovery commands, and limits.
