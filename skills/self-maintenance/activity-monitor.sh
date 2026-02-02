#!/bin/bash
# Activity Monitor v5 - Guardian Mode with Maintenance Awareness
# Monitors Claude's activity state AND ensures Claude Code is always running
# Waits for restart/upgrade scripts to complete before starting Claude
# Run with PM2: pm2 start activity-monitor.sh --name activity-monitor

SESSION="claude-main"
STATUS_FILE="$HOME/.claude-status"
LOG_FILE="$HOME/zylos/activity-log.txt"
# Claude Code conversation directory - auto-detect based on working directory
ZYLOS_PATH=$(echo "$HOME/zylos" | sed 's/\//-/g')
CONV_DIR="$HOME/.claude/projects/$ZYLOS_PATH"
ZYLOS_DIR="$HOME/zylos"

INTERVAL=1        # Check every 1 second
IDLE_THRESHOLD=15 # seconds without activity = idle
LOG_MAX_LINES=500 # Auto-truncate log to this many lines
RESTART_DELAY=5   # seconds of continuous "not running" before restarting

# Daily truncate tracking
LAST_TRUNCATE_DAY=""
# Counter for restart delay
not_running_count=0

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Truncate log file (keep last N lines)
truncate_log() {
    if [ -f "$LOG_FILE" ]; then
        local line_count=$(wc -l < "$LOG_FILE")
        if [ "$line_count" -gt "$LOG_MAX_LINES" ]; then
            tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
            log "Log truncated to $LOG_MAX_LINES lines"
        fi
    fi
}

# Daily log truncation check
check_daily_truncate() {
    local today=$(date '+%Y-%m-%d')
    if [ "$today" != "$LAST_TRUNCATE_DAY" ]; then
        truncate_log
        LAST_TRUNCATE_DAY="$today"
    fi
}

# Check if Claude process is running in the tmux pane
is_claude_running() {
    local pane_pid=$(tmux list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)
    if [ -z "$pane_pid" ]; then
        return 1
    fi
    # Check if the pane process itself is claude (claude runs as the pane process, not child)
    local proc_name=$(ps -p "$pane_pid" -o comm= 2>/dev/null)
    if [[ "$proc_name" == "claude" ]]; then
        return 0
    fi
    # Fallback: check if claude is a child process
    if pgrep -P "$pane_pid" -f "claude" > /dev/null 2>&1; then
        return 0
    fi
    return 1
}

# Send text to tmux using paste-buffer method
send_to_tmux() {
    local text="$1"
    local msg_id="$(date +%s%N)-$$"
    local temp_file="/tmp/monitor-msg-${msg_id}.txt"
    local buffer_name="monitor-${msg_id}"

    echo -n "$text" > "$temp_file"

    if tmux load-buffer -b "$buffer_name" "$temp_file" 2>/dev/null; then
        sleep 0.1
        tmux paste-buffer -b "$buffer_name" -t "$SESSION" 2>/dev/null
        sleep 0.2
        tmux send-keys -t "$SESSION" Enter 2>/dev/null
        tmux delete-buffer -b "$buffer_name" 2>/dev/null
    fi

    rm -f "$temp_file"
}

# Check which maintenance script is running (returns script name or empty)
get_running_maintenance() {
    # Check for restart-claude.sh (match both direct execution and bash invocation)
    if pgrep -f "restart-claude\.sh" > /dev/null 2>&1; then
        echo "restart-claude.sh"
        return 0
    fi
    # Check for upgrade-claude.sh
    if pgrep -f "upgrade-claude\.sh" > /dev/null 2>&1; then
        echo "upgrade-claude.sh"
        return 0
    fi
    # Also check for curl install.sh (upgrade in progress)
    if pgrep -f "claude.ai/install.sh" > /dev/null 2>&1; then
        echo "upgrade (curl install.sh)"
        return 0
    fi
    return 1
}

# Check if any maintenance script is running
is_maintenance_running() {
    get_running_maintenance > /dev/null 2>&1
}

# Wait for maintenance scripts to complete
wait_for_maintenance() {
    local max_wait=300  # 5 minutes max
    local waited=0
    local script_name

    script_name=$(get_running_maintenance)
    if [ -z "$script_name" ]; then
        return 0
    fi

    log "Guardian: Detected $script_name running, waiting for completion..."

    while true; do
        script_name=$(get_running_maintenance)
        if [ -z "$script_name" ]; then
            break
        fi
        if [ $waited -ge $max_wait ]; then
            log "Guardian: Warning - $script_name still running after ${max_wait}s, proceeding anyway"
            break
        fi
        if [ $((waited % 30)) -eq 0 ] && [ $waited -gt 0 ]; then
            log "Guardian: Still waiting for $script_name... (${waited}s)"
        fi
        sleep 1
        waited=$((waited + 1))
    done

    if [ $waited -gt 0 ] && [ $waited -lt $max_wait ]; then
        log "Guardian: $script_name completed after ${waited}s"
    fi
}

# Start Claude Code in existing or new tmux session
start_claude() {
    # First check if maintenance scripts are running
    if is_maintenance_running; then
        log "Guardian: Maintenance script detected, waiting for completion..."
        wait_for_maintenance
    fi

    log "Guardian: Starting Claude Code..."

    # Reset context monitor cooldowns
    rm -f /tmp/context-alert-cooldown /tmp/context-compact-scheduled

    if tmux has-session -t "$SESSION" 2>/dev/null; then
        # Session exists, send command to start claude
        send_to_tmux "cd $ZYLOS_DIR; claude --dangerously-skip-permissions"
        log "Guardian: Started Claude in existing tmux session"
    else
        # Create new session
        tmux new-session -d -s "$SESSION" "cd $ZYLOS_DIR && claude --dangerously-skip-permissions"
        log "Guardian: Created new tmux session and started Claude"
    fi

    # Wait a bit then send catch-up prompt
    sleep 15

    # Check if claude started successfully
    if is_claude_running; then
        log "Guardian: Claude started successfully, sending catch-up prompt"
        sleep 5
        send_to_tmux "Session recovered by activity monitor. Do the following:

1. Read your memory files (especially ~/zylos/memory/context.md)
2. Check the conversation transcript at ~/.claude/projects/-home-howard-zylos/*.jsonl (most recent file by date) for messages AFTER the last memory sync timestamp
3. If there was conversation between last memory sync and crash, briefly summarize what was discussed (both Howard's messages and your replies)
4. Send recovery status via ~/zylos/bin/notify.sh"
    else
        log "Guardian: Warning - Claude may not have started properly"
    fi
}

log "=== Activity Monitor Started (v5 - Guardian Mode): $(date) ==="

last_state=""
startup_grace=0  # Grace period counter after starting claude

while true; do
    current_time=$(date +%s)
    current_time_human=$(date '+%Y-%m-%d %H:%M:%S')

    # Daily log truncation
    check_daily_truncate

    # Check if tmux session exists
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
        state="offline"
        not_running_count=$((not_running_count + 1))

        # Write offline status
        jq -n \
            --arg state "$state" \
            --arg since "$current_time" \
            --arg last_check "$current_time" \
            --arg last_check_human "$current_time_human" \
            --arg not_running "$not_running_count" \
            '{state: $state, since: ($since|tonumber), last_check: ($last_check|tonumber), last_check_human: $last_check_human, idle_seconds: 0, not_running_seconds: ($not_running|tonumber), message: "tmux session not found"}' \
            > "$STATUS_FILE"

        if [ "$state" != "$last_state" ]; then
            log "State: OFFLINE (tmux session not found)"
        fi

        # Guardian: Start Claude after RESTART_DELAY seconds
        if [ "$not_running_count" -ge "$RESTART_DELAY" ]; then
            log "Guardian: Session not found for ${not_running_count}s, starting Claude..."
            start_claude
            startup_grace=30  # 30 second grace period
            not_running_count=0
        fi

        last_state="$state"
        sleep $INTERVAL
        continue
    fi

    # Session exists, check if claude is running
    if ! is_claude_running; then
        # Grace period after startup
        if [ "$startup_grace" -gt 0 ]; then
            startup_grace=$((startup_grace - 1))
            sleep $INTERVAL
            continue
        fi

        state="stopped"
        not_running_count=$((not_running_count + 1))

        jq -n \
            --arg state "$state" \
            --arg since "$current_time" \
            --arg last_check "$current_time" \
            --arg last_check_human "$current_time_human" \
            --arg not_running "$not_running_count" \
            '{state: $state, since: ($since|tonumber), last_check: ($last_check|tonumber), last_check_human: $last_check_human, idle_seconds: 0, not_running_seconds: ($not_running|tonumber), message: "claude not running in tmux"}' \
            > "$STATUS_FILE"

        if [ "$state" != "$last_state" ]; then
            log "State: STOPPED (claude not running in tmux session)"
        fi

        # Guardian: Start Claude after RESTART_DELAY seconds
        if [ "$not_running_count" -ge "$RESTART_DELAY" ]; then
            log "Guardian: Claude not running for ${not_running_count}s, starting Claude..."
            start_claude
            startup_grace=30
            not_running_count=0
        fi

        last_state="$state"
        sleep $INTERVAL
        continue
    fi

    # Reset counters when claude is confirmed running
    startup_grace=0
    not_running_count=0

    # Get conversation file modification time (more reliable than tmux activity)
    CONV_FILE=$(ls -t "$CONV_DIR"/*.jsonl 2>/dev/null | grep -v agent- | head -1)

    if [ -n "$CONV_FILE" ] && [ -f "$CONV_FILE" ]; then
        activity=$(stat -c %Y "$CONV_FILE")
    else
        # Fallback to tmux activity
        activity=$(tmux list-windows -t "$SESSION" -F '#{window_activity}' 2>/dev/null)
    fi

    # Calculate idle time
    idle_seconds=$((current_time - activity))

    # Determine state
    if [ $idle_seconds -lt $IDLE_THRESHOLD ]; then
        state="busy"
    else
        state="idle"
    fi

    # Write JSON status file
    jq -n \
        --arg state "$state" \
        --arg activity "$activity" \
        --arg current "$current_time" \
        --arg last_check_human "$current_time_human" \
        --arg idle "$idle_seconds" \
        --arg source "conv_file" \
        '{state: $state, last_activity: ($activity|tonumber), last_check: ($current|tonumber), last_check_human: $last_check_human, idle_seconds: ($idle|tonumber), source: $source}' \
        > "$STATUS_FILE"

    # Only log on state change
    if [ "$state" != "$last_state" ]; then
        if [ "$state" = "busy" ]; then
            log "State: BUSY (last activity ${idle_seconds}s ago)"
        else
            log "State: IDLE (inactive for ${idle_seconds}s)"
        fi
    fi

    last_state=$state
    sleep $INTERVAL
done
