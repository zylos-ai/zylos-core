#!/bin/sh
set -eu

[ "$#" -eq 3 ] && [ "$1" = mcp ] && [ "$2" = list ] && [ "$3" = --json ] || exit 2
printf '%s\n' "$TEST_CODEX_MCP_LIST"
