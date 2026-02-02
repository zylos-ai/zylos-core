#!/bin/bash
# Lark Channel - Send Interface
# Wrapper for existing lark-agent send-reply.sh
#
# Usage: send.sh <endpoint_id> "<message>"
# Example: send.sh oc_xxx "Hello!"

LARK_AGENT_DIR="$HOME/zylos/lark-agent"

if [ $# -lt 2 ]; then
    echo "Usage: send.sh <endpoint_id> \"<message>\""
    exit 1
fi

ENDPOINT_ID="$1"
MESSAGE="$2"

# Call existing lark-agent send-reply.sh with chat_id
"$LARK_AGENT_DIR/send-reply.sh" "$ENDPOINT_ID" "$MESSAGE"
