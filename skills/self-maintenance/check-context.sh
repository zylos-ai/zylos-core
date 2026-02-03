#!/bin/bash
# Check context usage by sending /context command
# Usage: nohup ~/zylos/bin/check-context.sh > /dev/null 2>&1 &
# The script waits for Claude to be idle, sends /context, then prompts for status report

TMUX_SESSION="claude-main"

# Wait for Claude to become idle
sleep 3

# Send /context (no newline)
printf "/context" > /tmp/ctx-cmd-$$.txt
tmux load-buffer -b ctx-$$ /tmp/ctx-cmd-$$.txt
tmux paste-buffer -b ctx-$$ -t "$TMUX_SESSION"
tmux delete-buffer -b ctx-$$
rm -f /tmp/ctx-cmd-$$.txt

# Wait then press Enter
sleep 2
tmux send-keys -t "$TMUX_SESSION" Enter

# Wait for output to be displayed
sleep 5

# Send follow-up to prompt Claude to report
printf "Report your current context usage based on the /context output above." > /tmp/ctx-followup-$$.txt
tmux load-buffer -b ctx-followup-$$ /tmp/ctx-followup-$$.txt
tmux paste-buffer -b ctx-followup-$$ -t "$TMUX_SESSION"
tmux delete-buffer -b ctx-followup-$$
rm -f /tmp/ctx-followup-$$.txt

sleep 0.3
tmux send-keys -t "$TMUX_SESSION" Enter

exit 0
