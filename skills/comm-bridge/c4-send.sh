#!/bin/bash
# C4 Communication Bridge - Send Interface
# Sends messages from Claude to external channels
#
# Usage: c4-send.sh <source> [endpoint_id] "<message>"
# Example: c4-send.sh telegram 8101553026 "Hello Howard!"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$HOME/.claude/skills"

# Parse arguments
if [ $# -lt 2 ]; then
    echo "Usage: c4-send.sh <source> [endpoint_id] \"<message>\""
    echo "Example: c4-send.sh telegram 8101553026 \"Hello!\""
    exit 1
fi

SOURCE="$1"
shift

# Check if next arg looks like an endpoint_id or is the message
if [ $# -eq 1 ]; then
    # Only message provided, no endpoint
    ENDPOINT=""
    MESSAGE="$1"
elif [ $# -ge 2 ]; then
    ENDPOINT="$1"
    shift
    MESSAGE="$1"
else
    echo "Error: Message is required"
    exit 1
fi

# Record to database (direction=out)
ENDPOINT_ARG="${ENDPOINT:-null}"
node "$SCRIPT_DIR/c4-db.js" insert out "$SOURCE" "$ENDPOINT_ARG" "$MESSAGE" > /dev/null 2>&1

# Find and call channel send script (channels are skills in ~/.claude/skills/)
CHANNEL_SCRIPT="$SKILLS_DIR/$SOURCE/send.sh"

if [ ! -x "$CHANNEL_SCRIPT" ]; then
    echo "Error: Channel script not found or not executable: $CHANNEL_SCRIPT"
    exit 1
fi

# Call channel script
if [ -n "$ENDPOINT" ]; then
    "$CHANNEL_SCRIPT" "$ENDPOINT" "$MESSAGE"
else
    "$CHANNEL_SCRIPT" "$MESSAGE"
fi

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
    echo "[C4] Message sent via $SOURCE"
else
    echo "[C4] Failed to send message via $SOURCE (exit code: $EXIT_CODE)"
fi

exit $EXIT_CODE
