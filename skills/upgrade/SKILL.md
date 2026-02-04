# Upgrade Skill

Upgrade Claude Code to the latest version and restart the session.

## When to Use

- When a new Claude Code version is available
- User explicitly asks to upgrade
- Scheduled upgrade tasks
- After announcements of important updates

## Usage

```bash
nohup node ~/.claude/skills/upgrade/upgrade.js > /dev/null 2>&1 &
```

Optional: Specify notification channel
```bash
nohup node ~/.claude/skills/upgrade/upgrade.js lark:oc_xxx > /dev/null 2>&1 &
nohup node ~/.claude/skills/upgrade/upgrade.js telegram > /dev/null 2>&1 &
```

## Process

1. Wait for Claude to be at prompt (idle >= 5s)
2. Send `/exit` command via tmux
3. Wait for Claude process to exit
4. Run upgrade: `curl -fsSL https://claude.ai/install.sh | bash`
5. Check new version
6. Reset context monitor cooldowns
7. Restart Claude in tmux
8. Wait for Claude to be ready
9. Send catch-up message via C4 (priority=1, no-reply)

## Important Notes

- Runs detached (nohup) to survive the upgrade process
- Uses C4 Communication Bridge for catch-up message
- Resets context monitor cooldowns to avoid stale alerts
- Logs all steps to ~/zylos/upgrade-log.txt
- Upgrade fetches latest version from claude.ai
- Includes extensive timeout handling for reliability

## Log File

Check upgrade progress and results:
```bash
tail -f ~/zylos/upgrade-log.txt
```
