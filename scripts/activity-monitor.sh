#!/bin/bash
# Activity Monitor - monitors Claude's activity state
# Uses conversation file timestamp for more accurate idle detection
# (tmux window_activity is unreliable due to status bar updates)
# Run with PM2: pm2 start activity-monitor.sh --name activity-monitor

SESSION="claude-main"
STATUS_FILE="$HOME/.claude-status"
LOG_FILE="$HOME/zylos/activity-log.txt"
# Claude Code conversation directory - auto-detect based on working directory
# Format: ~/.claude/projects/-{path-with-dashes}
ZYLOS_PATH=$(echo "$HOME/zylos" | sed 's/\//-/g')
CONV_DIR="$HOME/.claude/projects/$ZYLOS_PATH"
INTERVAL=1        # Check every 1 second for responsiveness
IDLE_THRESHOLD=15 # seconds without activity = idle
LOG_MAX_LINES=500 # Auto-truncate log to this many lines
LOG_CHECK_INTERVAL=60  # Check log size every N iterations

echo "=== Activity Monitor Started (v3 - 1s interval): $(date) ===" >> "$LOG_FILE"

last_activity=0
iteration=0

# Function to truncate log file
truncate_log() {
    if [ -f "$LOG_FILE" ]; then
        local line_count=$(wc -l < "$LOG_FILE")
        if [ "$line_count" -gt "$LOG_MAX_LINES" ]; then
            tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
        fi
    fi
}

last_state=""

while true; do
    current_time=$(date +%s)
    current_time_human=$(date '+%Y-%m-%d %H:%M:%S')
    iteration=$((iteration + 1))

    # Periodic log truncation
    if [ $((iteration % LOG_CHECK_INTERVAL)) -eq 0 ]; then
        truncate_log
    fi

    # Check if tmux session exists
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
        state="offline"
        idle_seconds=0
        jq -n \
            --arg state "$state" \
            --arg since "$current_time" \
            --arg last_check "$current_time" \
            --arg last_check_human "$current_time_human" \
            '{state: $state, since: ($since|tonumber), last_check: ($last_check|tonumber), last_check_human: $last_check_human, idle_seconds: 0, message: "tmux session not found"}' \
            > "$STATUS_FILE"
        # Only log state changes to reduce log volume
        if [ "$state" != "$last_state" ]; then
            echo "[$current_time_human] State: OFFLINE (session not found)" >> "$LOG_FILE"
        fi
    else
        # Get conversation file modification time (more reliable than tmux activity)
        CONV_FILE=$(ls -t "$CONV_DIR"/*.jsonl 2>/dev/null | grep -v agent- | head -1)

        if [ -n "$CONV_FILE" ] && [ -f "$CONV_FILE" ]; then
            # Use conversation file timestamp
            activity=$(stat -c %Y "$CONV_FILE")
        else
            # Fallback to tmux activity if no conversation file
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

        # Only log on state change or new activity (reduce log volume)
        if [ "$state" != "$last_state" ]; then
            echo "[$current_time_human] State: $state (idle ${idle_seconds}s)" >> "$LOG_FILE"
        elif [ "$activity" != "$last_activity" ]; then
            echo "[$current_time_human] New activity detected" >> "$LOG_FILE"
        fi

        last_activity=$activity
    fi

    last_state=$state
    sleep $INTERVAL
done
