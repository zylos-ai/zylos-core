#!/bin/bash
# Claude Code Self-Upgrade Script
# This script is triggered by Claude, runs detached, and survives the session exit
# Usage: upgrade-claude.sh [channel]
#   channel: Optional notification channel (e.g., "lark:oc_xxx" or "telegram")
#            If provided, upgrade confirmation will be sent there
#            If not provided, falls back to notify.sh (sends to primary_dm)

# Auto-detect zylos directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZYLOS_DIR="$SCRIPT_DIR"

LOG_FILE="$ZYLOS_DIR/upgrade-log.txt"
TMUX_SESSION="claude-main"
NOTIFY_CHANNEL="$1"  # Optional: channel to send upgrade notification

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Check if Claude is at the prompt (ready for commands)
# Returns 0 if idle (no output for 5+ seconds), 1 otherwise (busy)
is_at_prompt() {
    local activity_ts now idle_seconds

    # Get last activity timestamp from tmux
    activity_ts=$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_activity}' 2>/dev/null | head -1)

    if [ -z "$activity_ts" ]; then
        return 1  # Session not found
    fi

    now=$(date +%s)
    idle_seconds=$((now - activity_ts))

    # If no output for 5+ seconds, Claude is idle and ready
    if [ "$idle_seconds" -ge 5 ]; then
        return 0  # Idle, ready for commands
    fi

    return 1  # Recent activity, still busy
}

# Send text to tmux using paste-buffer method (more reliable than send-keys)
# Uses unique buffer names to prevent race conditions
send_to_tmux() {
    local text="$1"
    local msg_id="$(date +%s%N)-$$"
    local temp_file="/tmp/upgrade-msg-${msg_id}.txt"
    local buffer_name="upgrade-${msg_id}"

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

log "=== Claude Code Upgrade Started ==="

if [ -n "$NOTIFY_CHANNEL" ]; then
    log "Notification channel: $NOTIFY_CHANNEL"
else
    log "No channel provided, will use notify.sh"
fi

# Wait for Claude to be at the prompt before sending /exit
log "Waiting for Claude to be at prompt..."
sleep 2  # Small delay to ensure script is fully detached

MAX_PROMPT_WAIT=120  # Max 2 minutes waiting for prompt
PROMPT_WAITED=0

while [ $PROMPT_WAITED -lt $MAX_PROMPT_WAIT ]; do
    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        log "Tmux session not found"
        break
    fi

    if is_at_prompt; then
        log "Claude is at prompt, sending /exit..."
        send_to_tmux "/exit"
        log "Sent /exit command"
        break
    fi

    log "Not at prompt yet, waiting... ($PROMPT_WAITED sec)"
    sleep 5
    PROMPT_WAITED=$((PROMPT_WAITED + 5))
done

if [ $PROMPT_WAITED -ge $MAX_PROMPT_WAIT ]; then
    log "Warning: Timeout waiting for prompt, trying /exit anyway..."
    send_to_tmux "/exit"
fi

log "Waiting for Claude session to exit..."

# Wait for the Claude process in tmux to exit (check every 2 seconds, max 60 seconds)
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
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
    WAITED=$((WAITED + 2))
done

if [ $WAITED -ge $MAX_WAIT ]; then
    log "Warning: Timeout waiting for Claude to exit, proceeding anyway..."
fi

# Small delay to ensure clean exit
sleep 3

log "Starting upgrade..."

# Run the upgrade
cd "$HOME"
if curl -fsSL https://claude.ai/install.sh | bash 2>&1 | tee -a "$LOG_FILE"; then
    log "Upgrade completed successfully"
else
    log "ERROR: Upgrade failed!"
    exit 1
fi

# Check new version
NEW_VERSION=$("$HOME/.local/bin/claude" --version 2>/dev/null || echo "unknown")
log "New version: $NEW_VERSION"

# Reset context monitor cooldowns (fresh session = fresh context)
log "Resetting context monitor cooldowns..."
rm -f /tmp/context-alert-cooldown /tmp/context-compact-scheduled
log "Context monitor reset complete"

# Restart Claude in tmux
log "Restarting Claude in tmux session: $TMUX_SESSION"
sleep 2

# Check if tmux session exists
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    # Send the claude command to the existing session
    send_to_tmux "cd $ZYLOS_DIR; claude --dangerously-skip-permissions"
    log "Claude restarted in existing tmux session"
else
    # Create new session and start claude
    tmux new-session -d -s "$TMUX_SESSION" "cd $ZYLOS_DIR && claude --dangerously-skip-permissions"
    log "Created new tmux session and started Claude"
fi

# Wait for Claude to be ready and send catch-up prompt
log "Waiting for Claude to be ready..."
sleep 10  # Initial wait for Claude to start

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

CATCHUP_WAIT=0
MAX_CATCHUP_WAIT=120  # Max 2 minutes

while [ $CATCHUP_WAIT -lt $MAX_CATCHUP_WAIT ]; do
    if is_at_prompt; then
        log "Claude is ready, sending catch-up prompt..."
        if [ -n "$NOTIFY_CHANNEL" ]; then
            # Channel provided - convert to explicit command
            SEND_CMD=$(get_send_command "$NOTIFY_CHANNEL")
            send_to_tmux "Upgrade complete. Read your memory files, check ~/zylos/upgrade-log.txt for the new version. Send confirmation via $SEND_CMD"
        else
            # No channel - use notify.sh
            send_to_tmux "Upgrade complete. Read your memory files, check ~/zylos/upgrade-log.txt for the new version. Send confirmation via ~/zylos/bin/notify.sh."
        fi
        log "Sent catch-up prompt"
        break
    fi

    log "Claude not ready yet, waiting... ($CATCHUP_WAIT sec)"
    sleep 5
    CATCHUP_WAIT=$((CATCHUP_WAIT + 5))
done

if [ $CATCHUP_WAIT -ge $MAX_CATCHUP_WAIT ]; then
    log "Warning: Timeout waiting for Claude to be ready"
    # Try to notify via notify.sh as fallback
    if [ -x "$ZYLOS_DIR/bin/notify.sh" ]; then
        log "Attempting to notify via notify.sh..."
        "$ZYLOS_DIR/bin/notify.sh" "Upgrade script completed but Claude may not have started properly. Check tmux session."
    fi
fi

log "=== Upgrade Complete ==="
