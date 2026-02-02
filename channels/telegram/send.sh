#!/bin/bash
# Telegram Channel - Send Interface
# Wrapper for existing telegram-bot send-reply.sh
#
# Usage: send.sh <endpoint_id> "<message>"
# Example: send.sh 8101553026 "Hello!"

TELEGRAM_BOT_DIR="$HOME/zylos/telegram-bot"

if [ $# -lt 2 ]; then
    echo "Usage: send.sh <endpoint_id> \"<message>\""
    exit 1
fi

ENDPOINT_ID="$1"
MESSAGE="$2"

# Call existing telegram-bot send-reply.sh with chat_id
"$TELEGRAM_BOT_DIR/send-reply.sh" "$ENDPOINT_ID" "$MESSAGE"
