# Restart Skill

Restart Claude Code session without upgrading - useful for reloading hooks/config changes.

## When to Use

- After changing Claude Code settings, hooks, or keybindings
- When Claude needs to reload configuration
- To clear temporary state without upgrading
- User explicitly asks to restart

## Usage

```bash
nohup node ~/.claude/skills/restart/restart.js > /dev/null 2>&1 &
```

Optional: Specify notification channel
```bash
nohup node ~/.claude/skills/restart/restart.js lark:oc_xxx > /dev/null 2>&1 &
nohup node ~/.claude/skills/restart/restart.js telegram > /dev/null 2>&1 &
```

## Process

1. Wait for Claude to be at prompt (idle >= 5s)
2. Send `/exit` command via tmux
3. Wait for Claude process to exit
4. Reset context monitor cooldowns
5. Restart Claude in tmux with same working directory
6. Wait for Claude to be ready
7. Send catch-up message via C4 (priority=1, no-reply)

## Important Notes

- Runs detached (nohup) to survive the restart
- Uses C4 Communication Bridge for catch-up message
- Resets context monitor cooldowns to avoid stale alerts
- Logs all steps to ~/zylos/upgrade-log.txt
- Does NOT upgrade Claude Code version
