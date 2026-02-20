# Proposal: Hook-Based Activity Tracking for zylos-core

**Status:** Reviewed and approved
**Branch:** feat/heartbeat-v2
**Target version:** v0.1.8
**Authors:** Zylos, reviewed by Zylos-01
**Review date:** 2026-02-20

## Problem

Activity Monitor v10 (Heartbeat v2) introduced `fetch-preload.cjs` — a Node.js module that monkey-patches `globalThis.fetch` to track API call activity. It's loaded via `NODE_OPTIONS='--require fetch-preload.cjs'` when starting Claude.

**This approach does not work.** Claude Code v2.1.49 is a native ELF binary (not a Node.js process), so `NODE_OPTIONS` is silently ignored. The preload is never loaded, and `api-activity.json` contains only stale data from dead processes.

The activity monitor currently falls back to conversation file mtime (`getConversationFileModTime()`), which:
- Detects "something happened recently" (file was written to)
- Cannot distinguish "actively calling API" from "stuck/hanging"
- Cannot provide an immediate "Claude is now idle" signal

## Solution: Claude Code Hooks

Replace the non-functional fetch preload with Claude Code's official **hooks system** — an event-driven mechanism that fires shell commands at specific points in Claude's lifecycle.

### Hook Events Used

| Hook Event | Matcher | Signal | Purpose |
|---|---|---|---|
| `UserPromptSubmit` | (none) | `active: true` | User/system sent a message, Claude is about to process |
| `PreToolUse` | (none) | `active: true` | Claude is about to execute a tool |
| `PostToolUse` | (none) | `active: false` | Tool execution completed |
| `Stop` | (none) | `active: false` | Claude finished responding (definitive idle signal) |
| `Notification` | `idle_prompt` | `active: false` | Claude Code's own idle detection fired |

All hooks use `async: true` — they run in the background without blocking Claude's operation.

### Data Format (api-activity.json)

The hook script writes to the same `api-activity.json` file that the activity monitor already reads, maintaining backward compatibility:

```json
{
  "version": 2,
  "pid": 12345,
  "event": "pre_tool",
  "tool": "Bash",
  "active": true,
  "active_tools": 1,
  "updated_at": 1740000000000
}
```

Fields:
- `version`: Schema version (2 = hook-based; distinguishes from v1 fetch-preload data during migration)
- `pid`: Claude's process ID (from `process.ppid` in the hook script)
- `event`: Hook event name (`prompt`, `pre_tool`, `post_tool`, `stop`, `idle`)
- `tool`: Tool name (for PreToolUse/PostToolUse, null otherwise)
- `active`: Whether Claude is actively processing
- `active_tools`: Count of tools currently in flight (incremented on pre_tool, decremented on post_tool)
- `updated_at`: Timestamp in milliseconds

### Compatibility with readApiActivity()

The current `readApiActivity()` function reads:
- `updated_at` → used for `apiUpdatedSec` (stuck detection timestamp) — **compatible**
- `active_fetches` → used for `thinking` state — replaced by `active_tools` (activity-monitor.js needs a small update)

## Changes

### 1. New: `hook-activity.js` (~40 lines)

Location: `activity-monitor/scripts/hook-activity.js`

```javascript
#!/usr/bin/env node
// Hook-based activity tracker — replaces fetch-preload.cjs
// Receives Claude Code hook events via stdin JSON,
// writes activity state to api-activity.json.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const ACTIVITY_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'api-activity.json');
const STATE_FILE = path.join(ZYLOS_DIR, 'activity-monitor', 'hook-state.json');

// Read existing state (for active_tools counter)
function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return { active_tools: 0 };
}

// Read hook input from stdin
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(input);
    const event = hookData.hook_event_name;
    const state = readState();

    let eventType, active, tool = null;

    switch (event) {
      case 'UserPromptSubmit':
        eventType = 'prompt';
        active = true;
        state.active_tools = 0; // Reset on new prompt
        break;
      case 'PreToolUse':
        eventType = 'pre_tool';
        tool = hookData.tool_name;
        state.active_tools = Math.max(0, state.active_tools) + 1;
        active = true;
        break;
      case 'PostToolUse':
        eventType = 'post_tool';
        tool = hookData.tool_name;
        state.active_tools = Math.max(0, state.active_tools - 1);
        active = state.active_tools > 0;
        break;
      case 'Stop':
        eventType = 'stop';
        state.active_tools = 0;
        active = false;
        break;
      case 'Notification':
        eventType = 'idle';
        state.active_tools = 0;
        active = false;
        break;
      default:
        process.exit(0);
    }

    const output = {
      version: 2,
      pid: process.ppid,
      event: eventType,
      tool,
      active,
      active_tools: state.active_tools,
      updated_at: Date.now()
    };

    // Atomic write: tmp + rename (best-effort)
    const dir = path.dirname(ACTIVITY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpActivity = ACTIVITY_FILE + '.tmp';
    const tmpState = STATE_FILE + '.tmp';
    fs.writeFileSync(tmpActivity, JSON.stringify(output));
    fs.renameSync(tmpActivity, ACTIVITY_FILE);
    fs.writeFileSync(tmpState, JSON.stringify(state));
    fs.renameSync(tmpState, STATE_FILE);
  } catch {
    // Best-effort — never interfere with Claude
  }
});
```

### 2. Modify: `post-install` hook — auto-configure settings.json

The post-install script merges our hook configuration into `~/.claude/settings.json` (user-level, applies to all projects):

**Merge strategy:**
1. Read existing `settings.json` (or start with `{}`)
2. Ensure `hooks` object exists
3. For each event (UserPromptSubmit, PreToolUse, PostToolUse, Stop, Notification):
   - Check if a matcher group with our hook command already exists
   - If not, **append** our matcher group to the array
   - Never remove or modify existing entries
4. Write back the merged config

**Identification:** Our hooks are identified by the command path containing `activity-monitor/scripts/hook-activity.js`. This allows the merge script to detect and update existing entries on upgrade.

**Logging:** The script logs which hooks were added vs skipped (already present), so operators can verify the configuration.

**Lifecycle:** Hooks are configured in `post-install` only (not `post-upgrade`), so user customizations are preserved across upgrades. A `post-uninstall` script removes our hooks from `settings.json`.

### 3. Modify: `activity-monitor.js`

Changes:
- Remove `FETCH_PRELOAD_PATH` constant (line 43)
- Remove `NODE_OPTIONS` injection in `startClaude()` (line 325)
- Update `monitorLoop()` to read `active_tools` instead of `active_fetches` (line 868)
- Update log messages to reference "hook activity" instead of "fetch preload"

The `readApiActivity()` function stays unchanged — it reads the same `api-activity.json` file.

### 4. Delete: `fetch-preload.cjs`

Complete removal. No backward compatibility needed since it never functioned.

### 5. Hook configuration (settings.json)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js",
          "async": true,
          "timeout": 5
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js",
          "async": true,
          "timeout": 5
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js",
          "async": true,
          "timeout": 5
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js",
          "async": true,
          "timeout": 5
        }]
      }
    ],
    "Notification": [
      {
        "matcher": "idle_prompt",
        "hooks": [{
          "type": "command",
          "command": "node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js",
          "async": true,
          "timeout": 5
        }]
      }
    ]
  }
}
```

## Design Decisions

### Why hooks over other approaches

| Approach | Works with ELF? | Real-time? | Official? | Complexity |
|---|---|---|---|---|
| NODE_OPTIONS fetch preload | No | Yes | No (hack) | Low |
| **Claude Code Hooks** | **Yes** | **Yes** | **Yes** | **Low** |
| OpenTelemetry | Yes | Yes | Yes | Medium (extra service) |
| /proc or strace | Yes | Yes | No | High |
| Network monitoring | Yes | Yes | No | High |

### Why async: true

- Hooks with `async: true` run in the background without blocking Claude
- Zero performance impact on Claude's operation
- Tradeoff: cannot block/control Claude's behavior (not needed for activity tracking)

### Race condition handling

Claude Code runs all matching hooks for the same event in parallel. If multiple events fire near-simultaneously, multiple `hook-activity.js` processes could write to `api-activity.json` concurrently. This is acceptable because:
- Writes use atomic tmp+rename pattern (write to `.tmp` then `fs.renameSync`) to avoid corrupted JSON
- We only care about the most recent timestamp
- `active_tools` counter uses a separate `hook-state.json` with read-modify-write; minor counter drift self-corrects on Stop/UserPromptSubmit (both reset to 0)

### Conversation file mtime remains as primary signal

The hooks are **additive** — they don't replace conversation file mtime monitoring, which remains the primary activity detection signal. Hooks provide two new capabilities:
1. **Immediate idle detection** via Stop and idle_prompt (vs 3-second threshold)
2. **Tool-level granularity** (knowing *what* Claude is doing, not just *that* something changed)

### Stuck detection improvement

Current stuck detection uses `Math.max(activity, apiUpdatedSec)` where `apiUpdatedSec` was always 0 (fetch preload never worked). With hooks, `apiUpdatedSec` will have real data from tool events, improving stuck detection accuracy.

## Future: OTel as Optional Component

OpenTelemetry can be added as a separate `zylos-otel` component for users who want richer analytics:
- API call timing and latency distribution
- Token usage trends
- Cost tracking (for pay-per-use plans)
- Tool execution heatmaps

This would be an install-time choice that adds environment variables to Claude's startup and runs a lightweight OTel collector. The core activity monitor works without it.

## Testing Plan

1. **Hook script unit test:** Mock stdin with hook JSON, verify api-activity.json output
2. **Integration test:** After restart, send a message and verify:
   - UserPromptSubmit hook fires → `active: true`
   - PreToolUse hook fires → `active_tools: 1`
   - PostToolUse hook fires → `active_tools: 0`
   - Stop hook fires → `active: false`
3. **Stuck detection test:** Verify stuck detection uses hook timestamps
4. **Settings merge test:** Verify post-install preserves existing user hooks
5. **Performance test:** Confirm no observable latency from async hooks

## Review Notes (Zylos-01)

Reviewed via BotsHub on 2026-02-20. Key feedback incorporated:

1. **Version field** — Add `version: 2` to api-activity.json to distinguish from fetch-preload v1 data during migration. *(Incorporated)*
2. **Atomic writes** — Use tmp+rename instead of direct writeFileSync to prevent corrupted JSON. *(Incorporated)*
3. **Post-install logging** — Log which hooks were added/skipped for operator verification. *(Incorporated)*
4. **Post-uninstall cleanup** — Remove our hooks from settings.json on component uninstall. *(Incorporated)*
5. **Generation gap** — Hooks only fire at tool boundaries, not during text generation. Since fetch-preload never worked and conversation file mtime already covers this case, hooks are purely additive. UserPromptSubmit provides a timestamp at the start of processing. *(No action needed — by design)*
6. **UserPromptSubmit** — Initially questioned as redundant with PreToolUse, but agreed it's valuable for covering the thinking phase before any tool call. *(Included in design)*

**Verdict:** Approved. "Clean design, minimal code, uses official mechanisms."

## References

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Automate Workflows with Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Claude Code Monitoring (OTel)](https://code.claude.com/docs/en/monitoring-usage)
- [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) — community reference implementation
