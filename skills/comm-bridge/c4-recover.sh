#!/bin/bash
# C4 Communication Bridge - Recovery Interface
# Retrieves conversations since last checkpoint for session recovery
#
# Usage: c4-recover.sh
# Output: Formatted text for Claude context injection

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Get conversations since last checkpoint
node "$SCRIPT_DIR/c4-db.js" recover
