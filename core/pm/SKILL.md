---
name: pm
version: 0.2.0
description: Component management via IM (Telegram/Lark)
type: core
---

# Component Management via IM

Handle component management requests from Telegram/Lark users by calling zylos CLI commands.

## When to Use

When user sends component management requests via IM:

- "list" / "列表" / "list components"
- "info telegram"
- "check" / "检查更新" / "check updates"
- "check telegram"
- "upgrade telegram" / "升级 telegram"
- "upgrade telegram confirm"
- "add <name>"

## Command Mapping

| User intent | CLI command | Output handling |
|-------------|------------|-----------------|
| List components | `zylos list` | Send stdout directly |
| Component info | `zylos info <name> --json` | Format JSON as plain text |
| Check all updates | `zylos upgrade --all --check --json` | Format JSON as plain text |
| Check specific | `zylos upgrade <name> --check --json` | Format JSON as plain text |
| Preview upgrade | `zylos upgrade <name> --check --json` | Format + append confirm prompt |
| Execute upgrade | `zylos upgrade <name> --yes --skip-eval` | Send stdout directly |
| Add component | `zylos add <name> --yes` | Send stdout directly |
| Remove | Reject | Reply: "Remove is not supported via IM. Use CLI directly." |

## Upgrade Confirm Flow

This is the most important pattern. Upgrades use two-step confirmation (no state needed):

**Step 1 — User requests upgrade:**
```
User: upgrade telegram
```

Run: `zylos upgrade telegram --check --json`

Format the JSON result as plain text and append the confirm prompt:
```
telegram: 0.1.0 -> 0.2.0

Changelog:
- Fixed dotenv path issue

Reply "upgrade telegram confirm" to proceed.
```

**Step 2 — User confirms:**
```
User: upgrade telegram confirm
```

Run: `zylos upgrade telegram --yes --skip-eval`

Send the output:
```
Upgrading telegram...
  [1/8] pre-upgrade hook (skipped)
  [2/8] stop service ✓
  ...
✓ telegram upgraded: 0.1.0 → 0.2.0
```

Key: The confirm command is **self-contained**. It doesn't depend on Claude remembering the previous message. The component name is in the command itself.

## Output Formatting Rules

When formatting --json output for IM:

1. Use plain text only (no markdown formatting)
2. Keep it concise — IM messages should be short
3. For info command, format as:
   ```
   <name> v<version>
   Type: <type>
   Repo: <repo>
   Service: <service_name> (<status>)
   ```
4. For check command, format as:
   ```
   <name>: <current> -> <latest>
   ```
   Or: `<name> is up to date (v<current>)`
5. For errors, use: `Error: <human-readable message>`

## JSON Response Shapes

### upgrade --check --json (has update)
```json
{
  "action": "check",
  "component": "telegram",
  "current": "0.1.0",
  "latest": "0.2.0",
  "hasUpdate": true,
  "success": true
}
```

### upgrade --check --json (up to date)
```json
{
  "action": "check",
  "component": "telegram",
  "current": "0.2.0",
  "hasUpdate": false,
  "success": true
}
```

### upgrade --all --check --json
```json
{
  "action": "check_all",
  "total": 2,
  "updatable": 1,
  "components": [
    { "component": "telegram", "current": "0.1.0", "latest": "0.2.0", "hasUpdate": true, "success": true },
    { "component": "lark", "current": "0.1.0", "hasUpdate": false, "success": true }
  ]
}
```

### info --json
```json
{
  "name": "telegram",
  "version": "0.2.0",
  "description": "Telegram Bot communication channel",
  "type": "communication",
  "repo": "zylos-ai/zylos-telegram",
  "service": { "name": "zylos-telegram", "status": "online" },
  "installedAt": "2026-02-04T10:30:00Z",
  "upgradedAt": "2026-02-05T14:00:00Z"
}
```

### error (component not found)
```json
{
  "error": "component_not_registered",
  "message": "Component 'xxx' is not registered in components.json"
}
```

When there's both `error` and `message` fields, always display `message` (human-readable).
