# Channel Interface Specification

Channels are external communication components that integrate with Zylos Core via the C4 Communication Bridge.

## Directory Convention

```
~/zylos/channels/
├── telegram/
│   └── send.sh
├── lark/
│   └── send.sh
└── <your-channel>/
    └── send.sh
```

## send.sh Interface

Each channel must provide a `send.sh` script with the following interface:

```bash
./send.sh <endpoint_id> <message>
```

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| endpoint_id | Target identifier (chat_id, user_id, etc.) | `8101553026` |
| message | Message content to send | `"Hello!"` |

### Return Value

- `0` - Success
- Non-zero - Failure

### Example Implementation

```bash
#!/bin/bash
# telegram/send.sh

ENDPOINT_ID="$1"
MESSAGE="$2"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$ENDPOINT_ID" \
    -d text="$MESSAGE" \
    > /dev/null

exit $?
```

## Integration with C4

Channels are invoked by `c4-send.sh`:

```bash
# C4 calls the appropriate channel
~/zylos/channels/${SOURCE}/send.sh "${ENDPOINT_ID}" "${MESSAGE}"
```

## Creating a New Channel

1. Create directory: `~/zylos/channels/<channel-name>/`
2. Implement `send.sh` following the interface above
3. Ensure the script is executable: `chmod +x send.sh`
4. Messages will automatically route through C4
