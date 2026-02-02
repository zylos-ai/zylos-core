#!/bin/bash
# C4 Communication Bridge - Receive Interface
# Receives messages from external channels and forwards to Claude
#
# Usage: c4-receive.sh --source <source> --endpoint <endpoint_id> --content "<message>"
# Example: c4-receive.sh --source telegram --endpoint 8101553026 --content "[TG DM] howardzhou said: hello"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_SESSION="claude"
BUFFER_NAME="c4-msg-$$"

# Parse arguments
SOURCE=""
ENDPOINT=""
CONTENT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --source)
            SOURCE="$2"
            shift 2
            ;;
        --endpoint)
            ENDPOINT="$2"
            shift 2
            ;;
        --content)
            CONTENT="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate required arguments
if [ -z "$SOURCE" ]; then
    echo "Error: --source is required"
    exit 1
fi

if [ -z "$CONTENT" ]; then
    echo "Error: --content is required"
    exit 1
fi

# Record to database (direction=in)
ENDPOINT_ARG="${ENDPOINT:-null}"
node "$SCRIPT_DIR/c4-db.js" insert in "$SOURCE" "$ENDPOINT_ARG" "$CONTENT" > /dev/null 2>&1

# Assemble message with reply via
if [ -n "$ENDPOINT" ]; then
    REPLY_VIA="reply via: $SCRIPT_DIR/c4-send.sh $SOURCE $ENDPOINT"
else
    REPLY_VIA="reply via: $SCRIPT_DIR/c4-send.sh $SOURCE"
fi

FULL_MESSAGE="$CONTENT ---- $REPLY_VIA"

# Send to Claude via tmux paste-buffer
# Use unique buffer name to avoid race conditions
tmux set-buffer -b "$BUFFER_NAME" "$FULL_MESSAGE"
tmux paste-buffer -b "$BUFFER_NAME" -t "$TMUX_SESSION"
tmux send-keys -t "$TMUX_SESSION" Enter
tmux delete-buffer -b "$BUFFER_NAME"

echo "[C4] Message received and forwarded to Claude"
