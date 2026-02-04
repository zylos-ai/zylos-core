# Restart Claude Code Skill

Simple restart of Claude Code session - sends /exit and lets activity-monitor daemon handle the restart.

## When to Use

- After changing Claude Code settings, hooks, or keybindings
- When Claude needs to reload configuration
- To clear temporary state without upgrading
- User explicitly asks to restart

## How It Works

1. Wait for Claude to be idle (idle_seconds >= 3)
2. Send `/exit` command via C4 (priority=1, no-reply)
3. Reset context monitor cooldowns
4. Done - activity-monitor daemon will restart Claude automatically

## Usage

```bash
nohup node ~/.claude/skills/restart-claude-code/restart.js > /dev/null 2>&1 &
```

## Important Notes

- **Simple approach**: Just sends /exit, activity-monitor handles the restart
- Uses C4 Communication Bridge with --no-reply flag
- Waits for idle state before sending /exit
- Resets context monitor cooldowns to avoid stale alerts
- Logs all steps to ~/zylos/upgrade-log.txt
- Does NOT manually restart Claude - relies on activity-monitor daemon
- Does NOT upgrade Claude Code version

## Activity Monitor Integration

The activity-monitor daemon watches for Claude process exit and automatically restarts it. This restart skill leverages that mechanism instead of manually restarting Claude.

## Log File

Check restart progress:
```bash
tail -f ~/zylos/upgrade-log.txt
```
