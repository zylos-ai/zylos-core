#!/bin/bash
# Claude Code Simple Restart Script
# Restarts Claude without upgrading - useful for reloading hooks/config
# Usage: restart-claude.sh [channel]
#   channel: Optional notification channel (e.g., "lark:oc_xxx" or "telegram")
#            If provided, restart confirmation will be sent there
#            If not provided, falls back to notify.sh (sends to primary_dm)

# Auto-detect zylos directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZYLOS_DIR="$SCRIPT_DIR"

LOG_FILE="$ZYLOS_DIR/upgrade-log.txt"
TMUX_SESSION="claude-main"
NOTIFY_CHANNEL="$1"  # Optional: channel to send restart notification

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Send text to tmux using paste-buffer method (more reliable than send-keys)
# Uses unique buffer names to prevent race conditions
send_to_tmux() {
    local text="$1"
    local msg_id="$(date +%s%N)-$$"
    local temp_file="/tmp/restart-msg-${msg_id}.txt"
    local buffer_name="restart-${msg_id}"

    echo -n "$text" > "$temp_file"

    # Load into tmux buffer, paste, then send Enter
    if tmux load-buffer -b "$buffer_name" "$temp_file" 2>/dev/null; then
        sleep 0.1
        tmux paste-buffer -b "$buffer_name" -t "$TMUX_SESSION" 2>/dev/null
        sleep 0.2
        tmux send-keys -t "$TMUX_SESSION" Enter 2>/dev/null
        # Clean up buffer
        tmux delete-buffer -b "$buffer_name" 2>/dev/null
    fi

    rm -f "$temp_file"
}

# Check if Claude is at the prompt
is_at_prompt() {
    local activity_ts now idle_seconds
    activity_ts=$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_activity}' 2>/dev/null | head -1)
    if [ -z "$activity_ts" ]; then
        return 1
    fi
    now=$(date +%s)
    idle_seconds=$((now - activity_ts))
    [ "$idle_seconds" -ge 5 ]
}

log "=== Claude Code Restart Started ==="

if [ -n "$NOTIFY_CHANNEL" ]; then
    log "Notification channel: $NOTIFY_CHANNEL"
else
    log "No channel provided, will use notify.sh"
fi

# Wait for Claude to be at prompt
log "Waiting for Claude to be at prompt..."
sleep 2

MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log "Tmux session not found"
        break
    fi
    if is_at_prompt; then
        log "Claude is at prompt, sending /exit..."
        send_to_tmux "/exit"
        break
    fi
    sleep 3
    WAITED=$((WAITED + 3))
done

# Wait for the Claude process to actually exit
log "Waiting for Claude to exit..."

MAX_EXIT_WAIT=60
EXIT_WAITED=0
while [ $EXIT_WAITED -lt $MAX_EXIT_WAIT ]; do
    # Check if claude process is still running in the tmux pane
    PANE_PID=$(tmux list-panes -t "$TMUX_SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)
    if [ -z "$PANE_PID" ]; then
        log "Tmux session not found, proceeding..."
        break
    fi

    # Check if claude is running as child of the pane
    if ! pgrep -P "$PANE_PID" -f "claude" > /dev/null 2>&1; then
        log "Claude process has exited"
        break
    fi

    sleep 2
    EXIT_WAITED=$((EXIT_WAITED + 2))
done

if [ $EXIT_WAITED -ge $MAX_EXIT_WAIT ]; then
    log "Warning: Timeout waiting for Claude to exit, proceeding anyway..."
fi

# Small delay to ensure clean exit
sleep 3

# Reset context monitor cooldowns
log "Resetting context monitor cooldowns..."
rm -f /tmp/context-alert-cooldown /tmp/context-compact-scheduled

# Restart Claude
log "Restarting Claude..."
sleep 2

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    send_to_tmux "cd $ZYLOS_DIR; claude --dangerously-skip-permissions"
    log "Claude restarted"
else
    tmux new-session -d -s "$TMUX_SESSION" "cd $ZYLOS_DIR && claude --dangerously-skip-permissions"
    log "Created new tmux session"
fi

# Send catch-up prompt
log "Waiting for Claude to be ready..."
sleep 10

# Convert channel format to command
# lark:oc_xxx -> ~/zylos/lark-agent/send-reply.sh "oc_xxx"
# telegram -> ~/zylos/telegram-bot/send-reply.sh
# telegram:chat_id -> ~/zylos/telegram-bot/send-reply.sh chat_id
get_send_command() {
    local channel="$1"
    if [[ "$channel" == lark:* ]]; then
        local chat_id="${channel#lark:}"
        echo "~/zylos/lark-agent/send-reply.sh \"$chat_id\""
    elif [[ "$channel" == telegram:* ]]; then
        local chat_id="${channel#telegram:}"
        echo "~/zylos/telegram-bot/send-reply.sh $chat_id"
    elif [[ "$channel" == "telegram" ]]; then
        echo "~/zylos/telegram-bot/send-reply.sh"
    else
        echo "~/zylos/bin/notify.sh"
    fi
}

WAITED=0
while [ $WAITED -lt 60 ]; do
    if is_at_prompt; then
        log "Sending catch-up prompt..."
        if [ -n "$NOTIFY_CHANNEL" ]; then
            # Channel provided - convert to explicit command
            SEND_CMD=$(get_send_command "$NOTIFY_CHANNEL")
            send_to_tmux "Restart complete. Read your memory files. Send confirmation via $SEND_CMD"
        else
            # No channel - use notify.sh
            send_to_tmux "Restart complete. Read your memory files. Send confirmation via ~/zylos/bin/notify.sh."
        fi
        break
    fi
    sleep 5
    WAITED=$((WAITED + 5))
done

log "=== Restart Complete ==="
