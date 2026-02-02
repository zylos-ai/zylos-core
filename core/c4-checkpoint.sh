#!/bin/bash
# C4 Communication Bridge - Checkpoint Interface
# Creates a checkpoint to mark sync points
#
# Usage: c4-checkpoint.sh [--type <type>]
# Types: memory_sync, session_start, manual (default: manual)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse arguments
TYPE="manual"

while [[ $# -gt 0 ]]; do
    case $1 in
        --type)
            TYPE="$2"
            shift 2
            ;;
        *)
            # Allow type as positional argument
            TYPE="$1"
            shift
            ;;
    esac
done

# Validate type
case "$TYPE" in
    memory_sync|session_start|manual)
        ;;
    *)
        echo "Error: Invalid type '$TYPE'. Must be: memory_sync, session_start, or manual"
        exit 1
        ;;
esac

# Create checkpoint
RESULT=$(node "$SCRIPT_DIR/c4-db.js" checkpoint "$TYPE")
echo "$RESULT"
