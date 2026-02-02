#!/bin/bash

# Unified notification script
# Sends message to primary_dm on both Telegram and Lark (if configured)
# Usage: notify.sh "Your message here"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZYLOS_DIR="$(dirname "$SCRIPT_DIR")"

MESSAGE="$1"

if [ -z "$MESSAGE" ]; then
    echo "Usage: notify.sh \"message\""
    exit 1
fi

SENT_COUNT=0

# 1. Send to Telegram primary_dm
TG_CONFIG="$ZYLOS_DIR/telegram-bot/config.json"
if [ -f "$TG_CONFIG" ]; then
    TG_PRIMARY=$(cat "$TG_CONFIG" | grep -o '"primary_dm"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*')
    if [ -n "$TG_PRIMARY" ] && [ "$TG_PRIMARY" != "null" ]; then
        if [ -x "$ZYLOS_DIR/telegram-bot/send-reply.sh" ]; then
            "$ZYLOS_DIR/telegram-bot/send-reply.sh" "$MESSAGE" 2>/dev/null && \
                echo "[notify] Sent to Telegram" && SENT_COUNT=$((SENT_COUNT + 1)) || \
                echo "[notify] Failed to send to Telegram"
        fi
    fi
fi

# 2. Send to Lark primary_dm
LARK_CONFIG="$ZYLOS_DIR/lark-agent/bot-config.json"
if [ -f "$LARK_CONFIG" ]; then
    LARK_PRIMARY=$(cat "$LARK_CONFIG" | grep -o '"primary_dm"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"')
    if [ -n "$LARK_PRIMARY" ] && [ "$LARK_PRIMARY" != "null" ]; then
        if [ -x "$ZYLOS_DIR/lark-agent/send-reply.sh" ]; then
            "$ZYLOS_DIR/lark-agent/send-reply.sh" "$LARK_PRIMARY" "$MESSAGE" 2>/dev/null && \
                echo "[notify] Sent to Lark ($LARK_PRIMARY)" && SENT_COUNT=$((SENT_COUNT + 1)) || \
                echo "[notify] Failed to send to Lark"
        fi
    fi
fi

# Check if any messages were sent
if [ $SENT_COUNT -eq 0 ]; then
    echo "[notify] Warning: No channels available for notification"
    exit 1
fi

echo "[notify] Done. Sent to $SENT_COUNT channel(s)"
